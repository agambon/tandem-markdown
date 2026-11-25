/// <reference types="mocha" />
// Typing a rich tab sent while the note's lock was held, as a save holds it, when the note's
// last tab is then closed: VS Code sees nothing unsaved and closes the note without asking, and
// the typing never reaches it. The message keeps a copy in a backup, the backups button lists it,
// "Compare versions" shows it beside the file on disk, and "Put my typing back" opens the note
// again with the typing in, unsaved; once the file has changed since the close, it changes
// nothing, opens no tab, and the message comes back without it. Each test uses its own note; the
// backups it leaves are deleted.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { CoreNotice } from '../../src/core/reconcile/types';
import type { CompareWithBackupResult } from '../../src/host/backupViews';
import { KIND_WORDS } from '../../src/host/model/backupNames';
import { comparisonTitle } from '../../src/host/model/backupViews';
import { DISMISS, PUT_TYPING_BACK, SEE_DIFF, typingAtCloseText } from '../../src/host/model/messageForms';
import {
  activeTabIsRich,
  api,
  deletedAfterEach,
  diffTab,
  documentFor,
  lf,
  openRich,
  readText,
  tabsFor,
  waitFor,
  writeFile,
  writeFileAt,
} from './helpers';

type TypingNotice = Extract<CoreNotice, { kind: 'typingAtClose' }>;

const TEXT = 'Pack the tent.\n';
const COPY = `${TEXT}typed `;

/**
 * Opens `name` in the Rich editor, holds its lock, types "typed " at its end (the space sends it at
 * once), waits until the push has reached the core, closes the tab and waits for the message.
 * Returns the note and its notice; the lock is let go once the note has closed.
 */
async function typeAndClose(name: string): Promise<{ uri: vscode.Uri; notice: TypingNotice }> {
  const hook = await api();
  hook.clearRecords();
  const uri = writeFile(`close/${name}`, TEXT);
  const doc = await openRich(uri);
  const release = hook.holdDocument(uri);
  try {
    await hook.runInPanel(uri, [{ type: 'insert', at: TEXT.length, text: 'typed ' }]);
    await waitFor(() => hook.coordinatorState(uri)?.unapplied === 1, 'the push to reach the core');
    assert.equal(doc.isDirty, false, 'nothing reached the note, so VS Code holds it as saved');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(() => doc.isClosed, 'VS Code to close the note, which held nothing unsaved, with its last tab');
  } finally {
    release();
  }
  let notice: TypingNotice | undefined;
  await waitFor(() => {
    notice = hook
      .notices()
      .find(
        (n): n is { notice: TypingNotice; uri: string } =>
          n.notice.kind === 'typingAtClose' && n.uri === uri.toString(),
      )?.notice;
    return notice !== undefined && hook.askedFor(notice.id) !== undefined;
  }, 'the message about the typing');
  return { uri, notice: notice! };
}

suite('Typing a note never had when VS Code closed it', () => {
  const written = deletedAfterEach();

  suiteTeardown(async () => {
    (await api()).answerPrompts(undefined);
  });

  test('is kept in a backup and told, and "Put my typing back" opens the note with it, unsaved', async () => {
    const hook = await api();
    const { uri, notice } = await typeAndClose('Field notes.md');
    assert.ok(notice.backupPath !== null, 'the copy is in a backup');
    written.push(notice.backupPath);
    assert.equal(lf(readFileSync(notice.backupPath, 'utf8')), COPY, 'the backup holds the note with the typing');
    assert.equal(lf(notice.closedText), TEXT);
    assert.equal(readText(uri), TEXT, 'nothing was written to the file');
    assert.deepEqual(hook.askedFor(notice.id)?.items, [PUT_TYPING_BACK, SEE_DIFF, DISMISS]);
    assert.equal(
      hook.askedFor(notice.id)!.text,
      typingAtCloseText('Field notes.md', 1, true),
      'the message for typing on 1 line, kept in a backup',
    );

    // The backups button lists it: the list counts it among the backups that show the button.
    hook.answerPrompts(() => undefined);
    const listed = await vscode.commands.executeCommand<CompareWithBackupResult>(
      'tandemMarkdown.compareWithBackup',
      uri,
    );
    assert.ok(listed.rows.some((r) => r.path === notice.backupPath && r.label === KIND_WORDS.yours));
    assert.ok(listed.shown >= 1, 'the backups button shows for it');

    assert.equal(hook.answerNotice(notice.id, PUT_TYPING_BACK), true);
    await waitFor(() => {
      const d = documentFor(uri);
      return !!d && !d.isClosed && d.isDirty && lf(d.getText()) === COPY;
    }, 'the note open again with the typing in it, unsaved');
    const reopened = documentFor(uri)!;
    assert.equal(reopened.isDirty, true, 'the typing is back unsaved');
    await waitFor(() => activeTabIsRich(uri), 'the note in the Rich editor');
    assert.equal(hook.askedFor(notice.id), undefined, 'the message goes once the typing is back');
  });

  test('"See Diff" shows the copy beside the file on disk, and the message comes back', async () => {
    const hook = await api();
    const { notice } = await typeAndClose('Compared.md');
    if (notice.backupPath !== null) written.push(notice.backupPath);
    assert.equal(hook.answerNotice(notice.id, SEE_DIFF), true);
    // The copy of the user's text beside the file on disk, since the note is closed.
    const title = comparisonTitle('Compared.md', 'yours', true, null);
    await waitFor(() => !!diffTab(title), `a comparison titled "${title}"`);
    await waitFor(() => hook.askedFor(notice.id) !== undefined, 'the message to come back');
    assert.deepEqual(hook.askedFor(notice.id)?.items, [PUT_TYPING_BACK, SEE_DIFF, DISMISS]);
  });

  test('"Put My Typing Back" changes nothing once the file has changed since the close', async () => {
    const hook = await api();
    const { uri, notice } = await typeAndClose('Changed since.md');
    if (notice.backupPath !== null) written.push(notice.backupPath);
    writeFileAt(uri, 'Another program wrote this.\n');
    assert.equal(hook.answerNotice(notice.id, PUT_TYPING_BACK), true);
    await waitFor(
      () => !hook.askedFor(notice.id)?.items.includes(PUT_TYPING_BACK),
      'Put My Typing Back to be withdrawn',
    );
    assert.deepEqual(hook.askedFor(notice.id), {
      text: typingAtCloseText('Changed since.md', 1, true),
      items: [SEE_DIFF, DISMISS],
    });
    assert.deepEqual(tabsFor(uri), [], 'no tab of the note was opened');
    assert.equal(readText(uri), 'Another program wrote this.\n');
  });
});
