/// <reference types="mocha" />
// What a screen reader is told of another program's change, in a real VS Code: the rich tab's
// live region is given one sentence once the change has landed and the note is quiet, saying
// how much changed, where and in which note; typing in Source beside it gives none; a change made
// while the tab is behind another is told once the tab is shown; and with
// `tandemMarkdown.outsideChanges.announce` false nothing is. Whether a screen reader then speaks
// the sentence cannot be seen from here: that requires manual screen-reader verification.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { outsideSentence } from '../../src/panel/announce/words';
import {
  activeTabIsRich,
  api,
  holdsWithin,
  note,
  openRich,
  openText,
  setSetting,
  tabsFor,
  undoAfterEach,
  waitFor,
  writeFile,
} from './helpers';

/** Longer than the panel waits for a note to be quiet (QUIET_MS in src/panel/announce/index.ts) before it tells. */
const LONGER_THAN_THE_QUIET_MS = 5000;

const NOTE = '# Route\n\nwalk\n\n# Questions\n\none\ntwo\nthree\n';
const CHANGED = '# Route\n\nwalk\n\n# Questions\n\nONE\nTWO\nthree\n';
/** What the change from NOTE to CHANGED is told as: 2 lines reworded under the heading Questions of Field notes.md. */
const TOLD = outsideSentence({
  fileName: 'Field notes.md',
  shape: 'changed',
  count: 2,
  unit: 'line',
  block: null,
  frontMatter: false,
  place: { aboveFirst: false, headings: [{ name: 'Questions', isNew: false, nextTo: null }], thirds: [], quote: null },
  problems: false,
});

suite('A screen reader is told of changes from outside', () => {
  const restore = undoAfterEach();

  /** What the panel's live region has been given since `from` sentences in. */
  const announcedSince = async (uri: vscode.Uri, from: number) =>
    (await (await api()).panelState(uri)).announced.slice(from);

  test("another program's write is told once, and typing in Source beside it is not", async () => {
    const hook = await api();
    const uri = writeFile('announce/told/Field notes.md', NOTE);
    await openRich(uri);
    const from = (await hook.panelState(uri)).announced.length;

    writeFile('announce/told/Field notes.md', CHANGED);
    await waitFor(async () => (await announcedSince(uri, from)).length > 0, 'the change to be told');
    note(`told: ${JSON.stringify(await announcedSince(uri, from))}`);
    assert.deepEqual(await announcedSince(uri, from), [TOLD]);
    // The promise is that nothing more is said of it in this time.
    const toldAgain = await holdsWithin(
      LONGER_THAN_THE_QUIET_MS,
      async () => (await announcedSince(uri, from)).length > 1,
    );
    assert.equal(toldAgain, false, 'the change was told more than once');

    const editor = await openText(uri, vscode.ViewColumn.Beside);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'zero '));
    await waitFor(
      async () => (await hook.panelState(uri)).text.startsWith('zero '),
      'the Source typing to reach the panel',
    );
    const toldTyping = await holdsWithin(
      LONGER_THAN_THE_QUIET_MS,
      async () => (await announcedSince(uri, from)).length > 1,
    );
    assert.equal(toldTyping, false, 'typing in Source was told');
  });

  test('a change made while the tab is behind another is told once the tab is shown', async () => {
    const hook = await api();
    const uri = writeFile('announce/behind/Field notes.md', NOTE);
    await openRich(uri);
    const from = (await hook.panelState(uri)).announced.length;
    await openText(writeFile('announce/behind/In front.md', 'in front\n'), vscode.ViewColumn.Active);
    await waitFor(() => tabsFor(uri).every((t) => !t.isActive), 'the rich tab to be behind the other file');

    writeFile('announce/behind/Field notes.md', CHANGED);
    await waitFor(async () => (await hook.panelState(uri)).text === CHANGED, 'the change to reach the panel behind');
    const toldBehind = await holdsWithin(
      LONGER_THAN_THE_QUIET_MS,
      async () => (await announcedSince(uri, from)).length > 0,
    );
    assert.equal(toldBehind, false, 'the change was told while its tab was behind another');

    await openRich(uri);
    await waitFor(() => activeTabIsRich(uri), 'the rich tab to be in front again');
    await waitFor(async () => (await announcedSince(uri, from)).length > 0, 'the change to be told once shown');
    assert.deepEqual(await announcedSince(uri, from), [TOLD]);
  });

  test('nothing is told with tandemMarkdown.outsideChanges.announce false', async () => {
    restore.push(await setSetting('tandemMarkdown', 'outsideChanges.announce', false));
    const hook = await api();
    const uri = writeFile('announce/off/Field notes.md', NOTE);
    await openRich(uri);
    const from = (await hook.panelState(uri)).announced.length;

    writeFile('announce/off/Field notes.md', CHANGED);
    await waitFor(async () => (await hook.panelState(uri)).text === CHANGED, 'the change to reach the panel');
    const told = await holdsWithin(LONGER_THAN_THE_QUIET_MS, async () => (await announcedSince(uri, from)).length > 0);
    assert.equal(told, false, 'the change was told with the setting off');
  });
});
