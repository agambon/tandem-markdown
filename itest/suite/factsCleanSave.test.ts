/// <reference types="mocha" />
// Facts, measured once (itest/suite/facts.ts): whether VS Code writes a note to disk when it is
// saved with nothing unsaved, by each way of saving, from Source and from a rich tab. A program
// writes the file and VS Code reloads the clean note; then the note is saved, either once the
// reload is in, or at once after another write puts an older text back (as a git checkout
// would), before VS Code has reloaded that. A save that writes then undoes the checkout with
// nothing said. Each case records the file's bytes and modified time, VS Code's will-save and
// did-save events, and whether Tandem Markdown's save step ran (its trace line "the save step
// ends"). Nothing is asserted of what VS Code does; no setting is changed.

import * as vscode from 'vscode';
import { factsSuite, saveSettings } from './facts';
import {
  api,
  closeEverything,
  holdsWithin,
  lf,
  mtime,
  note,
  openRich,
  openText,
  readText,
  waitFor,
  writeFile,
} from './helpers';

/** The note as the folder first held it, and as the checkout puts it back. */
const OLDER = '# Clean save\n\nThe first paragraph.\n';
/** The note as the other program writes it, which VS Code reloads into the clean note. */
const NEWER = '# Clean save\n\nThe first paragraph.\n\nA paragraph another program added.\n';

/** How long a save is given to show itself (its did-save event); a limit on waiting, not a measurement. */
const SAVE_SHOWS_WITHIN_MS = 3000;
/** How long Tandem Markdown is given to finish with the reload before the note is saved. */
const RELOAD_SETTLES_WITHIN_MS = 5000;

type View = 'Source' | 'a rich tab';
type Timing = 'once the reload is in' | 'at once after the checkout';

const WAYS: { name: string; save: (document: vscode.TextDocument) => Thenable<unknown> }[] = [
  { name: 'workbench.action.files.save', save: () => vscode.commands.executeCommand('workbench.action.files.save') },
  { name: 'vscode.workspace.save(uri)', save: (d) => vscode.workspace.save(d.uri) },
  { name: 'document.save()', save: (d) => d.save() },
];

/** Which of the two texts `text` is, in words. */
function which(text: string): string {
  if (lf(text) === OLDER) return 'the older text';
  if (lf(text) === NEWER) return 'the newer text';
  return `another text (${JSON.stringify(text.slice(0, 40))})`;
}

function settingsInForce(): string {
  return Object.entries(saveSettings())
    .map(([name, value]) => `${name} ${String(value)}`)
    .join(', ');
}

/** One case: the note opened in `view`, reloaded with NEWER, then saved by `way` at `timing`. What it saw, in words. */
async function saveClean(view: View, way: (typeof WAYS)[number], timing: Timing, name: string): Promise<string> {
  const hook = await api();
  const uri = writeFile(`facts/clean-save/${name}.md`, OLDER);
  const document = view === 'Source' ? (await openText(uri)).document : await openRich(uri);
  await waitFor(() => !document.isDirty && lf(document.getText()) === OLDER, 'the note to open clean');

  writeFile(`facts/clean-save/${name}.md`, NEWER);
  await waitFor(
    () => !document.isDirty && lf(document.getText()) === NEWER,
    'VS Code to reload the clean note from the file',
  );
  const quiet = await holdsWithin(RELOAD_SETTLES_WITHIN_MS, () => {
    const state = hook.coordinatorState(uri);
    return state === undefined || (!state.gateBusy && state.pendings === 0 && !state.holding);
  });

  if (timing === 'at once after the checkout') writeFile(`facts/clean-save/${name}.md`, OLDER);
  const bytesBefore = readText(uri);
  const timeBefore = mtime(uri);
  const noteBefore = `${document.isDirty ? 'unsaved changes' : 'clean'}, holding ${which(document.getText())}`;
  hook.clearRecords();
  const events = { willSave: 0, didSave: 0 };
  const subscriptions = [
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document.uri.toString() === uri.toString()) events.willSave++;
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.toString() === uri.toString()) events.didSave++;
    }),
  ];
  let answer: string;
  try {
    const result = await way.save(document);
    answer = result instanceof vscode.Uri ? 'a uri' : String(result);
    await holdsWithin(SAVE_SHOWS_WITHIN_MS, () => events.didSave > 0);
  } finally {
    for (const s of subscriptions) s.dispose();
  }

  const bytesAfter = readText(uri);
  const timeAfter = mtime(uri);
  const coordinator = hook.coordinatorState(uri);
  const steps = hook.logLines().filter((l) => l.message.includes('the save step ends')).length;
  const notices = hook.notices().filter((n) => n.uri === uri.toString());
  await closeEverything();
  return [
    quiet ? '' : 'Tandem Markdown was still busy with the reload when the note was saved; ',
    `the note at the save: ${noteBefore}; `,
    `the save answered ${answer}; `,
    `will-save ${events.willSave}, did-save ${events.didSave}; `,
    `the file ${bytesAfter === bytesBefore ? 'kept its bytes' : 'changed its bytes'} `,
    `and ${timeAfter === timeBefore ? 'its modified time' : 'changed its modified time'}, `,
    `and holds ${which(bytesAfter)}; `,
    coordinator === undefined ? 'no Tandem Markdown coordinator for the note; ' : '',
    `Tandem Markdown's save step ran ${steps} time${steps === 1 ? '' : 's'}; `,
    `notices: ${notices.length === 0 ? 'none' : notices.map((n) => n.notice.kind).join(', ')}`,
  ].join('');
}

factsSuite('Facts: whether VS Code writes a note saved with nothing unsaved', () => {
  teardown(async () => {
    await closeEverything();
  });

  for (const view of ['Source', 'a rich tab'] as const) {
    test(`a clean note in ${view}, saved each way`, async function () {
      this.timeout(180_000);
      note(`VS Code ${vscode.version}; ${settingsInForce()}`);
      for (const [w, way] of WAYS.entries()) {
        for (const timing of ['once the reload is in', 'at once after the checkout'] as const) {
          const name = `${view === 'Source' ? 'source' : 'rich'}-${w}-${timing === 'once the reload is in' ? 'reloaded' : 'checkout'}`;
          note(`${view}, ${way.name}, ${timing}: ${await saveClean(view, way, timing, name)}`);
        }
      }
    });
  }
});
