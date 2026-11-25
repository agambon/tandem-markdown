/// <reference types="mocha" />
// Another program changes a file with unsaved edits twice, the second time on top of the first,
// while VS Code's own Markdown Editor (`vscode.markdown.editor`) is the active tab. The changes
// are found and kept waiting while that tab is active and the window has focus, and merged, each
// line once and with no notice, once the tab is left, the window loses focus, the document is
// saved, or the document has been quiet for OUTSIDE_QUIET_MS. With Tandem Markdown's editor or a
// text editor active they are merged at once. Another extension's edit every TYPING_MS stands in
// for the user typing; the window's focus is set through the test hook, so the operating system's
// focus does not matter. On a VS Code that has no Markdown Editor of its own, the first suite
// skips itself.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { OUTSIDE_QUIET_MS } from '../../src/host/model/outsideHold';
import {
  api,
  closeEverything,
  documentFor,
  lf,
  note,
  openRich,
  openText,
  pause,
  readText,
  waitFor,
  writeFile,
} from './helpers';

const BUILT_IN = 'vscode.markdown.editor';
/** The stand-in typing's pace: a change this often keeps the quiet period from passing. */
const TYPING_MS = 250;
/** How long a change found and held is watched, with typing going on, for not being merged. */
const WATCH_HELD_MS = 2500;
/** Ample time for a merge that is not held (it lands well within this). */
const MERGE_WITHIN_MS = 8000;
/** The extension hears of a typed letter a moment before `applyEdit` resolves here. */
const QUIET_SLACK_MS = 50;
/** How often the held change is looked for in the document while it must stay out. */
const WATCH_STEP_MS = 50;

const SAVED = 'Notes for the week\nTyping goes here.\nA middle line.\nAnother line.\nThe last line.\n';
const OUTSIDE_LINE = 'Written by another program.\n';
const SECOND_LINE = 'Then another line from it.\n';
const THEIRS = SAVED.replace('Another line.\n', `Another line.\n${OUTSIDE_LINE}`);
/** The other program's second write, made on top of its first. */
const THEIRS_TWICE = THEIRS.replace(OUTSIDE_LINE, `${OUTSIDE_LINE}${SECOND_LINE}`);
/** Where the stand-in typing inserts: just before the period of the second line. */
const TYPING_AT = new vscode.Position(1, 'Typing goes here'.length);

interface Typing {
  /** When the last letter's edit was applied (`Date.now()`). */
  readonly lastAt: number;
  /** Stops the typing and resolves with how many letters were typed. */
  stop(): Promise<number>;
}

let typing: Typing | null = null;

/** Types one letter every TYPING_MS into the document, as another extension's edits. */
function startTyping(uri: vscode.Uri): Typing {
  let typed = 0;
  let running = true;
  let lastAt = Date.now();
  const loop = (async () => {
    while (running) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, TYPING_AT, 'x');
      if (await vscode.workspace.applyEdit(edit)) {
        typed++;
        lastAt = Date.now();
      }
      await pause(TYPING_MS);
    }
  })();
  return {
    get lastAt() {
      return lastAt;
    },
    stop: async () => {
      running = false;
      await loop;
      return typed;
    },
  };
}

/** The running VS Code contributes its own Markdown Editor (older versions have none). */
function builtInEditorExists(): boolean {
  const manifest: unknown = vscode.extensions.getExtension('vscode.markdown-language-features')?.packageJSON;
  const editors = (manifest as { contributes?: { customEditors?: unknown } } | undefined)?.contributes?.customEditors;
  return Array.isArray(editors) && editors.some((e) => (e as { viewType?: unknown } | null)?.viewType === BUILT_IN);
}

function activeViewType(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.viewType : undefined;
}

function merged(doc: vscode.TextDocument): boolean {
  const text = lf(doc.getText());
  return text.includes(OUTSIDE_LINE) && text.includes(SECOND_LINE);
}

/**
 * The document holds both outside lines once, where they were written, and the typed letters
 * together where they were typed; nothing was announced.
 */
async function assertBothKept(doc: vscode.TextDocument, typed: number): Promise<void> {
  const text = lf(doc.getText());
  assert.equal(text.split(OUTSIDE_LINE).length, 2, 'the first outside line is in the document once');
  assert.equal(text.split(SECOND_LINE).length, 2, 'the second outside line is in the document once');
  assert.ok(
    text.includes(`Another line.\n${OUTSIDE_LINE}${SECOND_LINE}The last line.\n`),
    'the outside lines are where they were written',
  );
  assert.ok(text.includes(`Typing goes here${'x'.repeat(typed)}.\n`), 'every typed letter is where it was typed');
  assert.deepEqual(
    (await api()).notices().map((n) => n.notice.kind),
    [],
  );
}

/** Opens the file in VS Code's Markdown Editor and waits until the core has its base. */
async function openInBuiltIn(name: string): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument }> {
  const hook = await api();
  const uri = writeFile(name, SAVED);
  await vscode.commands.executeCommand('vscode.openWith', uri, BUILT_IN, { preview: false });
  await waitFor(() => activeViewType() === BUILT_IN, "VS Code's Markdown Editor to be the active tab");
  const doc = documentFor(uri);
  if (!doc) throw new Error(`No document for ${uri.path}`);
  await waitFor(() => hook.coordinatorState(uri)?.base === SAVED, 'the document to find its base');
  return { uri, doc };
}

/**
 * Types, has another program write the file and, once that change is held, write it again on
 * top; then checks that neither reaches the document while typing goes on.
 */
async function writeWhileTypingAndSeeItHeld(name: string, uri: vscode.Uri, doc: vscode.TextDocument): Promise<void> {
  const hook = await api();
  typing = startTyping(uri);
  await waitFor(() => doc.isDirty, 'the typing to make the document unsaved');
  writeFile(name, THEIRS);
  await waitFor(() => (hook.coordinatorState(uri)?.pendings ?? 0) > 0, 'the outside change to be found and held');
  writeFile(name, THEIRS_TWICE);
  const end = Date.now() + WATCH_HELD_MS;
  while (Date.now() < end) {
    assert.ok(!lf(doc.getText()).includes(OUTSIDE_LINE), 'no outside change is merged while the user may be typing');
    assert.equal(activeViewType(), BUILT_IN, "VS Code's Markdown Editor is still the active tab");
    await pause(WATCH_STEP_MS);
  }
}

/**
 * Each test starts with the records cleared and the window focused, and after it the typing stops,
 * the window's focus is VS Code's own again and every editor closes.
 */
function eachTestFresh(): void {
  setup(async () => {
    const hook = await api();
    hook.clearRecords();
    hook.setWindowFocus(true);
  });

  teardown(async () => {
    await typing?.stop();
    typing = null;
    (await api()).setWindowFocus(undefined);
    await closeEverything();
  });
}

suite("An outside change while the user types in VS Code's Markdown Editor", () => {
  suiteSetup(function () {
    if (builtInEditorExists()) return;
    note(`skipped: VS Code ${vscode.version} contributes no custom editor ${BUILT_IN}`);
    this.skip();
  });

  eachTestFresh();

  test('waits while the tab is active and merges once the document has been quiet', async () => {
    const name = 'hold/quiet.md';
    const { uri, doc } = await openInBuiltIn(name);
    await writeWhileTypingAndSeeItHeld(name, uri, doc);
    const typed = await typing!.stop();
    const stoppedAt = typing!.lastAt;
    typing = null;
    await waitFor(() => merged(doc), 'the outside change to be merged after the quiet period', MERGE_WITHIN_MS);
    const quietFor = Date.now() - stoppedAt;
    note(`merged ${quietFor} ms after the last typed letter (quiet period ${OUTSIDE_QUIET_MS} ms)`);
    assert.ok(quietFor >= OUTSIDE_QUIET_MS - QUIET_SLACK_MS, 'not merged before the quiet period passed');
    await assertBothKept(doc, typed);
  });

  test('merges once another tab becomes the active one, while typing goes on', async () => {
    const name = 'hold/tab.md';
    const { uri, doc } = await openInBuiltIn(name);
    await writeWhileTypingAndSeeItHeld(name, uri, doc);
    await openText(writeFile('hold/elsewhere.md', 'Another note.\n'));
    await waitFor(() => merged(doc), 'the outside change to be merged once the tab is left', MERGE_WITHIN_MS);
    await assertBothKept(doc, await typing!.stop());
  });

  test('merges once the window loses focus, while typing goes on', async () => {
    const hook = await api();
    const name = 'hold/focus.md';
    const { uri, doc } = await openInBuiltIn(name);
    await writeWhileTypingAndSeeItHeld(name, uri, doc);
    hook.setWindowFocus(false);
    await waitFor(() => merged(doc), 'the outside change to be merged once focus is lost', MERGE_WITHIN_MS);
    await assertBothKept(doc, await typing!.stop());
  });

  test('merges when the document is saved, while typing goes on, and the save writes it', async () => {
    const name = 'hold/save.md';
    const { uri, doc } = await openInBuiltIn(name);
    await writeWhileTypingAndSeeItHeld(name, uri, doc);
    // save() answers false when a letter lands before it returns, so the file is what shows the
    // save: it holds the typing beside both outside lines only once the merged document is written.
    await doc.save();
    await waitFor(() => {
      const file = readText(uri);
      return file.includes(`${OUTSIDE_LINE}${SECOND_LINE}`) && /Typing goes herex+\./.test(file);
    }, 'the save to write the typing and both outside lines');
    assert.ok(merged(doc), 'the save step merged the outside change into the document');
    await assertBothKept(doc, await typing!.stop());
  });
});

suite("An outside change while the user types in Tandem Markdown's editor or a text editor", () => {
  eachTestFresh();

  for (const editor of ['rich', 'text'] as const) {
    const whose = editor === 'rich' ? "Tandem Markdown's" : 'the text';
    test(`is merged at once, while typing goes on, in ${whose} editor`, async () => {
      const hook = await api();
      const uri = writeFile(`hold/${editor}.md`, SAVED);
      const doc = editor === 'rich' ? await openRich(uri) : (await openText(uri)).document;
      await waitFor(() => hook.coordinatorState(uri)?.base === SAVED, 'the document to find its base');
      typing = startTyping(uri);
      await waitFor(() => doc.isDirty, 'the typing to make the document unsaved');
      writeFile(`hold/${editor}.md`, THEIRS);
      await waitFor(() => lf(doc.getText()).includes(OUTSIDE_LINE), 'the first change to be merged', MERGE_WITHIN_MS);
      writeFile(`hold/${editor}.md`, THEIRS_TWICE);
      await waitFor(() => merged(doc), 'the second change to be merged', MERGE_WITHIN_MS);
      await assertBothKept(doc, await typing.stop());
    });
  }
});
