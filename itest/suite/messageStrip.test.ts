/// <reference types="mocha" />
// The message strip in a real VS Code. A clash in a rich tab shows its message as a pop-up only,
// with See Diff and Dismiss, and no strip. See Diff opens the diff, whose title bar's Use Change
// from Disk puts the change in; the reply, with its Undo, stays in the strip at the top of the tab.
// Dismiss in the strip takes the reply away and leaves the note as it is. Each test uses its own
// note in a folder of its own and deletes what it wrote.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DISMISS, SEE_DIFF, appliedText, conflictText } from '../../src/host/model/messageForms';
import { api, clashInRichTab, deletedAfterEach, lf, waitFor } from './helpers';

const NAME = 'Field notes.md';
const USED = 'The cow sat on the mat.\n';

/** What the strip of the note's rich tab shows. */
async function strip(uri: vscode.Uri): Promise<{ text: string; buttons: string[] } | null> {
  return (await (await api()).panelState(uri)).messageStrip;
}

/** A clash in a rich tab, its diff opened from See Diff and its change put in from the diff's title bar. */
async function changeUsed(name: string, written: string[]) {
  const hook = await api();
  const { uri, doc, notice } = await clashInRichTab(name);
  written.push(uri.fsPath, `${uri.fsPath}.conflict`);
  await waitFor(() => hook.askedFor(notice.id) !== undefined, 'the message');
  assert.equal(hook.askedFor(notice.id)!.text, conflictText(NAME, notice));
  assert.deepEqual(hook.askedFor(notice.id)!.items, [SEE_DIFF, DISMISS]);
  assert.equal(await strip(uri), null, 'a clash has no strip');
  assert.ok(hook.answerNotice(notice.id, SEE_DIFF));
  await waitFor(
    () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
    'the diff',
  );
  await vscode.commands.executeCommand('tandemMarkdown.useChangeFromDisk');
  await waitFor(() => lf(doc.getText()) === USED, 'its change in the note');
  return { uri, doc };
}

suite('The message strip', () => {
  const written = deletedAfterEach();

  test('a clash has no strip, and the reply to Use Change from Disk stays in it with Undo', async () => {
    const hook = await api();
    const { uri } = await changeUsed(`message-strip/use/${NAME}`, written);
    const expected = appliedText(NAME, {
      kind: 'applied',
      id: '',
      how: 'useChoice',
      backupPath: null,
      previousText: null,
      diskBackupPath: null,
      canUndo: true,
    });
    await waitFor(async () => (await strip(uri))?.text === expected, 'the reply in the strip');
    assert.deepEqual((await strip(uri))?.buttons, ['Undo', SEE_DIFF, DISMISS]);
    await hook.runInPanel(uri, [{ type: 'pressMessage', label: DISMISS }]);
    await waitFor(async () => (await strip(uri)) === null, 'strip dismissed after test');
  });

  test('Dismiss in the strip takes the message away and leaves the note as it is', async () => {
    const hook = await api();
    const { uri, doc } = await changeUsed(`message-strip/dismiss/${NAME}`, written);
    await waitFor(async () => (await strip(uri)) !== null, 'the reply in the strip');
    await hook.runInPanel(uri, [{ type: 'pressMessage', label: DISMISS }]);
    await waitFor(async () => (await strip(uri)) === null, 'the message to leave the strip');
    assert.equal(lf(doc.getText()), USED, 'the note is as it was');
  });

  test('Go to Waiting Message brings back the rich tab holding the waiting strip', async () => {
    const hook = await api();
    const { uri } = await changeUsed(`message-strip/goto/${NAME}`, written);
    await waitFor(async () => (await strip(uri)) !== null, 'the reply in the strip');
    assert.ok(
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
      'diff tab is active before Go to Waiting Message',
    );
    await vscode.commands.executeCommand('tandemMarkdown.showWaitingMessage');
    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.uri.toString() === uri.toString();
    }, 'Go to Waiting Message to reveal the rich tab');
    await hook.runInPanel(uri, [{ type: 'pressMessage', label: DISMISS }]);
    await waitFor(async () => (await strip(uri)) === null, 'strip dismissed after test');
  });
});
