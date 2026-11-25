/// <reference types="mocha" />
// Backups in a real VS Code: a backup's file name says whose text it holds, and Compare with
// Backup lists a note's backups, newest first, and opens the one chosen beside the note, read-only
// on the left, with a title naming both sides. The backups button stays on the note's tab bar,
// the one chosen opened or not, until "Done with these backups". Each test uses its own note and
// leaves no editor open; the backups it writes by hand are deleted again.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CoreNotice } from '../../src/core/coordinator';
import type { CompareWithBackupResult } from '../../src/host/backupViews';
import { DONE_ROW } from '../../src/host/model/backupViews';
import { api, clashInRichTab, deletedAfterEach, diffTab, lf, openText, waitFor, writeFile } from './helpers';

/**
 * Runs Compare with Backup for `uri`, choosing the row at `pick` of the list, or its last row,
 * "Done with these backups", for 'done' (none: choosing nothing).
 */
async function compareWithBackup(uri: vscode.Uri, pick?: number | 'done'): Promise<CompareWithBackupResult> {
  (await api()).answerPrompts((prompt) => {
    if (pick === 'done') return prompt.buttons.find((row) => row.startsWith(DONE_ROW.label));
    return pick === undefined ? undefined : prompt.buttons[pick];
  });
  return vscode.commands.executeCommand<CompareWithBackupResult>('tandemMarkdown.compareWithBackup', uri);
}

suite('Backups and Compare with Backup', () => {
  const written = deletedAfterEach();

  suiteTeardown(async () => {
    (await api()).answerPrompts(undefined);
  });

  test('a note with no backups says so', async () => {
    const uri = writeFile('backups/Nothing kept.md', 'Some text.\n');
    await openText(uri);
    const r = await compareWithBackup(uri);
    assert.equal(r.message, 'Nothing kept.md has no backups.');
    assert.deepEqual(r.rows, []);
  });

  test("a conflict's backup is named for the other program's version, and opens from the list beside it", async () => {
    const { uri, doc, notice } = await clashInRichTab('backups/Field notes.md');
    const backup = notice.backupPath!;
    written.push(backup);
    assert.match(
      path.basename(backup),
      /^Field notes\.md \(other program's version\) \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d [0-9a-f]{6}\.md$/,
    );

    const r = await compareWithBackup(uri, 0);
    assert.deepEqual(
      r.rows.map((row) => [row.label, row.path]),
      [["other program's version", backup]],
    );
    assert.equal(r.opened, backup);
    assert.equal(r.shown, 1, 'the backup opened from the list still shows the button');
    const title = "Field notes.md: other program's version ↔ your text";
    await waitFor(() => !!diffTab(title), `a comparison titled "${title}"`);
    const input = diffTab(title)!.input as vscode.TabInputTextDiff;
    assert.equal(input.original.fsPath.toLowerCase(), backup.toLowerCase(), 'the backup is on the left');
    assert.equal(input.modified.toString(), uri.toString(), "the note's text is on the right");
    assert.equal(await doc.save(), true);
  });

  test("lists the note's backups, newest first, and none of another note or of a name it does not write", async () => {
    const hook = await api();
    const uri = writeFile('backups/Listed.md', 'Mine.\n');
    await openText(uri);
    const folder = path.join(hook.globalStorageUri.fsPath, 'outside-versions');
    mkdirSync(folder, { recursive: true });
    const tag = createHash('sha256').update(uri.toString()).digest('hex').slice(0, 6);
    const other = createHash('sha256').update(`${uri.toString()}x`).digest('hex').slice(0, 6);
    const now = Date.now() / 1000;
    const files: [string, number][] = [
      [`Listed.md.${tag}.20261101-090000.md`, now - 300],
      [`Listed.md (other program's version) 2026-11-17 10.00.00 ${tag}.md`, now - 200],
      [`Listed.md (copy of your text) 2026-11-17 10.00.05 ${tag}.md`, now - 100],
      [`Listed.md (other program's version) 2026-11-17 10.00.09 ${other}.md`, now - 50],
    ];
    for (const [name, time] of files) {
      const file = path.join(folder, name);
      writeFileSync(file, 'Kept.\n');
      utimesSync(file, time, time);
      written.push(file);
    }

    const r = await compareWithBackup(uri, 0);
    assert.deepEqual(
      r.rows.map((row) => row.label),
      ['copy of your text', "other program's version"],
    );
    assert.equal(path.basename(r.opened ?? ''), files[2]![0], 'the newest was chosen');
    assert.equal(r.shown, 2, 'both still show the button, the one opened as well');
    await waitFor(
      () => !!diffTab('Listed.md: copy of your text ↔ your text now'),
      'a comparison of the copy of your text with the text now',
    );
  });

  test('"Done with these backups" takes the button off the tab bar, and a later message brings it back', async () => {
    const { uri, doc, notice } = await clashInRichTab('backups/Done with.md');
    written.push(notice.backupPath!);
    const done = await compareWithBackup(uri, 'done');
    assert.equal(done.done, true, 'the last row was chosen');
    assert.equal(done.shown, 0, 'no backup of the note shows the button');
    assert.equal((await compareWithBackup(uri)).shown, 0, 'done with them, the button stays away');
    assert.equal(await doc.save(), true);

    // A second clash on the same note: its message names a new backup.
    const hook = await api();
    const conflicts = () => hook.notices().filter((n) => n.uri === uri.toString() && n.notice.kind === 'conflict');
    const before = conflicts().length;
    const at = 'The '.length;
    await hook.runInPanel(uri, [{ type: 'replace', from: at, to: at + 3, text: 'pig' }, { type: 'flush' }]);
    await waitFor(() => lf(doc.getText()) === 'The pig sat on the mat.\n', 'the second edit to reach the document');
    writeFileSync(uri.fsPath, 'The hen sat on the mat.\n');
    await waitFor(() => conflicts().length > before, 'a second conflict notice');
    const second = conflicts().at(-1)!.notice as Extract<CoreNotice, { kind: 'conflict' }>;
    written.push(second.backupPath!);
    assert.notEqual(second.backupPath, notice.backupPath, 'the second message names a new backup');
    const r = await compareWithBackup(uri);
    assert.equal(r.shown, 1, "the new message's backup shows the button");
    assert.equal(await doc.save(), true);
  });
});
