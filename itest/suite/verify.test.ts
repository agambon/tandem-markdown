/// <reference types="mocha" />
// Verify File in a real VS Code with the real panel. It agrees when all agree, leaves the file
// out while there are unsaved changes, works without a rich tab, and on a disagreement (forced
// through the test hook: text inserted into the panel that the host never hears of) says only
// that the tab differs, offers Compare versions and Reload tab with the tab's text held for the
// comparison, and changes nothing by itself.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { VERIFY_WORDS as W } from '../../src/host/model/verifyText';
import type { VerifyResult } from '../../src/host/verify';
import { api, closeEverything, documentFor, lf, note, openRich, openText, waitFor, writeFile } from './helpers';

const COMPARE = 'Compare versions';

const verify = async (): Promise<VerifyResult> => {
  const r = await vscode.commands.executeCommand<VerifyResult>('tandemMarkdown.verify');
  note(`Verify File: ${r.message}`);
  return r;
};

const TEXT = '# Check\n\nSome text to compare.\n\nMore text.\n';

suite('Verify File', () => {
  let uri: vscode.Uri;

  suiteSetup(() => {
    uri = writeFile('verify/Check.md', TEXT);
  });

  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('a rich tab, your text and the file on disk agree', async () => {
    await openRich(uri);
    const r = await verify();
    assert.equal(r.message, W.bothMatch);
    assert.equal(r.agree, true);
    assert.deepEqual(r.buttons, []);
  });

  test('with unsaved changes, the tab and your text are compared and the file on disk is not', async () => {
    const hook = await api();
    await openRich(uri);
    await hook.runInPanel(uri, [{ type: 'insert', at: TEXT.indexOf('Some'), text: 'Typed ' }, { type: 'flush' }]);
    await waitFor(() => documentFor(uri)?.isDirty === true, 'the document to have unsaved changes');
    const r = await verify();
    assert.equal(r.agree, true);
    assert.equal(r.message, `${W.tabShows} ${W.notCompared.unsaved}`);
  });

  test('from Source, your text and the file on disk agree', async () => {
    await openText(uri);
    const r = await verify();
    assert.equal(r.message, W.fileMatches);
  });

  test('a tab that disagrees: only that is said, its text is held for Compare versions, nothing is changed', async () => {
    const hook = await api();
    const doc = await openRich(uri);
    const before = lf(doc.getText());
    const at = TEXT.indexOf('More');
    const state = await hook.runInPanel(uri, [{ type: 'corrupt', at, text: 'XYZ ' }]);
    assert.equal(state.error, undefined);
    assert.equal(state.text, before.slice(0, at) + 'XYZ ' + before.slice(at));

    const r = await verify();
    assert.equal(r.agree, false);
    assert.equal(r.message, W.tabDiffers);
    assert.deepEqual(r.buttons, [COMPARE, W.reloadTab]);
    assert.equal(r.compared.tab, state.text, "the tab's text is what Compare versions shows");
    assert.equal(r.compared.file, undefined, 'the file on disk agrees, so it is not compared');

    // Verify File changes nothing by itself: the document and the file are as they were.
    assert.equal(lf(doc.getText()), before);
    assert.equal(doc.isDirty, false);
    assert.equal(lf(readFileSync(uri.fsPath, 'utf8')), before);
    // The view then finds the difference by its own stamp check and reloads itself.
    await waitFor(async () => (await hook.panelState(uri)).text === before, 'the panel to reload itself');
  });
});
