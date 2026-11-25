/// <reference types="mocha" />
// Facts, measured once (itest/suite/facts.ts): what `window.activeTextEditor` and
// `window.visibleTextEditors` are while a rich tab is active, with and without a Source tab of
// the same note, and what selection a Source tab beside holds. Chat and agent extensions take
// the user's selection from these, so this is what they can see of a selection made in a rich
// tab through the public API alone.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { factsSuite } from './facts';
import {
  activeTabIsRich,
  api,
  closeEverything,
  documentFor,
  note,
  openRich,
  openText,
  VIEW_TYPE,
  waitFor,
  writeFile,
} from './helpers';

const TEXT = '# Selection\n\nThe first paragraph, with a few words to select.\n\nThe second paragraph.\n';
const SELECTED = 'a few words';

/** The active and visible text editors for `uri`, and the Source selection, in words. */
function editorsFor(uri: vscode.Uri): string {
  const key = uri.toString();
  const active = vscode.window.activeTextEditor;
  const activeText = !active ? 'none' : active.document.uri.toString() === key ? 'Source of the note' : 'another file';
  const visible = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
  const shown = visible.map((e) => {
    const s = e.selection;
    const anchor = e.document.offsetAt(s.anchor);
    const head = e.document.offsetAt(s.active);
    return `Source in column ${e.viewColumn} selecting ${anchor}-${head}`;
  });
  return `active text editor: ${activeText}; visible: ${shown.length ? shown.join(', ') : 'no text editor of the note'}`;
}

factsSuite('Facts: the text editors an extension sees while a rich tab is active', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('a rich tab is never the active text editor, and its selection is not a Source selection', async () => {
    const hook = await api();
    const uri = writeFile('facts/selection/note.md', TEXT);
    const from = TEXT.indexOf(SELECTED);
    const selection = `${from}-${from + SELECTED.length}`;
    const selectInPanel = async () => {
      const state = await hook.runInPanel(uri, [{ type: 'select', anchor: from, head: from + SELECTED.length }]);
      assert.equal(`${state.selection.anchor}-${state.selection.head}`, selection, 'the panel holds the selection');
    };
    const seen: Record<string, string> = {};

    await openRich(uri, vscode.ViewColumn.One);
    await selectInPanel();
    seen['rich tab only'] = editorsFor(uri);

    // A Source tab in the same group, behind the rich tab.
    await openText(uri, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: vscode.ViewColumn.One });
    await waitFor(() => activeTabIsRich(uri), 'the rich tab to be active again');
    seen['rich tab active, Source behind it'] = editorsFor(uri);

    // A Source tab beside, opened by VS Code.
    await closeEverything();
    await openRich(uri, vscode.ViewColumn.One);
    await openText(uri, vscode.ViewColumn.Two);
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await waitFor(() => activeTabIsRich(uri), 'the rich tab to be active');
    await selectInPanel();
    seen['rich tab active, Source beside'] = editorsFor(uri);

    // A Source tab beside, opened from the rich tab by Open Source to the Side.
    await closeEverything();
    await openRich(uri, vscode.ViewColumn.One);
    await selectInPanel();
    await waitFor(
      () => hook.coordinatorState(uri)?.panels[0]?.viewState?.selection.anchor === from,
      'the panel to report its selection to the host',
    );
    await vscode.commands.executeCommand('tandemMarkdown.openSourceToSide');
    await waitFor(
      () => vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri.toString()),
      'Source to open beside',
    );
    seen['rich tab active, Source beside from Open Source to the Side'] = editorsFor(uri);

    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await waitFor(() => vscode.window.activeTextEditor?.document === documentFor(uri), 'Source to be active');
    seen['Source beside, focused'] = editorsFor(uri);

    for (const [name, what] of Object.entries(seen)) note(`VS Code ${vscode.version}, ${name}: ${what}`);
    const beside = (selecting: string) =>
      `active text editor: none; visible: Source in column ${vscode.ViewColumn.Two} selecting ${selecting}`;
    assert.deepEqual(seen, {
      'rich tab only': 'active text editor: none; visible: no text editor of the note',
      'rich tab active, Source behind it': 'active text editor: none; visible: no text editor of the note',
      // VS Code starts a Source tab at the top: the rich tab's selection is not its own.
      'rich tab active, Source beside': beside('0-0'),
      'rich tab active, Source beside from Open Source to the Side': beside(selection),
      'Source beside, focused': `active text editor: Source of the note; visible: Source in column ${vscode.ViewColumn.Two} selecting ${selection}`,
    });
  });
});
