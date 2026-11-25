/// <reference types="mocha" />
// A revert takes a note back to its saved text, so the core counts a close VS Code makes without
// asking after it as one that may cut typing off. "Don't Save" is VS Code reverting the note and
// closing it: typing that reached the note goes with it, and nothing is told. Typing sent after a
// Revert File that the close cuts off is kept and told. VS Code's own question cannot be answered
// from a test, so "Revert and Close Editor", the revert and the close it makes, stands in for it.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { CoreNotice } from '../../src/core/reconcile/types';
import { api, deletedAfterEach, holdsWithin, lf, openRich, readText, waitFor, writeFile } from './helpers';

type TypingNotice = Extract<CoreNotice, { kind: 'typingAtClose' }>;

const TEXT = 'Pack the tent.\n';
/** How long to watch for a message that must not come. */
const QUIET_MS = 2000;

async function typingNotice(uri: vscode.Uri): Promise<TypingNotice | undefined> {
  return (await api())
    .notices()
    .find(
      (n): n is { notice: TypingNotice; uri: string } => n.notice.kind === 'typingAtClose' && n.uri === uri.toString(),
    )?.notice;
}

suite('A revert, and a close after it', () => {
  const written = deletedAfterEach();

  test('"Don\'t Save" after typing that reached the note tells nothing and writes nothing', async () => {
    const hook = await api();
    hook.clearRecords();
    const uri = writeFile('revert/Dont save.md', TEXT);
    const doc = await openRich(uri);
    await hook.runInPanel(uri, [{ type: 'insert', at: TEXT.length, text: 'typed ' }]);
    await waitFor(() => doc.isDirty && lf(doc.getText()) === `${TEXT}typed `, 'the typing to reach the note');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await waitFor(() => doc.isClosed, 'VS Code to revert and close the note');
    assert.equal(await holdsWithin(QUIET_MS, async () => (await typingNotice(uri)) !== undefined), false, 'no message');
    assert.equal(readText(uri), TEXT, 'nothing was written to the file');
  });

  test('typing sent after Revert File that the close cuts off is kept in a backup and told', async () => {
    const hook = await api();
    hook.clearRecords();
    const uri = writeFile('revert/After revert.md', TEXT);
    const doc = await openRich(uri);
    await hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'unsaved ' }]);
    await waitFor(() => doc.isDirty, 'the first typing to reach the note');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitFor(() => !doc.isDirty && lf(doc.getText()) === TEXT, 'VS Code to revert the note');
    const release = hook.holdDocument(uri);
    try {
      await hook.runInPanel(uri, [{ type: 'insert', at: TEXT.length, text: 'after ' }]);
      await waitFor(() => hook.coordinatorState(uri)?.unapplied === 1, 'the push to reach the core');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => doc.isClosed, 'VS Code to close the note, which held nothing unsaved');
    } finally {
      release();
    }
    let notice: TypingNotice | undefined;
    await waitFor(async () => (notice = await typingNotice(uri)) !== undefined, 'the message about the typing');
    assert.ok(notice!.backupPath !== null, 'the copy is in a backup');
    written.push(notice!.backupPath);
    assert.equal(lf(readFileSync(notice!.backupPath, 'utf8')), `${TEXT}after `);
    assert.equal(readText(uri), TEXT, 'nothing was written to the file');
  });
});
