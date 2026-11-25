/// <reference types="mocha" />
// Facts, measured once (itest/suite/facts.ts): whether Code Spell Checker reports on a note shown
// only in a rich tab, with no text editor of it anywhere, and whether what it reports reaches
// the panel through the extension's way for problems (src/host/diagnostics.ts). A note with
// Source open beside it is the control. Code Spell Checker must be installed into the test copy
// first: TM_ITEST_EXTENSIONS names its .vsix (itest/runTest.ts).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { HELPER_SOURCE } from '../helper/words';
import { factsSuite } from './facts';
import { api, closeEverything, documentFor, holdsWithin, note, openRich, openText, writeFile } from './helpers';

const SPELL_CHECKER = 'streetsidesoftware.code-spell-checker';
const MISSPELLED = 'beleive';
const TEXT = `# Spelling\n\nI ${MISSPELLED} this word is misspelled.\n`;

/** How long the spell checker is given to report, the first time while its server starts. */
const FIRST_REPORT_MS = 60_000;
const REPORT_MS = 20_000;
/** How long the panel is given to receive problems VS Code already holds. */
const PANEL_MS = 10_000;

/** The spell checker's problems on the misspelled word, in words ("" while there are none). */
function reportedOn(uri: vscode.Uri): string {
  const document = documentFor(uri);
  return vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.source !== HELPER_SOURCE && document?.getText(d.range) === MISSPELLED)
    .map((d) => `"${d.message}" from ${d.source ?? 'no source'}, severity ${vscode.DiagnosticSeverity[d.severity]}`)
    .join('; ');
}

factsSuite('Facts: Code Spell Checker on a note shown only in a rich tab', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('its problems reach VS Code and the panel, with no text editor and with Source beside', async function () {
    this.timeout(FIRST_REPORT_MS + 2 * REPORT_MS + 2 * PANEL_MS + 30_000);
    const hook = await api();
    const checker = vscode.extensions.getExtension(SPELL_CHECKER);
    assert.ok(checker, `${SPELL_CHECKER} is installed in the test copy (TM_ITEST_EXTENSIONS, itest/runTest.ts)`);
    await checker.activate();
    note(`Code Spell Checker ${(checker.packageJSON as { version: string }).version}, VS Code ${vscode.version}`);

    const inPanel = async (uri: vscode.Uri) => {
      const state = await hook.panelState(uri);
      return state.diagnostics.some((d) => state.text.slice(d.from, d.to) === MISSPELLED);
    };
    const seen: Record<string, boolean> = {};

    const onlyRich = writeFile('facts/spelling/Only rich.md', TEXT);
    await openRich(onlyRich);
    assert.ok(
      vscode.window.visibleTextEditors.every((e) => e.document.uri.toString() !== onlyRich.toString()),
      'no text editor shows the note',
    );
    seen['rich only: reported to VS Code'] = await holdsWithin(FIRST_REPORT_MS, () => reportedOn(onlyRich) !== '');
    note(`rich only: ${reportedOn(onlyRich) || 'nothing reported'}`);
    seen['rich only: in the panel'] = await holdsWithin(PANEL_MS, () => inPanel(onlyRich));

    // The control: the same note text with Source open beside the rich tab.
    const beside = writeFile('facts/spelling/Source beside.md', TEXT);
    await openRich(beside, vscode.ViewColumn.One);
    await openText(beside, vscode.ViewColumn.Two);
    seen['Source beside: reported to VS Code'] = await holdsWithin(REPORT_MS, () => reportedOn(beside) !== '');
    note(`Source beside: ${reportedOn(beside) || 'nothing reported'}`);
    seen['Source beside: in the panel'] = await holdsWithin(PANEL_MS, () => inPanel(beside));

    // A note shown only in a rich tab again, once the checker is running.
    await closeEverything();
    const later = writeFile('facts/spelling/Only rich later.md', TEXT);
    await openRich(later);
    seen['rich only, checker running: reported to VS Code'] = await holdsWithin(
      REPORT_MS,
      () => reportedOn(later) !== '',
    );
    seen['rich only, checker running: in the panel'] = await holdsWithin(PANEL_MS, () => inPanel(later));

    for (const [name, held] of Object.entries(seen)) note(`${name}: ${held ? 'yes' : 'no, within the time given'}`);
    // Code Spell Checker 4.10.0 counts a document as open while any tab shows it, a custom
    // editor's included (its language client's list of visible documents reads every tab).
    assert.deepEqual(
      seen,
      Object.fromEntries(Object.keys(seen).map((name) => [name, true])),
      'every case was reported and reached the panel',
    );
  });
});
