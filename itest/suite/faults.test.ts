/// <reference types="mocha" />
// Faults the core's simulation cannot reach, in a real VS Code: a read-only document, the
// content policy, a panel script that fails to start or fails after its init, a language
// change, a document that closes, a file in an encoding the core cannot read, and commands that
// wait for the document's lock.

import * as assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activeTabIsRich,
  activeTextEditorShows,
  api,
  closeEverything,
  documentFor,
  lf,
  note,
  openRich,
  openText,
  pause,
  readText,
  setSetting,
  tabsFor,
  VIEW_TYPE,
  waitFor,
  workspaceDir,
  writeFile,
} from './helpers';

/** How long a refused command or edit is given to change the document or the panel; neither may change. */
const NOTHING_HAPPENS_MS = 800;
/** How long the code languages are given to load on demand, and a refusal of one to be reported. */
const LANGUAGES_MS = 2000;
/** Longer than any timer the core keeps for a document (CLOSE_LINGER_MS in coordinator.ts, RETRY_MS in reconcile.ts). */
const CORE_TIMERS_MS = 3000;
/** How long the outside-change check at opening is given to run and say something; it must say nothing. */
const OPENING_CHECK_MS = 1500;
/** How long the check after a save is given to run and say something; it must say nothing. */
const SAVE_CHECK_MS = 800;
/** How long after the first notice a second is given to come; none may. */
const NO_SECOND_NOTICE_MS = 1500;
/** Long enough for both commands to flush the panel and reach the lock they wait on. */
const TO_THE_LOCK_MS = 500;

suite('Faults', () => {
  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    (await api()).setPanelScript(undefined);
    await closeEverything();
  });

  test('a read-only document (another scheme) opens in Rich view and refuses edits', async () => {
    const text = '# Read only\n\nSome text.\n';
    const provider = vscode.workspace.registerTextDocumentContentProvider('tmtest', {
      provideTextDocumentContent: () => text,
    });
    try {
      const uri = vscode.Uri.parse('tmtest:/faults/readonly.md');
      const hook = await api();
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
      await hook.whenPanelLive(uri);
      const state = await hook.panelState(uri);
      assert.equal(state.mode, 'view', 'it opens in Rich view');
      assert.equal(state.text, text);
      const coordinator = hook.coordinatorState(uri)!;
      assert.equal(coordinator.readOnly, true);
      assert.equal(coordinator.reconciled, false, 'no outside-change checks for a virtual document');

      // The view commands keep it in Rich view.
      await vscode.commands.executeCommand('tandemMarkdown.showRichEditor');
      await pause(NOTHING_HAPPENS_MS);
      assert.equal((await hook.panelState(uri)).mode, 'view');

      // The panel refuses typing in Rich view, and stays in Rich view when told to change.
      const typed = await hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'x' }]);
      assert.ok(typed.error, 'the panel refused the edit');
      const forced = await hook.runInPanel(uri, [
        { type: 'setMode', mode: 'edit' },
        { type: 'insert', at: 0, text: 'forced ' },
      ]);
      assert.equal(forced.mode, 'view');
      assert.ok(forced.error, 'the panel refused the edit after a setMode');
      await pause(NOTHING_HAPPENS_MS);
      assert.equal((await hook.panelState(uri)).text, text);
      assert.equal(documentFor(uri)?.getText(), text, 'the document never changed');
      assert.equal(documentFor(uri)?.isDirty, false);
    } finally {
      provider.dispose();
    }

    // What VS Code reports for a file with the read-only attribute (for the report).
    const locked = writeFile('faults/locked.md', '# locked\n');
    chmodSync(locked.fsPath, 0o444);
    try {
      const stat = await vscode.workspace.fs.stat(locked);
      note(
        `workspace.fs.stat permissions for a read-only-attribute file: ${String(stat.permissions)}; isWritableFileSystem('file') = ${String(vscode.workspace.fs.isWritableFileSystem('file'))}`,
      );
    } finally {
      chmodSync(locked.fsPath, 0o666);
    }
  });

  test('a file with a fenced js block loads with no content-policy violation', async () => {
    const uri = writeFile(
      'faults/content-policy.md',
      '# Code\n\n```js\nconst answer = 42;\nfunction hello(name) {\n  return `hi ${name}`;\n}\n```\n\n```python\nprint("x")\n```\n\n<script>alert(1)</script>\n\n![remote](http://example.com/a.png)\n',
    );
    await openRich(uri);
    const hook = await api();
    // The code languages load on demand: watch for a refusal while they arrive.
    let state = await hook.panelState(uri);
    for (const end = Date.now() + LANGUAGES_MS; Date.now() < end && state.cspViolations.length === 0;) {
      await pause(100);
      state = await hook.panelState(uri);
    }
    note(`widgets drawn: ${state.widgets.join(', ') || 'none'}`);
    assert.deepEqual(state.cspViolations, [], 'no content-policy violation');
  });

  // A change of language mode is not a close: the note keeps its coordinator and its checks.
  test('a language change while the panel is open keeps the note and its checks, and it keeps working', async () => {
    const uri = writeFile('faults/language-change.md', 'language\n');
    const doc = await openRich(uri);
    const hook = await api();
    assert.equal(hook.coordinatorState(uri)?.reconciled, true);
    hook.clearRecords();
    await vscode.languages.setTextDocumentLanguage(doc, 'plaintext');
    // Past the time a close that no open follows would take to let the coordinator go.
    await pause(CORE_TIMERS_MS);
    assert.equal(hook.coordinatorState(uri)?.reconciled, true, 'the note keeps its outside-change checks');
    assert.deepEqual(
      hook.notices().map((n) => n.notice.kind),
      [],
      'nothing is said, as nothing closed',
    );
    await hook.whenPanelLive(uri);
    await hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'plain ' }, { type: 'flush' }]);
    await waitFor(() => doc.getText() === 'plain language\n', 'typing to reach the document after the change');
    await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await pause(CORE_TIMERS_MS);
    assert.equal(hook.coordinatorState(uri)?.reconciled, true);
    await waitFor(
      async () => (await hook.panelState(uri)).text === 'plain language\n',
      'the panel to show the document',
    );
  });

  test('a panel whose script fails to start shows the failure page, and Show Source works', async () => {
    const hook = await api();
    hook.setPanelScript(vscode.Uri.file(path.join(workspaceDir(), 'broken-main.js')));
    const uri = writeFile('faults/broken-script.md', '# Broken\n');
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
    await waitFor(() => hook.startFailures(uri).length > 0, 'the failure page to report');
    note(`the guard reported: ${hook.startFailures(uri)[0]?.split('\n')[0]}`);
    const page = await hook.runInPanel(uri, [{ type: 'click', target: 'showSource' }]);
    assert.equal(page.failurePage, true);
    assert.match(String((page as { text?: string }).text), /Tandem Markdown could not start in this tab\./);
    await waitFor(() => activeTextEditorShows(uri), 'Show Source to open the text editor');
    assert.equal(vscode.window.activeTextEditor?.document.getText(), '# Broken\n');
  });

  // The core releases the failed panel at once, so nothing waits on a page that cannot answer.
  test("a panel that fails after its init does not block another panel's undo, and Show Source works", async () => {
    const hook = await api();
    hook.setPanelScript(vscode.Uri.file(path.join(workspaceDir(), 'fails-after-init.js')));
    const uri = writeFile('faults/fails-after-init.md', 'one two\n');
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await waitFor(() => hook.startFailures(uri).length > 0, 'the failure page to report');
    await waitFor(
      () => hook.coordinatorState(uri)?.panels.every((p) => !p.live) === true,
      'the core to release the failed panel',
    );
    const started = Date.now();
    assert.equal(await hook.flush(uri), true, 'a flush does not wait on the failed page');
    note(`a flush with the failed page open answered in ${Date.now() - started} ms`);

    // A working panel of the same file beside it, with an edit to undo.
    hook.setPanelScript(undefined);
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
    });
    await waitFor(() => hook.coordinatorState(uri)?.panels.some((p) => p.live) === true, 'the second panel to start');
    const doc = documentFor(uri)!;
    await hook.runInPanel(
      uri,
      [{ type: 'insert', at: 'one '.length, text: 'and ' }, { type: 'flush' }],
      vscode.ViewColumn.Two,
    );
    await waitFor(() => lf(doc.getText()) === 'one and two\n', 'the typing to reach the document');
    await vscode.commands.executeCommand('tandemMarkdown.undo');
    await waitFor(() => lf(doc.getText()) === 'one two\n', 'the undo from the working panel to run');

    // The failure page's own button.
    await hook.runInPanel(uri, [{ type: 'click', target: 'showSource' }], vscode.ViewColumn.One);
    await waitFor(
      () => activeTextEditorShows(uri) && vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.One,
      'Show Source to replace the failed panel with the text editor',
    );
  });

  // The core releases a document the moment it closes.
  test('after a document closes, an outside write is read by nobody and no edit reaches the file', async () => {
    const hook = await api();
    const uri = writeFile('faults/closed-document.md', 'first line\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => hook.coordinatorState(uri)?.base === 'first line\n', 'the opening read');
    const doc = documentFor(uri)!;
    let atClose: unknown = 'the close was not seen';
    const sub = vscode.workspace.onDidCloseTextDocument((d) => {
      // The extension's own listener ran first (it was registered at activation).
      if (d === doc) atClose = hook.coordinatorState(uri);
    });
    try {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => doc.isClosed, 'the document to close', 20_000);
    } finally {
      sub.dispose();
    }
    assert.equal(atClose, undefined, 'the coordinator was gone by the time the close event reached others');
    hook.clearRecords();
    const theirs = 'first line\nsecond line from another program\n';
    writeFile('faults/closed-document.md', theirs);
    await pause(CORE_TIMERS_MS);
    const copy = documentFor(uri);
    assert.ok(
      !copy || (!copy.isDirty && lf(copy.getText()) === theirs),
      'no hidden copy of the file with an edit in it',
    );
    assert.equal(readText(uri), theirs, 'the file is as the other program wrote it');
    assert.deepEqual(
      hook
        .logLines()
        .filter((l) => l.message.includes('closed-document.md') && /Merging|check starts/.test(l.message))
        .map((l) => l.message),
      [],
      'no check ran and nothing was merged',
    );
  });

  // A note shown in a rich tab with no outside-change checks (another language) that turns markdown
  // gains a coordinator with them, and its tab starts again on it.
  test('a language change while a panel cannot send its typing reloads it, saying the typing may be lost', async () => {
    const hook = await api();
    // Not markdown, and not a .txt file: shown in a rich tab, it has no outside-change checks.
    const uri = writeFile('faults/language-change-unsent.notes', 'language\n');
    hook.setPanelScript(vscode.Uri.file(path.join(workspaceDir(), 'silent-after-init.js')));
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: false });
    await waitFor(
      () => hook.coordinatorState(uri)?.panels.some((p) => p.live) === true,
      'the panel to be sent its init',
    );
    assert.equal(hook.coordinatorState(uri)?.reconciled, false);
    const doc = documentFor(uri)!;
    hook.clearRecords();
    await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    // Two flushes go unanswered (FLUSH_WAIT_MS each), then the panel is reloaded on a new coordinator.
    await waitFor(() => hook.coordinatorState(uri)?.reconciled === true, 'the new coordinator', 20_000);
    const said = hook.logLines().filter((l) => l.message.includes('had not been sent when the language changed'));
    note(`after the language change: ${said.map((l) => l.message).join('; ') || 'nothing was said'}`);
    assert.equal(said.length, 1, 'the user is told the last edit was not sent');
  });

  // Opening and saving it raise no notice; an outside change is announced once and not merged.
  test('a file in an encoding the core cannot read saves with no notice, and an outside change is announced', async () => {
    const hook = await api();
    const restore = await setSetting('files', 'encoding', 'windows1252');
    try {
      const uri = writeFile('faults/windows-1252.md', Buffer.from('Café notes\n', 'latin1'));
      const editor = await openText(uri);
      const doc = editor.document;
      note(`VS Code holds the file as ${String((doc as { encoding?: unknown }).encoding)}`);
      assert.equal(lf(doc.getText()), 'Café notes\n');
      await pause(OPENING_CHECK_MS);
      for (let i = 1; i <= 3; i++) {
        await editor.edit((b) => b.insert(new vscode.Position(0, 0), `${i} `));
        assert.equal(await doc.save(), true);
        await pause(SAVE_CHECK_MS);
      }
      const mine = () => hook.notices().filter((n) => n.uri === uri.toString());
      assert.deepEqual(
        mine().map((n) => n.notice.kind),
        [],
        'nothing announced at opening or at three saves',
      );

      await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'unsaved '));
      writeFile('faults/windows-1252.md', Buffer.from('Another program\n', 'latin1'));
      await waitFor(() => mine().length > 0, 'the outside change to be announced');
      await pause(NO_SECOND_NOTICE_MS);
      assert.deepEqual(
        mine().map((n) => (n.notice.kind === 'conflict' ? n.notice.reason : n.notice.kind)),
        ['encoding'],
      );
      assert.equal(lf(doc.getText()), 'unsaved 3 2 1 Café notes\n', 'nothing was merged');
    } finally {
      await restore();
    }
  });

  test("a view switch or undo that waited for the document's lock does nothing once its panel is not active", async () => {
    const hook = await api();
    const a = writeFile('faults/lock-a.md', 'alpha\n');
    const b = writeFile('faults/lock-b.md', 'bravo\n');
    await openRich(a, vscode.ViewColumn.One);
    const docB = await openRich(b, vscode.ViewColumn.Two);
    await hook.runInPanel(b, [{ type: 'insert', at: 0, text: 'typed ' }, { type: 'flush' }]);
    await waitFor(() => lf(docB.getText()) === 'typed bravo\n', 'the typing in B to reach its document');

    // A's panel is the active editor, and A's lock is held, as a save holds it.
    await vscode.commands.executeCommand('vscode.openWith', a, VIEW_TYPE, { viewColumn: vscode.ViewColumn.One });
    await waitFor(() => activeTabIsRich(a), 'A to be the active editor');
    const release = hook.holdDocument(a);
    const switching = vscode.commands.executeCommand('tandemMarkdown.showSource');
    const undoing = vscode.commands.executeCommand('tandemMarkdown.undo');
    await pause(TO_THE_LOCK_MS);
    // The user moves to B before the lock is free.
    await vscode.commands.executeCommand('vscode.openWith', b, VIEW_TYPE, { viewColumn: vscode.ViewColumn.Two });
    await waitFor(() => activeTabIsRich(b), 'B to be the active editor');
    release();
    await Promise.all([switching, undoing]);
    await pause(NOTHING_HAPPENS_MS);
    assert.ok(
      tabsFor(b).every((t) => t.input instanceof vscode.TabInputCustom),
      'B is still in the rich editor',
    );
    assert.equal(lf(docB.getText()), 'typed bravo\n', "B's typing was not undone");
    assert.ok(
      tabsFor(a).every((t) => t.input instanceof vscode.TabInputCustom),
      'A was not switched either: the user had moved on',
    );
    assert.deepEqual(
      hook
        .logLines()
        .filter((l) => /^The command tandemMarkdown\.\w+ failed/.test(l.message))
        .map((l) => `${l.message} ${l.detail ?? ''}`),
      [],
      'no command failed',
    );
  });
});
