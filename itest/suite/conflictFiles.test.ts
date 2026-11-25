/// <reference types="mocha" />
// Conflict files in a real VS Code. A clash writes the note's `.conflict` file and a warning in
// the Problems list where the passage is; opening the diff via See Diff and settling with
// Use Change from Disk removes both the `.conflict` file and the warning. Deleting the `.conflict`
// file manually takes the warning away and leaves the note untouched. Each test uses its own note
// in a folder of its own and deletes what it wrote.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as vscode from 'vscode';
import { PROBLEMS_SOURCE } from '../../src/host/model/conflictFile';
import { DISMISS, SEE_DIFF, conflictText } from '../../src/host/model/messageForms';
import { api, clashInRichTab, deletedAfterEach, lf, note, waitFor } from './helpers';

const ours = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === PROBLEMS_SOURCE);

suite('Conflict files', () => {
  const written = deletedAfterEach();

  test('a clash writes the conflict file and a warning, and settling via the diff removes both', async () => {
    const hook = await api();
    const { uri, doc, notice: clash } = await clashInRichTab('conflict-files/clash/Field notes.md');
    const conflictFile = `${uri.fsPath}.conflict`;
    written.push(uri.fsPath, conflictFile);
    assert.equal(clash.reason, 'clash');

    await waitFor(() => existsSync(conflictFile), 'the conflict file');
    const text = readFileSync(conflictFile, 'utf8');
    note(text);
    assert.ok(text.startsWith('# Unsettled changes to "Field notes.md"\n'), 'the file is for this note');
    assert.ok(text.includes('## 1. Overlapping edits ('), 'the clash part');
    assert.ok(text.includes('User kept:\n```\nThe dog sat on the mat.\n```'), 'the passage as the user had it');
    assert.ok(
      text.includes('Your version on disk:\n```\nThe cow sat on the mat.\n```'),
      'the passage as the other program wrote it',
    );

    await waitFor(() => ours(uri).length === 1, 'the warning in the Problems list');
    assert.equal(ours(uri)[0]!.message, 'Both you and another program edited here; your text was kept.');
    assert.equal(ours(uri)[0]!.severity, vscode.DiagnosticSeverity.Warning);

    await waitFor(() => hook.askedFor(clash.id) !== undefined, 'the message');
    const asked = hook.askedFor(clash.id)!;
    note(asked.text);
    assert.equal(asked.text, conflictText('Field notes.md', clash));
    assert.deepEqual(asked.items, [SEE_DIFF, DISMISS]);
    assert.ok(hook.answerNotice(clash.id, SEE_DIFF), 'See Diff opens the comparison');
    await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
      'the diff tab',
    );
    await vscode.commands.executeCommand('tandemMarkdown.useChangeFromDisk');
    await waitFor(() => lf(doc.getText()) === 'The cow sat on the mat.\n', 'its change in the note');
    await waitFor(() => !existsSync(conflictFile), 'the conflict file to go with its last part');
    await waitFor(() => ours(uri).length === 0, 'the warning to go');
    await waitFor(async () => (await hook.panelState(uri)).messageStrip !== null, 'the applied reply in the strip');
    await hook.runInPanel(uri, [{ type: 'pressMessage', label: DISMISS }]);
    await waitFor(async () => (await hook.panelState(uri)).messageStrip === null, 'strip dismissed after test');
  });

  test('deleting the conflict file takes the warning away and changes nothing in the note', async () => {
    const { uri, doc } = await clashInRichTab('conflict-files/delete/Field notes.md');
    const conflictFile = `${uri.fsPath}.conflict`;
    written.push(uri.fsPath, conflictFile);
    await waitFor(() => existsSync(conflictFile) && ours(uri).length === 1, 'the conflict file and its warning');
    rmSync(conflictFile);
    await waitFor(() => ours(uri).length === 0, 'the warning to go with the file');
    assert.equal(lf(doc.getText()), 'The dog sat on the mat.\n', 'the note is left as it was');
    assert.equal(existsSync(conflictFile), false, 'the file is not written again');
  });
});
