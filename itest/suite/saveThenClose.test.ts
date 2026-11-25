/// <reference types="mocha" />
// Typing that reaches the note while a save waits on another extension's will-save step, with
// that extension closing the tab the moment the save is reported, and no input in the tab: the
// typing is in the file. VS Code takes the save's text once every will-save listener has finished
// (1.146: doSaveSequential reads versionId and createSnapshot together after
// runSaveParticipants), and closes a note it holds clean without asking, disposing its model in
// the same task (TextFileEditorModelManager.canDispose), so an edit that arrives after that close
// is refused.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { api, closeEverything, lf, openRich, readText, waitFor, writeFile } from './helpers';

suite('A close right after a save', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('keeps typing sent while the save waited on another extension', async () => {
    const uri = writeFile('document/save-then-close.md', 'one\n');
    const doc = await openRich(uri);
    const hook = await api();
    await hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'first ' }, { type: 'flush' }]);
    await waitFor(() => lf(doc.getText()) === 'first one\n', 'the first typing to reach the note');

    // Another extension: a will-save step during which the rich tab is typed in (Tandem Markdown's
    // own step, registered at activation, has ended by then), and a did-save listener that closes
    // the tab at once.
    const subscriptions = [
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document !== doc) return;
        e.waitUntil(
          hook
            .runInPanel(uri, [{ type: 'insert', at: 'first '.length, text: 'during ' }, { type: 'flush' }])
            .then(() => undefined),
        );
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved === doc) void vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }),
    ];
    try {
      assert.equal(await doc.save(), true, 'the save went through');
      await waitFor(() => doc.isClosed, 'the note to close', 20_000);
    } finally {
      for (const s of subscriptions) s.dispose();
    }
    assert.equal(readText(uri), 'first during one\n', 'the typing sent during the save is in the file');
  });
});
