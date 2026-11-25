/// <reference types="mocha" />
// Facts, measured once (itest/suite/facts.ts): how VS Code times its events about a note, so that
// the simulation's stand-ins for VS Code's document and disk (test/sync/fakes) can be set beside
// it. Eight trials: a first edit to a clean note, a reload, Revert File and undo, a save, another
// program's write around a save, the time from did-save to Tandem Markdown's read of the save's
// text, a git checkout, and a close. Each case runs RUNS times with the extension host idle, then
// kept busy (keepBusy, timingsLoad.ts); each trial writes one JSON file of every run's timeline to
// <TM_ITEST_DIR>/timings/<version>-<time>/ and prints a summary. Nothing VS Code does is asserted.
// Run it with `npm run itest -- factsTimings`. It reads Tandem Markdown's log through the test
// hook's logLines and never clears the hook's records, so other files may run beside it.

import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { timestamp } from '../../src/host/model/timestamp';
import { factsSuite, saveSettings } from './facts';
import {
  api,
  closeEverything,
  git,
  holdsWithin,
  lf,
  note,
  openRich,
  openText,
  pause,
  readText,
  setSetting,
  tabsFor,
  type TandemMarkdownTestApi,
  waitFor,
  workspaceDir,
  writeFile,
  writeFileAt,
} from './helpers';
import { now, toMicro } from './timingsClock';
import { DiskThread, STAT_GAP_MS } from './timingsDisk';
import { LOG_NOTICE, LOG_STAMP_MS, NoteEvents, recordWindow, type TimedEvent, type WindowSteps } from './timingsEvents';
import { keepBusy, type Load } from './timingsLoad';

/** How many times each case of each trial runs, under each load. */
const RUNS = {
  firstEdit: 25,
  reload: 15,
  revert: 15,
  save: 15,
  outsideWrite: 3,
  readAfterSave: 25,
  checkout: 6,
  close: 5,
} as const;

/** How long a window waits for what its trial waits for: a guard against a hang, not a measurement. */
const WITHIN_MS = 5000;
/** How long a close is waited for, a guard: VS Code closes a note's document a moment after its last tab. */
const CLOSE_WITHIN_MS = 20_000;
/** How long later events are given once what a window waits for has come. */
const LATER_MS = 200;
/** How long what follows a reload is given to arrive. */
const AFTER_RELOAD_MS = 500;
/** How long a note stays quiet before a window begins. */
const QUIET_MS = 300;
/**
 * How long a note stays quiet after another program's write or a checkout before the outcome is
 * read: longer than the longest pause between Tandem Markdown's looks at a file it is settling
 * (RETRY_MS in src/core/reconcile/reconciler.ts, SECOND_LOOK_MS in diskReads.ts,
 * OVERWRITTEN_WAIT_MS in overwritten.ts).
 */
const SETTLE_MS = 1200;
/** How long a note is given to fall quiet: a guard. */
const QUIET_WITHIN_MS = 15_000;
/** How long one trial may take before mocha gives up on it: a guard against a hang. */
const TRIAL_LIMIT_MS = 45 * 60_000;
/** One turn of the loop that keeps the extension host busy: the length a browser calls a long task. */
const BUSY_TURN_MS = 50;
/** Auto-save's delay where a trial turns it on: every second, as the busy file ran (CONTRIBUTING.md). */
const AUTO_SAVE_DELAY_MS = 1000;

/** The waits, the least time between the disk thread's stats, and how far a log line's place can be off, as each record states them. */
const WAITS = {
  WITHIN_MS,
  CLOSE_WITHIN_MS,
  LATER_MS,
  AFTER_RELOAD_MS,
  QUIET_MS,
  SETTLE_MS,
  QUIET_WITHIN_MS,
  AUTO_SAVE_DELAY_MS,
  BUSY_TURN_MS,
  STAT_GAP_MS,
  LOG_STAMP_MS,
};

/** How the records' times read, for whoever opens one. */
const CLOCK_NOTE =
  "Times are milliseconds since the run's window began, from process.hrtime in the extension host. " +
  "A 'log' event carries Tandem Markdown's own clock, Date.now(), and is placed to within LOG_STAMP_MS " +
  "(waits) either way; a measure drawn from one has its resolution beside it ('...WithinMs'). " +
  "'file' and 'write' events come from a thread of their own, which stats the file at most every STAT_GAP_MS " +
  "(waits) and not while it writes: the file came to each state between that state's 'since' (when the stat " +
  "before it began) and its 'at' (when the stat that saw it returned).";

const NOTE = '# Timings\n\nThe first paragraph of a note.\n\nThe second paragraph.\n';
/** How many lines LONG_NOTE has. */
const LONG_LINES = 200;
/**
 * A long note, edited at several places before each save, so that VS Code holds its text in
 * several pieces, which its save writes one at a time (docs/ARCHITECTURE.md, "The save step").
 */
const LONG_NOTE = [
  '# A long note',
  '',
  ...Array.from({ length: LONG_LINES }, (_, i) => `Line ${i + 1} of a long note, with a few words on it.`),
  '',
].join('\n');
/** A note with a line that ends in spaces, which trimming trailing whitespace on save takes out. */
const TRAILING_NOTE = '# Trailing spaces\n\nA line that ends in spaces.   \n\nThe last line.\n';

// Tandem Markdown's trace lines that the measures read (the reconciler's `debug`, logged by
// src/host/documents.ts with the note's name before each).
/** A check's read of the file, decided (Reconciler.decideRead). */
const LOG_READ = /: check (\(save step\) )?read \d+ (chars|bytes)/;
/** A read that sets the base (KnownTexts.setBase). */
const LOG_BASE = /: base from a read \((\d+) chars\)/;
/** The save step's end, with how long after will-save (SaveRecord.end in Reconciler.newSave). */
const LOG_STEP_ENDS = /: the save step ends (\d+) ms after will-save/;
/** The looking after the step finding VS Code's write on disk (SaveWatch.lookedAt). */
const LOG_WRITE_FOUND = /: VS Code's write of the save is on disk/;
/** A note with nothing unsaved taking the file's version (Reconciler.followFile). */
const LOG_FOLLOWED = /: the document held nothing beyond the base: it took the file's version/;

const execFileAsync = promisify(execFile);

type LoadName = 'idle' | 'busy';
const LOADS: readonly LoadName[] = ['idle', 'busy'];
type View = 'Source' | 'a rich tab';
type Measures = Record<string, number | boolean | string | null>;

interface RunRecord {
  run: number;
  measures: Measures;
  /** The note was quiet when the window began. */
  quietBefore: boolean;
  reached: boolean;
  /**
   * The note fell quiet before its outcome was read, where a trial waits for that (trials whose
   * outcome is what the file and the note hold); null where the window ends after a set wait.
   */
  quietAfter: boolean | null;
  logComplete: boolean;
  stats: number;
  load: Load;
  events: TimedEvent[];
}

interface CaseRecord {
  name: string;
  load: LoadName;
  settings: Record<string, unknown>;
  runs: RunRecord[];
}

/** One case of a trial: the note of each run, what the run does in its window, and what measures it. */
interface Case<T> {
  name: string;
  runs: number;
  /** The note's events for run `run`, with the note open and as the run needs it. */
  ready(run: number): Promise<NoteEvents>;
  steps(notes: NoteEvents, run: number): WindowSteps<T>;
  measure(events: readonly TimedEvent[], acted: T): Measures;
  /** Once the window has ended: the note put back for the next run, or closed. */
  after(notes: NoteEvents, run: number): Promise<void>;
}

/** A measure the printed summary shows: as a spread of milliseconds, or as a count of each value. */
interface Shown {
  label: string;
  measure: string;
  as: 'ms' | 'tally';
  /** How far either way each value can be from the truth, where its clock is coarser than the spread's decimals. */
  withinMs?: number;
}

// ---------------------------------------------------------------------------
// Reading a timeline

type Kind = TimedEvent['kind'];
type Of<K extends Kind> = Extract<TimedEvent, { kind: K }>;

const VS_CODE_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  'change',
  'dirtyOnly',
  'stepEnded',
  'didSave',
  'watcher',
  'tabClosed',
  'closed',
]);

function is<K extends Kind>(kind: K): (e: TimedEvent) => e is Of<K> {
  return (e): e is Of<K> => e.kind === kind;
}

/** The first event of `kind` at or after `from` that `holds` takes. */
function first<K extends Kind>(
  events: readonly TimedEvent[],
  kind: K,
  from = -Infinity,
  holds: (e: Of<K>) => boolean = () => true,
): Of<K> | undefined {
  return events.find((e): e is Of<K> => is(kind)(e) && e.at >= from && holds(e));
}

/** The first step whose words begin with `what`. */
function stepOf(events: readonly TimedEvent[], what: string): Of<'step'> | undefined {
  return first(events, 'step', -Infinity, (e) => e.what.startsWith(what));
}

/** The first of Tandem Markdown's lines at or after `from` that `pattern` matches. */
function logLine(events: readonly TimedEvent[], pattern: RegExp, from = -Infinity): Of<'log'> | undefined {
  return first(events, 'log', from, (e) => pattern.test(e.message));
}

/** From `a` to `b`, in milliseconds; null when either is missing. */
function gap(a: TimedEvent | undefined, b: TimedEvent | undefined): number | null {
  return a && b ? toMicro(b.at - a.at) : null;
}

function named(e: TimedEvent): string {
  switch (e.kind) {
    case 'change':
      return `change (${e.dirty ? 'dirty' : 'clean'}${e.reason ? `, ${e.reason}` : ''})`;
    case 'dirtyOnly':
      return `dirty-only (${e.dirty ? 'dirty' : 'clean'})`;
    case 'watcher':
      return `watcher ${e.what}`;
    default:
      return e.kind;
  }
}

/** VS Code's events among `events`, by name, in order. */
function vsCodeEvents(events: readonly TimedEvent[]): string {
  return events
    .filter((e) => VS_CODE_KINDS.has(e.kind))
    .map(named)
    .join(', ');
}

/** The notices Tandem Markdown raised among `events`, by kind. */
function notices(events: readonly TimedEvent[]): string {
  return events
    .filter(is('log'))
    .map((e) => LOG_NOTICE.exec(e.message)?.[1])
    .filter((kind) => kind !== undefined)
    .join(', ');
}

/** Which of `marks` (a name for each text it looks for) `text` holds, in words. */
function holding(text: string, marks: Record<string, string>): string {
  const held = Object.entries(marks)
    .filter(([, mark]) => text.includes(mark))
    .map(([name]) => name);
  return held.length === 0 ? 'none of them' : held.join(' and ');
}

/**
 * VS Code's write of a save, from the file's states: those after `from` (the step's end, or the
 * save asked for when it has no step) up to did-save, and what they show.
 */
function saveWrite(events: readonly TimedEvent[], from: TimedEvent | undefined, didSave: TimedEvent | undefined) {
  const during = from && didSave ? events.filter(is('file')).filter((s) => s.at > from.at && s.at <= didSave.at) : [];
  const sizes = during.map((s) => s.size);
  const whole = during.at(-1)?.size ?? null;
  return {
    start: during[0],
    end: during.at(-1),
    measures: {
      statesDuringWrite: sizes.join(' '),
      distinctSizes: new Set(sizes).size,
      emptySeen: sizes.includes(0),
      piecesSeen: sizes.filter((s) => s !== null && whole !== null && s > 0 && s < whole).length,
    },
  };
}

// ---------------------------------------------------------------------------
// The summary

/** Nearest-rank percentile `q` (0 to 1) of sorted `values`. */
function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

function spread(values: readonly (number | boolean | string | null)[], withinMs: number | undefined): string {
  const ms = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (ms.length === 0) return 'none';
  const two = (n: number) => String(Number(n.toFixed(2)));
  const missing = values.length - ms.length;
  return (
    `median ${two(percentile(ms, 0.5))} ms, 90th percentile ${two(percentile(ms, 0.9))}, ` +
    `least ${two(ms[0]!)}, most ${two(ms.at(-1)!)}${missing > 0 ? `, missing in ${missing}` : ''}` +
    (withinMs === undefined ? '' : `, each within ${withinMs} ms either way`)
  );
}

function tally(values: readonly (number | boolean | string | null)[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v === null || v === '' ? 'none' : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([value, n]) => `${value} ${n}`).join(', ');
}

function summary(c: CaseRecord, shown: readonly Shown[]): string {
  const parts = [`${c.runs.length} runs`];
  const missed = c.runs.filter((r) => !r.reached).length;
  if (missed > 0) parts.push(`${missed} did not reach what they waited for`);
  const noisyBefore = c.runs.filter((r) => !r.quietBefore).length;
  if (noisyBefore > 0) parts.push(`${noisyBefore} were not quiet when the window began`);
  const noisyAfter = c.runs.filter((r) => r.quietAfter === false).length;
  if (noisyAfter > 0) parts.push(`${noisyAfter} did not fall quiet before the outcome was read`);
  for (const s of shown) {
    const values = c.runs.map((r) => r.measures[s.measure] ?? null);
    parts.push(`${s.label}: ${s.as === 'ms' ? spread(values, s.withinMs) : tally(values)}`);
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Settings and notes

/** Sets `files.trimTrailingWhitespace` for markdown; the function returned puts it back. */
function trimTrailing(on: boolean): Promise<() => Promise<void>> {
  return setSetting('files', 'trimTrailingWhitespace', on, 'markdown');
}

/** A window's later wait of set length: it waits for no state, so it answers null (WindowSteps.later). */
async function waitFixed(ms: number): Promise<null> {
  await pause(ms);
  return null;
}

async function revertTo(document: vscode.TextDocument, text: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await waitFor(() => !document.isDirty && lf(document.getText()) === text, 'the note to be put back');
}

factsSuite("Facts: the timings of VS Code's events about a note", () => {
  let hook: TandemMarkdownTestApi;
  let disk: DiskThread;
  let folder: string;
  const began = new Date().toISOString();
  const trials: { trial: number; file: string; durationMs: number; failed: string | null }[] = [];

  function writeRun(finished: boolean): void {
    const processors = os.cpus();
    const run = {
      vscode: vscode.version,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: `${os.platform()} ${os.release()}`,
      processors: { count: processors.length, model: processors[0]?.model ?? null },
      began,
      finished: finished ? new Date().toISOString() : null,
      runs: RUNS,
      waits: WAITS,
      clock: CLOCK_NOTE,
      settings: saveSettings(),
      trials,
    };
    writeFileSync(path.join(folder, 'run.json'), JSON.stringify(run, null, 1));
  }

  /** Writes `name` with `text`, opens it in `view`, and starts recording its events once it is open clean. */
  async function openNote(
    name: string,
    text: string,
    view: View,
  ): Promise<{ notes: NoteEvents; document: vscode.TextDocument; editor: vscode.TextEditor | null }> {
    const uri = writeFile(`facts/timings/${name}.md`, text);
    const editor = view === 'Source' ? await openText(uri) : null;
    const document = editor ? editor.document : await openRich(uri);
    await waitFor(() => !document.isDirty && lf(document.getText()) === text, `${name} to open clean`);
    return { notes: new NoteEvents(uri, hook), document, editor };
  }

  async function runCase<T>(load: LoadName, c: Case<T>): Promise<CaseRecord> {
    const settings = saveSettings();
    const runs: RunRecord[] = [];
    for (let run = 1; run <= c.runs; run++) {
      const notes = await c.ready(run);
      const quietBefore = await notes.settle(QUIET_MS, QUIET_WITHIN_MS);
      const w = await recordWindow(notes, disk, c.steps(notes, run));
      assert.ok(w.stats > 0, `the disk thread made no stat in run ${run} of ${c.name}`);
      runs.push({
        run,
        measures: c.measure(w.events, w.acted),
        quietBefore,
        reached: w.reached,
        quietAfter: w.quietAfter,
        logComplete: w.logComplete,
        stats: w.stats,
        load: w.load,
        events: w.events,
      });
      await c.after(notes, run);
    }
    return { name: c.name, load, settings, runs };
  }

  /**
   * Runs a trial's cases with the extension host idle, then busy, writes its record and prints
   * its summary; a failure is recorded with what ran before it, then thrown.
   */
  async function runTrial(
    trial: number,
    question: string,
    shown: readonly Shown[],
    cases: (load: LoadName) => Promise<CaseRecord[]>,
  ): Promise<void> {
    const started = Date.now();
    const records: CaseRecord[] = [];
    let failure: unknown = null;
    for (const load of LOADS) {
      const stopBusy = load === 'busy' ? keepBusy(BUSY_TURN_MS) : null;
      try {
        records.push(...(await cases(load)));
      } catch (error) {
        failure = error;
      } finally {
        stopBusy?.();
        await closeEverything();
      }
      if (failure !== null) break;
    }
    const durationMs = Date.now() - started;
    const failed = failure === null ? null : String(failure);
    const file = path.join(folder, `trial-${trial}.json`);
    const record = {
      trial,
      question,
      vscode: vscode.version,
      written: new Date().toISOString(),
      durationMs,
      failed,
      runs: RUNS,
      waits: WAITS,
      clock: CLOCK_NOTE,
      cases: records,
    };
    writeFileSync(file, JSON.stringify(record, null, 1));
    trials.push({ trial, file, durationMs, failed });
    writeRun(false);
    note(`Trial ${trial}, ${question} (${Math.round(durationMs / 1000)} s, ${file})`);
    for (const c of records) note(`  ${c.name}, ${c.load}: ${summary(c, shown)}`);
    if (failure !== null) throw failure;
  }

  suiteSetup(async function () {
    this.timeout(60_000);
    hook = await api();
    folder = path.join(path.dirname(workspaceDir()), 'timings', `${vscode.version}-${timestamp(new Date())}`);
    mkdirSync(folder, { recursive: true });
    disk = await DiskThread.start();
    // The measures read Tandem Markdown's log through the test hook, which must answer.
    const since = Date.now();
    await openText(writeFile('facts/timings/log-check.md', NOTE));
    await waitFor(
      () => hook.logLines().some((l) => l.at >= since),
      "Tandem Markdown to log a line as it opened a note (read through the test hook's logLines)",
    );
    await closeEverything();
    writeRun(false);
    note(`VS Code ${vscode.version}; the records go to ${folder}`);
  });

  suiteTeardown(async () => {
    await disk?.end();
    if (folder) writeRun(true);
  });

  teardown(async () => {
    await closeEverything();
  });

  test('a first edit to a clean note, by each route: its clean change and its dirty-only event', async function () {
    this.timeout(TRIAL_LIMIT_MS);
    interface Route {
      name: string;
      view: View;
      text: string;
      /** The step the route's answer is marked by. */
      answer: string;
      /** The edit is made by a save, which the window waits for too. */
      saves: boolean;
      edit(notes: NoteEvents, mark: (what: string) => void): Promise<void>;
      reset(notes: NoteEvents, document: vscode.TextDocument): Promise<void>;
      setting?(): Promise<() => Promise<void>>;
    }
    const routes: Route[] = [
      {
        name: 'Source typing',
        view: 'Source',
        text: NOTE,
        answer: 'typed',
        saves: false,
        edit: async (_notes, mark) => {
          await vscode.commands.executeCommand('type', { text: 'x' });
          mark('typed');
        },
        reset: (_notes, document) => revertTo(document, NOTE),
      },
      {
        name: "a rich tab's push",
        view: 'a rich tab',
        text: NOTE,
        answer: 'the push answered',
        saves: false,
        edit: async (notes, mark) => {
          await hook.runInPanel(notes.uri, [{ type: 'insert', at: 0, text: 'x' }, { type: 'flush' }]);
          mark('the push answered');
        },
        reset: (_notes, document) => revertTo(document, NOTE),
      },
      {
        // Built as the host builds a push's edit (documentPort in src/host/documents.ts), from a
        // test in place of the core, with the note in Source.
        name: 'a WorkspaceEdit',
        view: 'Source',
        text: NOTE,
        answer: 'applyEdit answered',
        saves: false,
        edit: async (notes, mark) => {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(notes.uri, new vscode.Range(0, 0, 0, 0), 'x');
          mark(`applyEdit answered ${await vscode.workspace.applyEdit(edit)}`);
        },
        reset: (_notes, document) => revertTo(document, NOTE),
      },
      {
        name: "the first save participant's edit",
        view: 'Source',
        text: TRAILING_NOTE,
        answer: 'save answered',
        saves: true,
        setting: () => trimTrailing(true),
        edit: async (_notes, mark) => {
          mark('save asked');
          await vscode.commands.executeCommand('workbench.action.files.save');
          mark('save answered');
        },
        reset: async (notes, document) => {
          writeFileAt(notes.uri, TRAILING_NOTE);
          await waitFor(
            () => !document.isDirty && lf(document.getText()) === TRAILING_NOTE,
            'VS Code to reload the note',
          );
        },
      },
    ];
    await runTrial(
      1,
      'the first edit to a clean note: how long from its clean content change to its dirty-only event, and what comes between',
      [
        { label: 'clean change to its dirty-only event', measure: 'dirtyOnlyMs', as: 'ms' },
        { label: 'the change arrived clean', measure: 'changeArrivedClean', as: 'tally' },
        { label: "VS Code's events between", measure: 'vsCodeEventsBetween', as: 'tally' },
        { label: 'Tandem Markdown finished a read between', measure: 'readBetween', as: 'tally' },
        { label: "the route's answer after the change", measure: 'answeredMs', as: 'ms' },
        { label: 'answered before the dirty-only event', measure: 'answeredBeforeDirtyOnly', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const [i, route] of routes.entries()) {
          const restore = route.setting ? await route.setting() : null;
          const { notes, document } = await openNote(`1-route${i + 1}-${load}`, route.text, route.view);
          try {
            out.push(
              await runCase(load, {
                name: route.name,
                runs: RUNS.firstEdit,
                ready: () => Promise.resolve(notes),
                steps: () => ({
                  act: (mark) => route.edit(notes, mark),
                  done: (events) => {
                    const change = first(events, 'change');
                    const flipped = change && first(events, 'dirtyOnly', change.at, (e) => e.dirty);
                    return flipped !== undefined && (!route.saves || events.some(is('didSave')));
                  },
                  withinMs: WITHIN_MS,
                  later: () => waitFixed(LATER_MS),
                }),
                measure: (events) => {
                  const change = first(events, 'change');
                  const flipped = change && first(events, 'dirtyOnly', change.at, (e) => e.dirty);
                  const between = change && flipped ? events.filter((e) => e.at > change.at && e.at < flipped.at) : [];
                  const answered = stepOf(events, route.answer);
                  // A log line is between for sure only when it is so wherever within LOG_STAMP_MS its moment lies.
                  const lines = events.filter(is('log'));
                  const surely = lines.filter(
                    (e) => change && flipped && e.at - LOG_STAMP_MS > change.at && e.at + LOG_STAMP_MS < flipped.at,
                  );
                  const maybe = lines.filter(
                    (e) => change && flipped && e.at + LOG_STAMP_MS > change.at && e.at - LOG_STAMP_MS < flipped.at,
                  );
                  const isRead = (e: Of<'log'>) => LOG_READ.test(e.message);
                  return {
                    changeArrivedClean: change ? !change.dirty : null,
                    dirtyOnlyMs: gap(change, flipped),
                    vsCodeEventsBetween: vsCodeEvents(between),
                    logLinesBetween: change && flipped ? surely.length : null,
                    logLinesNearTheEdges: change && flipped ? maybe.length - surely.length : null,
                    readBetween:
                      !change || !flipped
                        ? null
                        : surely.some(isRead)
                          ? 'yes'
                          : maybe.some(isRead)
                            ? 'cannot tell'
                            : 'no',
                    answeredMs: gap(change, answered),
                    answeredBeforeDirtyOnly: answered && flipped ? answered.at < flipped.at : null,
                  };
                },
                after: () => route.reset(notes, document),
              }),
            );
          } finally {
            notes.dispose();
            await closeEverything();
            await restore?.();
          }
        }
        return out;
      },
    );
  });

  test("VS Code's reload of a clean note when another program writes the file", async function () {
    this.timeout(TRIAL_LIMIT_MS);
    const written = (run: number) => `${NOTE}\nA paragraph another program wrote, number ${run}.\n`;
    await runTrial(
      2,
      "VS Code's reload of a clean note: the write, the watcher's event, the content change, and what follows it",
      [
        { label: 'end of the write to the content change', measure: 'changeMs', as: 'ms' },
        { label: "end of the write to the watcher's event", measure: 'watcherMs', as: 'ms' },
        { label: 'the change arrived', measure: 'changeDirty', as: 'tally' },
        { label: "VS Code's events after the change", measure: 'after', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const autoSave of [false, true]) {
          const restore = autoSave
            ? [
                await setSetting('files', 'autoSave', 'afterDelay'),
                await setSetting('files', 'autoSaveDelay', AUTO_SAVE_DELAY_MS),
              ]
            : [];
          const { notes, document } = await openNote(`2-${autoSave ? 'auto' : 'manual'}-${load}`, NOTE, 'Source');
          try {
            out.push(
              await runCase(load, {
                name: autoSave ? `auto-save after ${AUTO_SAVE_DELAY_MS} ms` : 'auto-save off',
                runs: RUNS.reload,
                ready: () => Promise.resolve(notes),
                steps: (_notes, run) => ({
                  act: (mark) => {
                    disk.writeAt(now(), written(run), 'another program');
                    mark('write asked');
                    return Promise.resolve();
                  },
                  done: (events) =>
                    lf(document.getText()) === written(run) && events.some(is('change')) && events.some(is('watcher')),
                  withinMs: WITHIN_MS,
                  later: () => waitFixed(AFTER_RELOAD_MS),
                }),
                measure: (events) => {
                  const write = first(events, 'write');
                  const end = write ? write.end : null;
                  const change = write && first(events, 'change', write.at);
                  const watcher = write && first(events, 'watcher', write.at);
                  const after = change ? events.filter((e) => e.at > change.at) : [];
                  return {
                    writeMs: write ? toMicro(write.end - write.at) : null,
                    writeTries: write?.tries ?? null,
                    changeMs: change && end !== null ? toMicro(change.at - end) : null,
                    watcherMs: watcher && end !== null ? toMicro(watcher.at - end) : null,
                    changeDirty: change ? (change.dirty ? 'dirty' : 'clean') : null,
                    changeReason: change ? (change.reason ?? 'none') : null,
                    contentChanges: events.filter(is('change')).length,
                    after: vsCodeEvents(after),
                    dirtyOnlyAfter: after.some(is('dirtyOnly')),
                  };
                },
                after: () => Promise.resolve(),
              }),
            );
          } finally {
            notes.dispose();
            await closeEverything();
            for (const r of restore.reverse()) await r();
          }
        }
        return out;
      },
    );
  });

  test('Revert File, and undo back to the saved text: the clean flag and the text change', async function () {
    this.timeout(TRIAL_LIMIT_MS);
    await runTrial(
      3,
      'Revert File, and undo back to the saved text: which comes first, the clean flag or the text change',
      [
        { label: 'which first', measure: 'order', as: 'tally' },
        { label: 'from the change to the clean flag', measure: 'flagAfterChangeMs', as: 'ms' },
        { label: 'the change arrived', measure: 'changeDirty', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const how of ['Revert File', 'undo back to the saved text'] as const) {
          const { notes, document } = await openNote(
            `3-${how === 'Revert File' ? 'revert' : 'undo'}-${load}`,
            NOTE,
            'Source',
          );
          try {
            out.push(
              await runCase(load, {
                name: how,
                runs: RUNS.revert,
                ready: async () => {
                  await vscode.commands.executeCommand('type', { text: 'x' });
                  await waitFor(() => document.isDirty, 'the typing to reach the note');
                  return notes;
                },
                steps: () => ({
                  act: async (mark) => {
                    mark(`${how} asked`);
                    await vscode.commands.executeCommand(
                      how === 'Revert File' ? 'workbench.action.files.revert' : 'undo',
                    );
                    mark(`${how} answered`);
                  },
                  done: (events) =>
                    !document.isDirty &&
                    lf(document.getText()) === NOTE &&
                    events.some(is('change')) &&
                    events.some((e) => e.kind === 'dirtyOnly' && !e.dirty),
                  withinMs: WITHIN_MS,
                  later: () => waitFixed(LATER_MS),
                }),
                measure: (events) => {
                  const change = first(events, 'change');
                  const flag = first(events, 'dirtyOnly', -Infinity, (e) => !e.dirty);
                  return {
                    order: change && flag ? (flag.at < change.at ? 'the clean flag' : 'the text change') : null,
                    flagAfterChangeMs: gap(change, flag),
                    changeDirty: change ? (change.dirty ? 'dirty' : 'clean') : null,
                    changeReason: change ? (change.reason ?? 'none') : null,
                    contentChanges: events.filter(is('change')).length,
                    events: vsCodeEvents(events),
                  };
                },
                after: () => Promise.resolve(),
              }),
            );
          } finally {
            notes.dispose();
            await closeEverything();
          }
        }
        return out;
      },
    );
  });

  test("a save: will-save, the step's end, the file's states as VS Code writes it, did-save", async function () {
    this.timeout(TRIAL_LIMIT_MS);
    const saves = [
      { name: 'Save, trimming trailing whitespace', command: 'workbench.action.files.save', trim: true },
      { name: 'Save, with no save participant', command: 'workbench.action.files.save', trim: false },
      { name: 'Save without Formatting', command: 'workbench.action.files.saveWithoutFormatting', trim: false },
    ];
    await runTrial(
      4,
      "a save: will-save, the step's end, the file's size as VS Code writes it, did-save and the watcher's event",
      [
        { label: 'asked to the end of the step', measure: 'stepEndedMs', as: 'ms' },
        { label: 'to the first change of the file', measure: 'writeStartMs', as: 'ms' },
        { label: 'the write, first change to last', measure: 'writeMs', as: 'ms' },
        { label: 'last change to did-save', measure: 'writeEndToDidSaveMs', as: 'ms' },
        { label: "did-save to the watcher's event", measure: 'didSaveToWatcherMs', as: 'ms' },
        { label: 'sizes seen during the write', measure: 'statesDuringWrite', as: 'tally' },
        { label: 'the file seen empty', measure: 'emptySeen', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const [i, save] of saves.entries()) {
          const restore = await trimTrailing(save.trim);
          const { notes, document, editor } = await openNote(`4-save${i + 1}-${load}`, LONG_NOTE, 'Source');
          try {
            out.push(
              await runCase(load, {
                name: save.name,
                runs: RUNS.save,
                ready: async () => {
                  await editor!.edit((b) => {
                    b.insert(new vscode.Position(10, 0), 'one ');
                    b.insert(new vscode.Position(100, 0), 'two ');
                    b.insert(document.lineAt(190).range.end, '   ');
                  });
                  await waitFor(() => document.isDirty, 'the edits to reach the note');
                  return notes;
                },
                steps: () => ({
                  act: async (mark) => {
                    mark('save asked');
                    await vscode.commands.executeCommand(save.command);
                    mark('save answered');
                  },
                  done: (events) => {
                    const didSave = first(events, 'didSave');
                    return didSave !== undefined && events.some(is('watcher'));
                  },
                  withinMs: WITHIN_MS,
                  later: () => waitFixed(LATER_MS),
                }),
                measure: (events) => {
                  const asked = stepOf(events, 'save asked');
                  const stepEnded = first(events, 'stepEnded');
                  const didSave = first(events, 'didSave');
                  const write = saveWrite(events, stepEnded ?? asked, didSave);
                  const stepLine = logLine(events, LOG_STEP_ENDS);
                  const stepMs = stepLine ? Number(LOG_STEP_ENDS.exec(stepLine.message)![1]) : null;
                  return {
                    stepEndedMs: gap(asked, stepEnded),
                    stepMsLogged: stepMs,
                    stepMsLoggedWithinMs: LOG_STAMP_MS,
                    // Will-save, placed from the core's own count back from its line: the line's place
                    // and the count are each within LOG_STAMP_MS.
                    willSaveMs: asked && stepLine && stepMs !== null ? toMicro(stepLine.at - stepMs - asked.at) : null,
                    willSaveWithinMs: 2 * LOG_STAMP_MS,
                    writeStartMs: gap(stepEnded ?? asked, write.start),
                    writeMs: gap(write.start, write.end),
                    writeEndToDidSaveMs: gap(write.end, didSave),
                    didSaveToWatcherMs: gap(didSave, first(events, 'watcher', write.start?.at ?? asked?.at)),
                    ...write.measures,
                    participantEdits:
                      asked && didSave
                        ? events.filter((e) => e.kind === 'change' && e.at > asked.at && e.at < didSave.at).length
                        : null,
                    events: vsCodeEvents(events),
                  };
                },
                after: () => Promise.resolve(),
              }),
            );
          } finally {
            notes.dispose();
            await closeEverything();
            await restore();
          }
        }
        return out;
      },
    );
  });

  test("another program's write at set times around a save", async function () {
    this.timeout(TRIAL_LIMIT_MS);
    const EDIT = ' (typed before the save)';
    const OUTSIDE_LINE = 'A paragraph another program added.';
    const OUTSIDE = `${NOTE}\n${OUTSIDE_LINE}\n`;
    const marks = { 'the save': EDIT, "the other program's line": OUTSIDE_LINE };
    // VS Code writes a save some milliseconds after the step ends (docs/ARCHITECTURE.md, "The save
    // step"): the offsets after the step's end reach before, into and past that write.
    const writes = [
      { anchor: 'save asked', offsetMs: 0 },
      { anchor: 'save asked', offsetMs: 3 },
      { anchor: 'the step ended', offsetMs: 0 },
      { anchor: 'the step ended', offsetMs: 5 },
      { anchor: 'the step ended', offsetMs: 15 },
      { anchor: 'the step ended', offsetMs: 30 },
      { anchor: 'did-save', offsetMs: 0 },
      { anchor: 'did-save', offsetMs: 20 },
      { anchor: 'did-save', offsetMs: 100 },
    ] as const;
    await runTrial(
      5,
      "another program's write at set times around a save: which write the file keeps, what the note holds, what arrives",
      [
        { label: 'the write landed', measure: 'landed', as: 'tally' },
        { label: 'the file holds', measure: 'fileHolds', as: 'tally' },
        { label: 'the note holds', measure: 'noteHolds', as: 'tally' },
        { label: 'a clean change after did-save', measure: 'cleanChangeAfterSave', as: 'tally' },
        { label: 'notices', measure: 'notices', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const [i, { anchor, offsetMs }] of writes.entries()) {
          let document: vscode.TextDocument | null = null;
          out.push(
            await runCase(load, {
              name: `another program writes ${offsetMs} ms after ${anchor}`,
              runs: RUNS.outsideWrite,
              ready: async (run) => {
                const opened = await openNote(`5-write${i + 1}-${load}-${run}`, NOTE, 'Source');
                document = opened.document;
                await opened.editor!.edit((b) => b.insert(opened.document.lineAt(2).range.end, EDIT));
                await waitFor(() => opened.document.isDirty, 'the typing to reach the note');
                return opened.notes;
              },
              steps: (notes) => ({
                act: async (mark) => {
                  const write = () => {
                    disk.writeAt(now() + offsetMs, OUTSIDE, 'another program');
                    mark(`write asked for ${offsetMs} ms after ${anchor}`);
                  };
                  if (anchor === 'the step ended') notes.atStepEnd = write;
                  if (anchor === 'did-save') notes.atDidSave = write;
                  mark('save asked');
                  if (anchor === 'save asked') write();
                  await vscode.commands.executeCommand('workbench.action.files.save');
                  mark('save answered');
                  return { file: () => lf(readText(notes.uri)), note: () => lf(document!.getText()) };
                },
                done: (events) => events.some(is('didSave')) && events.some(is('write')),
                withinMs: WITHIN_MS,
                later: () => notes.settle(SETTLE_MS, QUIET_WITHIN_MS),
              }),
              measure: (events, texts) => {
                const asked = stepOf(events, 'save asked');
                const write = first(events, 'write');
                const stepEnded = first(events, 'stepEnded');
                const didSave = first(events, 'didSave');
                const landed = !write
                  ? null
                  : stepEnded && write.end < stepEnded.at
                    ? 'before the step ended'
                    : didSave && write.end < didSave.at
                      ? "after the step's end, before did-save"
                      : 'after did-save';
                return {
                  landed,
                  writeAtMs: gap(asked, write),
                  writeTries: write?.tries ?? null,
                  writeError: write?.error ?? null,
                  stepEndedMs: gap(asked, stepEnded),
                  didSaveMs: gap(asked, didSave),
                  fileHolds: holding(texts.file(), marks),
                  noteHolds: holding(texts.note(), marks),
                  noteDirty: document!.isDirty,
                  cleanChangeAfterSave: didSave
                    ? events.some((e) => e.kind === 'change' && !e.dirty && e.at > didSave.at)
                    : null,
                  followedFile: logLine(events, LOG_FOLLOWED) !== undefined,
                  notices: notices(events),
                  events: vsCodeEvents(events),
                };
              },
              after: async (notes) => {
                notes.dispose();
                await closeEverything();
              },
            }),
          );
        }
        return out;
      },
    );
  });

  test("the time from did-save to Tandem Markdown's read of the save's text", async function () {
    this.timeout(TRIAL_LIMIT_MS);
    await runTrial(
      6,
      "the time from did-save to Tandem Markdown's own read finding the save's text (the base moving to it)",
      [
        {
          label: "did-save to the read that sets the base to the save's text",
          measure: 'didSaveToBaseMs',
          as: 'ms',
          withinMs: LOG_STAMP_MS,
        },
        { label: 'that read before did-save', measure: 'baseBeforeDidSave', as: 'tally' },
        { label: "end of VS Code's write to that read", measure: 'writeEndToBaseMs', as: 'ms', withinMs: LOG_STAMP_MS },
        {
          label: "did-save to the looking's finding of the write",
          measure: 'didSaveToWriteFoundMs',
          as: 'ms',
          withinMs: LOG_STAMP_MS,
        },
        { label: 'the base is the saved text', measure: 'baseIsTheSave', as: 'tally' },
      ],
      async (load) => {
        const { notes, document } = await openNote(`6-${load}`, NOTE, 'Source');
        // The read that sets the base to the save's text, told by its length: the step's own read
        // sets it to the text before the save, one character shorter, before VS Code writes.
        const baseSetTo = (events: readonly TimedEvent[], chars: number) =>
          first(events, 'log', -Infinity, (e) => Number(LOG_BASE.exec(e.message)?.[1]) === chars);
        try {
          return [
            await runCase(load, {
              name: 'Save in Source after typing',
              runs: RUNS.readAfterSave,
              ready: async () => {
                await vscode.commands.executeCommand('type', { text: 'x' });
                await waitFor(() => document.isDirty, 'the typing to reach the note');
                return notes;
              },
              steps: () => ({
                act: async (mark) => {
                  mark('save asked');
                  await vscode.commands.executeCommand('workbench.action.files.save');
                  mark('save answered');
                  return { saved: lf(document.getText()) };
                },
                done: (events) =>
                  events.some(is('didSave')) && baseSetTo(events, lf(document.getText()).length) !== undefined,
                withinMs: WITHIN_MS,
                later: () => waitFixed(LATER_MS),
              }),
              measure: (events, { saved }) => {
                const stepEnded = first(events, 'stepEnded');
                const didSave = first(events, 'didSave');
                const base = baseSetTo(events, saved.length);
                const write = saveWrite(events, stepEnded, didSave);
                const toBase = gap(didSave, base);
                return {
                  didSaveToBaseMs: toBase,
                  didSaveToBaseWithinMs: LOG_STAMP_MS,
                  baseBeforeDidSave:
                    toBase === null
                      ? null
                      : toBase < -LOG_STAMP_MS
                        ? 'yes'
                        : toBase > LOG_STAMP_MS
                          ? 'no'
                          : 'cannot tell',
                  writeEndToBaseMs: gap(write.end, base),
                  writeEndToBaseWithinMs: LOG_STAMP_MS,
                  didSaveToWriteFoundMs: gap(didSave, logLine(events, LOG_WRITE_FOUND)),
                  didSaveToWriteFoundWithinMs: LOG_STAMP_MS,
                  writeStartMs: gap(stepEnded, write.start),
                  writeMs: gap(write.start, write.end),
                  writeEndToDidSaveMs: gap(write.end, didSave),
                  ...write.measures,
                  baseChars: base ? Number(LOG_BASE.exec(base.message)![1]) : null,
                  savedChars: saved.length,
                  baseIsTheSave: hook.coordinatorState(notes.uri)?.base === saved,
                };
              },
              after: () => Promise.resolve(),
            }),
          ];
        } finally {
          notes.dispose();
          await closeEverything();
        }
      },
    );
  });

  test('a git checkout under an open note, clean and with unsaved typing', async function () {
    this.timeout(TRIAL_LIMIT_MS);
    const MAIN_LINE = 'The text on main.';
    const OTHER_LINE = 'A paragraph the other branch added.';
    const ON_MAIN = `# Checkout\n\n${MAIN_LINE}\n`;
    const ON_OTHER = `# Checkout\n\nThe text on the other branch.\n\n${OTHER_LINE}\n`;
    const TYPED = 'typed ';
    const marks = { 'the typing': TYPED, main: MAIN_LINE, 'the other branch': OTHER_LINE };
    /** Run `run` checks out the other branch, then main again, in turn. */
    const target = (run: number) =>
      run % 2 === 1 ? { branch: 'other', text: ON_OTHER } : { branch: 'main', text: ON_MAIN };
    await runTrial(
      7,
      'a git checkout under an open note, clean and with unsaved typing: what the file and VS Code do, and when',
      [
        { label: 'checkout begun to the content change', measure: 'changeMs', as: 'ms' },
        { label: "checkout begun to the watcher's first event", measure: 'watcherMs', as: 'ms' },
        { label: "the watcher's events", measure: 'watcher', as: 'tally' },
        { label: 'the note holds', measure: 'noteHolds', as: 'tally' },
        { label: 'notices', measure: 'notices', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const typing of [false, true]) {
          const name = `7-${typing ? 'typing' : 'clean'}-${load}`;
          const uri = writeFile(`facts/timings/${name}/note.md`, ON_MAIN);
          const repo = path.dirname(uri.fsPath);
          git(repo, 'init', '--initial-branch=main');
          // The machine's own setting would give the checked-out note other line endings.
          git(repo, 'config', 'core.autocrlf', 'false');
          git(repo, 'add', 'note.md');
          git(repo, 'commit', '-m', 'On main');
          git(repo, 'checkout', '-b', 'other');
          writeFileAt(uri, ON_OTHER);
          git(repo, 'commit', '-am', 'On the other branch');
          git(repo, 'checkout', 'main');
          const editor = await openText(uri);
          const document = editor.document;
          await waitFor(() => !document.isDirty && lf(document.getText()) === ON_MAIN, 'the note to open clean');
          const notes = new NoteEvents(uri, hook);
          try {
            out.push(
              await runCase(load, {
                name: typing ? 'with unsaved typing' : 'with nothing unsaved',
                runs: RUNS.checkout,
                ready: async () => {
                  if (typing) {
                    // On the first line, which neither branch changes, so the checkout merges.
                    editor.selection = new vscode.Selection(0, 0, 0, 0);
                    await vscode.commands.executeCommand('type', { text: TYPED });
                    await waitFor(() => document.isDirty, 'the typing to reach the note');
                  }
                  return notes;
                },
                steps: (_notes, run) => ({
                  act: async (mark) => {
                    mark(`checkout of ${target(run).branch} begun`);
                    await execFileAsync('git', ['checkout', '--quiet', target(run).branch], { cwd: repo });
                    mark('checkout ended');
                  },
                  done: (events) => {
                    const text = lf(document.getText());
                    const line = run % 2 === 1 ? OTHER_LINE : MAIN_LINE;
                    return typing ? text.includes(line) : text === target(run).text && events.some(is('watcher'));
                  },
                  withinMs: WITHIN_MS,
                  later: () => notes.settle(SETTLE_MS, QUIET_WITHIN_MS),
                }),
                measure: (events) => {
                  const begun = stepOf(events, 'checkout of');
                  const after = begun ? events.filter((e) => e.at >= begun.at) : [];
                  const change = first(after, 'change');
                  return {
                    checkoutMs: gap(begun, stepOf(events, 'checkout ended')),
                    fileChangeMs: gap(begun, first(after, 'file')),
                    watcherMs: gap(begun, first(after, 'watcher')),
                    watcher: after
                      .filter(is('watcher'))
                      .map((e) => e.what)
                      .join(' '),
                    changeMs: gap(begun, change),
                    changeDirty: change ? (change.dirty ? 'dirty' : 'clean') : null,
                    contentChanges: after.filter(is('change')).length,
                    noteHolds: holding(lf(document.getText()), marks),
                    noteDirty: document.isDirty,
                    followedFile: logLine(events, LOG_FOLLOWED) !== undefined,
                    notices: notices(events),
                    events: vsCodeEvents(events),
                  };
                },
                after: async (_notes, run) => {
                  if (typing) await revertTo(document, target(run).text);
                },
              }),
            );
          } finally {
            notes.dispose();
            await closeEverything();
          }
        }
        return out;
      },
    );
  });

  test('a close with nothing unsaved, and a close after a save during which typing landed', async function () {
    this.timeout(TRIAL_LIMIT_MS);
    const TYPED = 'typed ';
    const DURING = 'typed during the save ';
    await runTrial(
      8,
      'a close with nothing unsaved, and a close after a save during which typing landed: when VS Code closes it, and whether it asks',
      [
        { label: 'close asked to the tab gone', measure: 'tabClosedMs', as: 'ms' },
        { label: 'close asked to the document closed', measure: 'closedMs', as: 'ms' },
        { label: 'the typing landed', measure: 'landed', as: 'tally' },
        { label: 'the file holds that typing', measure: 'fileHoldsTyping', as: 'tally' },
        { label: 'VS Code would ask whether to save', measure: 'asked', as: 'tally' },
        { label: 'quiet before the close', measure: 'quietBeforeClose', as: 'tally' },
        { label: 'notices', measure: 'notices', as: 'tally' },
      ],
      async (load) => {
        const out: CaseRecord[] = [];
        for (const duringSave of [false, true]) {
          let document: vscode.TextDocument | null = null;
          out.push(
            await runCase(load, {
              name: duringSave ? 'a close after a save during which typing landed' : 'a close with nothing unsaved',
              runs: RUNS.close,
              ready: async (run) => {
                const opened = await openNote(
                  `8-${duringSave ? 'during' : 'clean'}-${load}-${run}`,
                  NOTE,
                  'a rich tab',
                );
                document = opened.document;
                if (duringSave) {
                  await hook.runInPanel(opened.notes.uri, [
                    { type: 'insert', at: NOTE.length, text: TYPED },
                    { type: 'flush' },
                  ]);
                  await waitFor(() => opened.document.isDirty, 'the typing to reach the note');
                }
                return opened.notes;
              },
              steps: (notes) => ({
                act: async (mark) => {
                  const doc = document!;
                  const state: Measures = {};
                  if (duringSave) {
                    let saved = false;
                    notes.atDidSave = () => (saved = true);
                    notes.atStepEnd = () => {
                      mark('typing sent as the step ended');
                      void hook
                        .runInPanel(notes.uri, [
                          { type: 'insert', at: lf(doc.getText()).length, text: DURING },
                          { type: 'flush' },
                        ])
                        .then(
                          () => mark('that typing answered'),
                          (error: unknown) => mark(`that typing failed: ${String(error)}`),
                        );
                    };
                    mark('save asked');
                    await vscode.commands.executeCommand('workbench.action.files.save');
                    mark('save answered');
                    await holdsWithin(WITHIN_MS, () => saved && lf(doc.getText()).includes(DURING));
                    state.quietBeforeClose = await notes.settle(QUIET_MS, QUIET_WITHIN_MS);
                    state.hostDirty = doc.isDirty;
                    state.tabDirty = tabsFor(notes.uri)[0]?.isDirty ?? null;
                    state.fileHoldsTyping = readText(notes.uri).includes(DURING);
                  }
                  // Closing a tab that shows unsaved changes asks whether to save, in a dialog
                  // that would hold the run: such a tab is closed with Revert instead.
                  const asks = state.tabDirty === true;
                  state.asked = duringSave ? asks : null;
                  mark(asks ? 'close asked, reverting: VS Code would ask whether to save' : 'close asked');
                  void vscode.commands
                    .executeCommand(
                      asks ? 'workbench.action.revertAndCloseActiveEditor' : 'workbench.action.closeActiveEditor',
                    )
                    .then(
                      () => mark('close answered'),
                      (error: unknown) => mark(`close failed: ${String(error)}`),
                    );
                  return state;
                },
                done: (events) => events.some(is('closed')),
                withinMs: CLOSE_WITHIN_MS,
                later: () => waitFixed(LATER_MS),
              }),
              measure: (events, state) => {
                const asked = stepOf(events, 'close asked');
                const didSave = first(events, 'didSave');
                const typed = first(events, 'change', -Infinity, (e) =>
                  e.changes.some((c) => c.inserted.includes(DURING)),
                );
                const landed = !duringSave
                  ? null
                  : !typed
                    ? 'not seen'
                    : didSave && typed.at < didSave.at
                      ? 'before did-save'
                      : 'after did-save';
                const closed = first(events, 'closed');
                return {
                  ...state,
                  landed,
                  typingAfterDidSaveMs: duringSave ? gap(didSave, typed) : null,
                  tabClosedMs: gap(asked, first(events, 'tabClosed')),
                  closedMs: gap(asked, closed),
                  closedIsClosed: closed?.isClosed ?? null,
                  notices: notices(events),
                  events: vsCodeEvents(events),
                };
              },
              after: async (notes) => {
                notes.dispose();
                await closeEverything();
              },
            }),
          );
          const open = out.at(-1)!.runs.filter((r) => !r.reached).length;
          assert.equal(open, 0, 'a note did not close: VS Code may be asking whether to save in the test window');
        }
        return out;
      },
    );
  });
});
