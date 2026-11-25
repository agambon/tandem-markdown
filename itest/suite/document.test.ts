/// <reference types="mocha" />
// The README's promises about the document, in a real VS Code with the real panel. Each test
// uses its own file and leaves no editor open.

import * as assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import {
  activeTabIsRich,
  activeTextEditorShows,
  api,
  clashInRichTab,
  closeEverything,
  documentFor,
  lf,
  mtime,
  note,
  openRich,
  openText,
  pause,
  readBytes,
  readText,
  recordChanges,
  tabsFor,
  waitFor,
  writeFile,
} from './helpers';

/** How long a file just opened is watched for late work that would dirty or change it (none may). */
const AFTER_OPEN_MS = 800;
/** How long after the close late work is given to show, were there any (the coordinator goes with the document). */
const AFTER_CLOSE_MS = 2500;
/** How long after VS Code reloads the file the panel is watched for a change to its text or selection (none may). */
const AFTER_RELOAD_MS = 1500;

/** A note of four lines after "mine " was typed in its second and another program wrote its fourth. */
const MERGED = 'one\nmine two\nthree\nfour THEIRS\n';

/** Another program writes the note's fourth line while "mine " is unsaved in its second; waits for the merge. */
async function outsideWriteMerged(uri: vscode.Uri, doc: vscode.TextDocument): Promise<void> {
  writeFileSync(uri.fsPath, 'one\ntwo\nthree\nfour THEIRS\n');
  await waitFor(() => lf(doc.getText()) === MERGED, 'the outside write to be merged');
}

/** Saves the merged note: the save goes through with no prompt, writes both changes and raises no notice. */
async function savesWithNoPrompt(uri: vscode.Uri, doc: vscode.TextDocument): Promise<void> {
  assert.equal(await doc.save(), true, 'the save went through (a prompt would refuse it)');
  assert.equal(readText(uri), MERGED);
  assert.equal((await api()).notices().filter((n) => n.uri === uri.toString()).length, 0, 'no notice');
}

suite('Promises', () => {
  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('opening a file in the rich editor and closing it writes nothing (LF and CRLF)', async () => {
    const body =
      '---\ntitle: Open and close\n---\n\n# Heading\n\nA paragraph with trailing spaces   \n\n- one\n- [ ] two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    for (const [name, text] of [
      ['document/open-close-lf.md', body],
      ['document/open-close-crlf.md', body.replace(/\n/g, '\r\n')],
    ] as const) {
      const uri = writeFile(name, text);
      const bytesBefore = readBytes(uri);
      const mtimeBefore = mtime(uri);
      const changes = recordChanges(uri);
      try {
        const doc = await openRich(uri);
        const state = await (await api()).panelState(uri);
        assert.equal(state.text, lf(text), `${name}: the panel holds the file's text`);
        // Long enough for the open check and any late work to happen if it were going to.
        await pause(AFTER_OPEN_MS);
        assert.equal(doc.isDirty, false, `${name}: the document stays clean`);
        await closeEverything();
        await pause(AFTER_CLOSE_MS);
      } finally {
        changes.dispose();
      }
      assert.equal(changes.events.filter((e) => e.dirty).length, 0, `${name}: never dirty`);
      assert.equal(changes.events.filter((e) => e.changes > 0).length, 0, `${name}: no content change`);
      assert.deepEqual(readBytes(uri), bytesBefore, `${name}: bytes unchanged`);
      assert.equal(mtime(uri), mtimeBefore, `${name}: mtime unchanged`);
    }
  });

  test('typing in the panel reaches the document, and saving a CRLF file changes only the typed bytes', async () => {
    const text = 'Line one\r\nLine two has  trailing spaces  \r\n\r\nTabs\there\r\nLast line without newline';
    const uri = writeFile('document/typing-crlf.md', text);
    const doc = await openRich(uri);
    const hook = await api();
    const at = lf(text).indexOf('two');
    await hook.runInPanel(uri, [{ type: 'insert', at, text: 'number ' }]);
    await waitFor(() => lf(doc.getText()).includes('Line number two'), 'the typing to reach the document');
    assert.equal(doc.isDirty, true);
    await vscode.commands.executeCommand('tandemMarkdown.save');
    await waitFor(() => !doc.isDirty, 'the save to finish');
    const crlfAt = text.indexOf('two');
    const expected = text.slice(0, crlfAt) + 'number ' + text.slice(crlfAt);
    assert.equal(readText(uri), expected, 'only the typed bytes changed');
    assert.deepEqual(readBytes(uri), Buffer.from(expected, 'utf8'));
  });

  test('an outside write while the document is clean appears in the panel; unsent typing stays on its line', async () => {
    const uri = writeFile('document/outside-while-clean.md', 'alpha\nbravo\ncharlie\ndelta\n');
    const doc = await openRich(uri);
    const hook = await api();
    const changes = recordChanges(uri);
    try {
      writeFileSync(uri.fsPath, 'alpha\nbravo\ncharlie\nDELTA CHANGED\n');
      // Typed at once and not ending a word, so the panel holds it (up to IDLE_MS) while VS Code reloads.
      await hook.runInPanel(uri, [{ type: 'insert', at: 'alpha\nbravo'.length, text: 'X' }]);
      const want = 'alpha\nbravoX\ncharlie\nDELTA CHANGED\n';
      await waitFor(async () => (await hook.panelState(uri)).text === want, 'the panel to show both');
      await waitFor(() => lf(doc.getText()) === want, 'the document to hold both');
      const reloads = changes.events.filter((e) => e.changes > 0 && !e.dirty && e.reason === undefined).length;
      note(
        reloads > 0
          ? 'VS Code reloaded the clean document while the typing was unsent'
          : 'the typing landed first; the reconciler merged the outside write',
      );
    } finally {
      changes.dispose();
    }
  });

  test('an outside write is merged into unsaved typing in the panel, and saving writes both with no prompt', async () => {
    const uri = writeFile('document/outside-into-panel-typing.md', 'one\ntwo\nthree\nfour\n');
    const doc = await openRich(uri);
    const hook = await api();
    await hook.runInPanel(uri, [{ type: 'insert', at: 'one\n'.length, text: 'mine ' }, { type: 'flush' }]);
    await waitFor(() => doc.isDirty && lf(doc.getText()).includes('mine two'), 'the typing to reach the document');
    await outsideWriteMerged(uri, doc);
    // The panel is told of a merge once VS Code confirms the edit, a moment after the document holds it.
    await waitFor(async () => (await hook.panelState(uri)).text === MERGED, 'the merge to reach the panel');
    await savesWithNoPrompt(uri, doc);
  });

  test('an outside write is merged into unsaved typing in Source, and saving writes both with no prompt', async () => {
    const uri = writeFile('document/outside-into-source-typing.md', 'one\ntwo\nthree\nfour\n');
    const editor = await openText(uri);
    const doc = editor.document;
    await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'mine '));
    assert.equal(doc.isDirty, true);
    await outsideWriteMerged(uri, doc);
    await savesWithNoPrompt(uri, doc);
  });

  test("a conflict keeps the document's text, backs up the file's, and the save writes the document's", async () => {
    const { uri, doc, notice } = await clashInRichTab('document/conflict.md');
    const hook = await api();
    const backupPath = notice.backupPath!;
    assert.equal(lf(doc.getText()), 'The dog sat on the mat.\n', 'the document keeps its text');
    const backups = vscode.Uri.joinPath(hook.globalStorageUri, 'outside-versions').fsPath.toLowerCase();
    assert.ok(backupPath.toLowerCase().startsWith(backups), `the backup is under global storage: ${backupPath}`);
    assert.equal(
      readText(vscode.Uri.file(backupPath)),
      'The cow sat on the mat.\n',
      "the backup holds the file's version",
    );
    assert.equal(await doc.save(), true);
    assert.equal(readText(uri), 'The dog sat on the mat.\n', "the save writes the document's text");
  });

  test('a line-ending flip on disk changes nothing in the panel and raises nothing', async () => {
    const text = 'first\nsecond\nthird\n';
    const uri = writeFile('document/line-ending-flip.md', text);
    const doc = await openRich(uri);
    const hook = await api();
    await hook.runInPanel(uri, [{ type: 'select', anchor: 8, head: 10 }]);
    const before = await hook.panelState(uri);
    writeFileSync(uri.fsPath, text.replace(/\n/g, '\r\n'));
    await waitFor(() => doc.eol === vscode.EndOfLine.CRLF, 'VS Code to reload the file with its new line endings');
    await pause(AFTER_RELOAD_MS);
    const after = await hook.panelState(uri);
    assert.equal(after.text, before.text);
    assert.deepEqual(after.selection, before.selection);
    assert.equal(after.version, before.version, 'nothing was logged');
    assert.equal(doc.isDirty, false);
    assert.equal(hook.notices().length, 0, 'no notice');
  });

  test('undo and redo act on the document, and undo in Source undoes panel typing', async () => {
    const uri = writeFile('document/undo-redo.md', 'first line\n');
    const doc = await openRich(uri);
    const hook = await api();
    await hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'hello ' }, { type: 'flush' }]);
    await waitFor(() => lf(doc.getText()) === 'hello first line\n', 'the typing to reach the document');
    await vscode.commands.executeCommand('tandemMarkdown.undo');
    await waitFor(() => lf(doc.getText()) === 'first line\n', 'undo');
    await waitFor(async () => (await hook.panelState(uri)).text === 'first line\n', 'the panel to follow the undo');
    await vscode.commands.executeCommand('tandemMarkdown.redo');
    await waitFor(() => lf(doc.getText()) === 'hello first line\n', 'redo');
    await hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'again ' }, { type: 'flush' }]);
    await waitFor(() => lf(doc.getText()) === 'again hello first line\n', 'more typing');
    await vscode.commands.executeCommand('tandemMarkdown.showSource');
    await waitFor(() => activeTextEditorShows(uri), 'Source');
    await vscode.commands.executeCommand('undo');
    await waitFor(() => lf(doc.getText()) === 'hello first line\n', 'undo in Source');
  });

  for (const dirty of [false, true]) {
    const kind = dirty ? 'dirty' : 'clean';
    test(`Source to Rich editor to Source keeps the text and the selection, with the document ${kind}`, async () => {
      const uri = writeFile(`document/switch-${kind}.md`, '# Title\n\nalpha beta gamma\ndelta epsilon\n\nlast\n');
      const editor = await openText(uri);
      const doc = editor.document;
      const hook = await api();
      if (dirty) await editor.edit((b) => b.insert(new vscode.Position(5, 0), 'unsaved '));
      assert.equal(doc.isDirty, dirty);
      const textBefore = doc.getText();
      editor.selection = new vscode.Selection(2, 6, 2, 10); // "beta"
      const anchor = lf(textBefore).indexOf('beta');

      await vscode.commands.executeCommand('tandemMarkdown.showRichEditor');
      await hook.whenPanelLive(uri);
      await waitFor(() => activeTabIsRich(uri), 'the rich editor to be the active tab');
      const state = await hook.panelState(uri);
      assert.equal(state.text, lf(textBefore));
      assert.equal(state.mode, 'edit');
      assert.deepEqual(state.selection, { anchor, head: anchor + 4 }, 'the selection came across');
      assert.equal(tabsFor(uri).length, 1, 'the tab was replaced, not duplicated');
      assert.equal(doc.isDirty, dirty);

      // A new selection in the panel, carried back to Source.
      const head = lf(textBefore).indexOf('epsilon');
      await hook.runInPanel(uri, [{ type: 'select', anchor: head, head: head + 7 }]);
      await waitFor(
        () => hook.coordinatorState(uri)?.panels.some((p) => p.viewState?.selection.anchor === head) ?? false,
        'the panel to report its selection',
      );
      await vscode.commands.executeCommand('tandemMarkdown.showSource');
      await waitFor(() => activeTextEditorShows(uri), 'Source');
      const back = vscode.window.activeTextEditor!;
      assert.equal(back.document.getText(), textBefore, 'the text is unchanged');
      assert.ok(
        back.selection.isEqual(new vscode.Selection(3, 6, 3, 13)),
        `the selection came back: ${JSON.stringify(back.selection)}`,
      );
      assert.equal(tabsFor(uri).length, 1);
      assert.equal(doc.isDirty, dirty, 'nothing was saved');
    });
  }

  test('Switch View goes Source, Rich editor, Rich view, Source, in one tab', async () => {
    const uri = writeFile('document/switch-cycle.md', '# Cycle\n\ntext\n');
    await openText(uri);
    const hook = await api();
    await vscode.commands.executeCommand('tandemMarkdown.switchView');
    await hook.whenPanelLive(uri);
    await waitFor(() => activeTabIsRich(uri), 'the rich editor');
    assert.equal(
      (await hook.panelState(uri)).mode,
      'edit',
      'first the default rich view (tandemMarkdown.defaultRichMode)',
    );
    await vscode.commands.executeCommand('tandemMarkdown.switchView');
    await waitFor(async () => (await hook.panelState(uri)).mode === 'view', 'Rich view');
    await vscode.commands.executeCommand('tandemMarkdown.switchView');
    await waitFor(() => activeTextEditorShows(uri), 'Source');
    assert.equal(tabsFor(uri).length, 1);
  });

  test('two views of one document stay in step both ways', async () => {
    const uri = writeFile('document/two-views.md', 'top\nmiddle\nbottom\n');
    const editor = await openText(uri, vscode.ViewColumn.One);
    const doc = editor.document;
    await openRich(uri, vscode.ViewColumn.Two);
    const hook = await api();
    await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'from source '));
    await waitFor(
      async () => (await hook.panelState(uri)).text === lf(doc.getText()),
      'the panel to follow the text editor',
    );
    assert.equal(lf(doc.getText()), 'top\nfrom source middle\nbottom\n');
    await hook.runInPanel(uri, [{ type: 'insert', at: 'top\n'.length, text: 'from panel ' }, { type: 'flush' }]);
    await waitFor(
      () => lf(doc.getText()) === 'top\nfrom panel from source middle\nbottom\n',
      'the text editor to follow the panel',
    );
    assert.equal((await hook.panelState(uri)).text, lf(doc.getText()));
    assert.equal(documentFor(uri), doc);
  });
});
