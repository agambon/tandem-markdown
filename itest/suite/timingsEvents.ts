// The timeline of one note for the facts file on VS Code's timings (factsTimings.test.ts): each
// event VS Code sends about the note, the test's own steps, Tandem Markdown's log lines and the
// disk thread's stats and writes (timingsDisk.ts), on one clock (timingsClock.ts). A repetition
// records one window of it (recordWindow). VS Code 1.120 and 1.146 call will-save listeners one
// after another, each once the promises of the one before have settled, and this file's listener
// is registered after Tandem Markdown's: so its call marks the end of Tandem Markdown's save step.

import * as vscode from 'vscode';
import { fileNameOf, logPrefixOf } from '../../src/host/uris';
import { holdsWithin, tabsFor, type TandemMarkdownTestApi } from './helpers';
import { now, toMicro } from './timingsClock';
import type { DiskSeen, DiskThread } from './timingsDisk';
import { type Load, measureLoad } from './timingsLoad';

/** One content change as VS Code reported it: where, how much it took out, and its new text's start and length. */
interface ChangeSeen {
  offset: number;
  removed: number;
  inserted: string;
  insertedLength: number;
}

/** How much of a change's new text a record keeps: enough to tell one change from another. */
const INSERTED_KEPT = 120;

export type TimedEvent =
  /** onDidChangeTextDocument with content changes; `dirty` is the document's isDirty read in the handler. */
  | {
      at: number;
      kind: 'change';
      version: number;
      dirty: boolean;
      reason: 'undo' | 'redo' | null;
      changes: ChangeSeen[];
    }
  /** onDidChangeTextDocument with no content changes. */
  | { at: number; kind: 'dirtyOnly'; version: number; dirty: boolean }
  /** This file's will-save listener, called once Tandem Markdown's save step has ended. */
  | { at: number; kind: 'stepEnded' }
  | { at: number; kind: 'didSave' }
  /** A file watcher's event for the note's file. */
  | { at: number; kind: 'watcher'; what: 'create' | 'change' | 'delete' }
  /** A tab of the note closed. */
  | { at: number; kind: 'tabClosed' }
  /** onDidCloseTextDocument, and whether the document is closed (a language change's is not). */
  | { at: number; kind: 'closed'; isClosed: boolean }
  /** The file as the disk thread's stat saw it, each time that changed: it came to be between `since` and `at`. */
  | {
      at: number;
      kind: 'file';
      since: number | null;
      size: number | null;
      mtime: number | null;
      error: string | null;
    }
  /** A write the disk thread made as another program; `end` on the same clock. */
  | { at: number; kind: 'write'; end: number; label: string; tries: number; error: string | null }
  /** A line of Tandem Markdown's log, stamped by its own clock (Date.now()): placed to within LOG_STAMP_MS. */
  | { at: number; kind: 'log'; level: string; message: string }
  /** A step the test took, or an answer it got. */
  | { at: number; kind: 'step'; what: string };

/**
 * How far either way a log line's place on the clock can be from its moment: the line is stamped
 * by Date.now(), which steps by a millisecond, and placed through a reading of both clocks at the
 * window's start, which is itself within a millisecond. So a log line within this of a VS Code
 * event cannot be put before or after it.
 */
export const LOG_STAMP_MS = 1;

/** A notice the core raised, as the host logs it (showCoreNotice in src/host/notices.ts): its kind. */
export const LOG_NOTICE = /^Notice \((\w+)\)/;

/** The clock and Date.now() read together, to place Tandem Markdown's log lines on the clock. */
interface ClockPair {
  mono: number;
  wall: number;
}

function readClocks(): ClockPair {
  const mono = now();
  return { mono, wall: Date.now() };
}

function reasonOf(reason: vscode.TextDocumentChangeReason | undefined): 'undo' | 'redo' | null {
  if (reason === vscode.TextDocumentChangeReason.Undo) return 'undo';
  if (reason === vscode.TextDocumentChangeReason.Redo) return 'redo';
  return null;
}

/** The events of one note, from its creation until `dispose`. */
export class NoteEvents {
  private readonly seen: TimedEvent[] = [];
  private readonly subscriptions: vscode.Disposable[];
  private tabs: number;
  /** Run by this file's will-save listener, when set: a step taken the moment Tandem Markdown's save step has ended. */
  atStepEnd: (() => void) | null = null;
  /** Run by this file's did-save listener, when set. */
  atDidSave: (() => void) | null = null;

  constructor(
    readonly uri: vscode.Uri,
    private readonly hook: TandemMarkdownTestApi,
  ) {
    const key = uri.toString();
    const ours = (document: vscode.TextDocument) => document.uri.toString() === key;
    const push = (event: TimedEvent) => this.seen.push(event);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), fileNameOf(uri)),
    );
    const watched = (what: 'create' | 'change' | 'delete') => () => push({ at: now(), kind: 'watcher', what });
    this.tabs = tabsFor(uri).length;
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        const at = now();
        if (!ours(e.document)) return;
        const { version, isDirty: dirty } = e.document;
        if (e.contentChanges.length === 0) {
          push({ at, kind: 'dirtyOnly', version, dirty });
          return;
        }
        const changes = e.contentChanges.map((c) => ({
          offset: c.rangeOffset,
          removed: c.rangeLength,
          inserted: c.text.slice(0, INSERTED_KEPT),
          insertedLength: c.text.length,
        }));
        push({ at, kind: 'change', version, dirty, reason: reasonOf(e.reason), changes });
      }),
      vscode.workspace.onWillSaveTextDocument((e) => {
        const at = now();
        if (!ours(e.document)) return;
        push({ at, kind: 'stepEnded' });
        this.atStepEnd?.();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const at = now();
        if (!ours(document)) return;
        push({ at, kind: 'didSave' });
        this.atDidSave?.();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const at = now();
        if (ours(document)) push({ at, kind: 'closed', isClosed: document.isClosed });
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const at = now();
        const count = tabsFor(uri).length;
        if (count < this.tabs) push({ at, kind: 'tabClosed' });
        this.tabs = count;
      }),
      watcher,
      watcher.onDidCreate(watched('create')),
      watcher.onDidChange(watched('change')),
      watcher.onDidDelete(watched('delete')),
    ];
  }

  /** Records a step the test took, or an answer it got. */
  mark(what: string): void {
    this.seen.push({ at: now(), kind: 'step', what });
  }

  /**
   * Waits until the note has had no event and Tandem Markdown's log no line about it for
   * `quietMs`, with the note's coordinator idle; false when `withinMs` (a guard) ran out first.
   * The lines counted are the coordinator's, which begin with logPrefixOf the note (its
   * `debug` and its UI port's `log`, set in Documents.track and Documents.uiPort), and every
   * notice line, which names no note at its start: the trials keep one note open at a time, so a
   * notice is taken for this one's, which can only make a settle wait longer.
   */
  settle(quietMs: number, withinMs: number): Promise<boolean> {
    const prefix = logPrefixOf(this.uri);
    return holdsWithin(withinMs, () => {
      const clocks = readClocks();
      const line = this.hook
        .logLines()
        .filter((l) => l.message.startsWith(prefix) || LOG_NOTICE.test(l.message))
        .at(-1);
      const lastLine = line === undefined ? -Infinity : clocks.mono + line.at - clocks.wall;
      const last = Math.max(this.seen.at(-1)?.at ?? -Infinity, lastLine);
      const state = this.hook.coordinatorState(this.uri);
      const idle = state === undefined || (!state.gateBusy && state.pendings === 0 && !state.holding);
      return idle && clocks.mono - last >= quietMs;
    });
  }

  /**
   * The window that began at `clocks`: every event since, sorted, with `at` (and a write's `end`)
   * in ms since it began. `complete` is false when the test hook may have dropped log lines of
   * the window (it keeps only its newest lines).
   */
  window(clocks: ClockPair, disk: DiskSeen): { events: TimedEvent[]; complete: boolean } {
    const start = clocks.mono;
    const kept = this.hook.logLines();
    const lines = kept
      .filter((l) => l.at >= clocks.wall)
      .map((l) => ({
        at: clocks.mono + l.at - clocks.wall,
        kind: 'log' as const,
        level: l.level,
        message: l.detail === undefined ? l.message : `${l.message} ${l.detail}`,
      }));
    const files = disk.states.map((s) => ({ ...s, kind: 'file' as const }));
    const writes = disk.writes.map((w) => ({ ...w, kind: 'write' as const }));
    const relative = (e: TimedEvent): TimedEvent => {
      if (e.kind === 'write') return { ...e, at: toMicro(e.at - start), end: toMicro(e.end - start) };
      if (e.kind === 'file')
        return { ...e, at: toMicro(e.at - start), since: e.since === null ? null : toMicro(e.since - start) };
      return { ...e, at: toMicro(e.at - start) };
    };
    const events = [...this.seen.filter((e) => e.at >= start), ...lines, ...files, ...writes]
      .map(relative)
      .sort((a, b) => a.at - b.at);
    return { events, complete: kept.length > 0 && kept[0]!.at <= clocks.wall };
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}

export interface WindowSteps<T> {
  /** What the repetition does once its window has begun, given a way to mark its steps; what it returns is kept. */
  act(mark: (what: string) => void): Promise<T>;
  /** Whether what the trial waits for has happened, judged on the window so far. */
  done(events: readonly TimedEvent[]): boolean;
  /** How long `done` is waited for: a guard against a hang, not a measurement. */
  withinMs: number;
  /**
   * Once `done` holds or its guard ran out, how later events are waited for: it resolves with
   * whether the note fell quiet, where that is what it waits for, or null for a wait of set length.
   */
  later(): Promise<boolean | null>;
}

interface WindowRecord {
  events: TimedEvent[];
  /** What the window waited for came within its guard. */
  reached: boolean;
  /** What `later` resolved with: the note fell quiet before the window ended, or null. */
  quietAfter: boolean | null;
  /** No log line of the window can have been dropped by the test hook. */
  logComplete: boolean;
  /** How many stats the disk thread made. */
  stats: number;
  load: Load;
}

/** Records one window of `notes`: the disk thread watches the note's file while `steps` run. */
export async function recordWindow<T>(
  notes: NoteEvents,
  disk: DiskThread,
  steps: WindowSteps<T>,
): Promise<WindowRecord & { acted: T }> {
  const clocks = readClocks();
  disk.watch(notes.uri.fsPath);
  const stopLoad = measureLoad();
  const acted = await steps.act((what) => notes.mark(what));
  const reached = await holdsWithin(steps.withinMs, () =>
    steps.done(notes.window(clocks, { states: [], writes: disk.written, stats: 0 }).events),
  );
  const quietAfter = await steps.later();
  const load = stopLoad();
  const seen = await disk.stop();
  const { events, complete } = notes.window(clocks, seen);
  return { events, reached, quietAfter, logComplete: complete, stats: seen.stats, load, acted };
}
