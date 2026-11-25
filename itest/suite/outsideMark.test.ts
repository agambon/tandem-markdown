/// <reference types="mocha" />
// The outside-change mark in a real VS Code: the host labels a change 'outside' when nobody is
// typing in a text editor of the file, and the panel marks the lines it changed. Another
// program's write to a clean file (VS Code reloads it) and another extension's edit while the
// panel is active are marked; typing in Source beside the panel is not. A line changed while its
// tab is behind another keeps its mark until the tab is shown, and then fades.
//
// The panel is made the active editor for the extension's edit by closing the Source tab. About a
// quarter of a second after a text editor opened beside a webview tab takes focus, VS Code at
// times makes the webview tab's group active again while the keyboard focus stays in the text
// editor (often on 1.146, rarely on 1.120, and with its own Markdown Editor's tab as well). VS Code
// names a text editor that holds the keyboard focus the active text editor, and focusing the
// webview's group, already active then, does not take the focus from it.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activeTabIsRich,
  api,
  closeEverything,
  holdsWithin,
  note,
  openRich,
  openText,
  tabsFor,
  waitFor,
  writeFile,
} from './helpers';

type State = Awaited<ReturnType<Awaited<ReturnType<typeof api>>['panelState']>>;

/** Longer than the outside-change mark's whole fade: FADE_STEPS steps of FADE_STEP_MS (src/panel/render/outsideMark.ts). */
const LONGER_THAN_THE_FADE_MS = 6000;

suite('Lines changed from outside are marked', () => {
  teardown(async () => {
    await closeEverything();
  });

  test("an outside write and another extension's edit are marked, typing in Source is not", async () => {
    const hook = await api();
    const uri = writeFile('marked/Note.md', 'one\ntwo\nthree\n');
    await openRich(uri);

    // Another program writes the file; VS Code reloads the clean document.
    writeFile('marked/Note.md', 'one\nTWO\nthree\n');
    let state: State | null = null;
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.text === 'one\nTWO\nthree\n';
    }, 'the outside write to reach the panel');
    note(`after the outside write, marked lines: ${JSON.stringify(state!.outsideMarked)}`);
    assert.deepEqual(state!.outsideMarked, [2]);

    // Typing in Source beside the panel.
    const editor = await openText(uri, vscode.ViewColumn.Beside);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString());
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'zero '));
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.text.startsWith('zero one');
    }, 'the Source typing to reach the panel');
    note(`after typing in Source, marked lines: ${JSON.stringify(state!.outsideMarked)}`);
    assert.ok(!state!.outsideMarked.includes(1), 'typing in Source is not marked');

    // Another extension edits the file while the panel is the active editor.
    const source = tabsFor(uri).find((t) => t.input instanceof vscode.TabInputText);
    assert.ok(source, 'the Source tab');
    assert.equal(await vscode.window.tabGroups.close(source), true, 'the Source tab closes');
    await waitFor(
      () => vscode.window.activeTextEditor === undefined && activeTabIsRich(uri),
      'the panel to be the active editor',
    );
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(2, 0), 'Another extension wrote this.\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.text.includes('Another extension wrote this.');
    }, "the extension's edit to reach the panel");
    note(`after another extension's edit, marked lines: ${JSON.stringify(state!.outsideMarked)}`);
    assert.ok(state!.outsideMarked.includes(3), 'the line the extension added is marked');
    assert.ok(!state!.outsideMarked.includes(1), 'the Source line is not');
  });

  test('a line changed while its tab is behind another keeps its mark until the tab is shown', async () => {
    const hook = await api();
    const uri = writeFile('marked/Behind.md', 'one\ntwo\nthree\n');
    await openRich(uri);
    // Another file opened in the same group puts the rich tab behind it.
    const other = writeFile('marked/InFront.md', 'in front\n');
    await openText(other, vscode.ViewColumn.Active);
    await waitFor(() => tabsFor(uri).every((t) => !t.isActive), 'the rich tab to be behind the other file');

    writeFile('marked/Behind.md', 'one\nTWO\nthree\n');
    let state: State | null = null;
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.text === 'one\nTWO\nthree\n';
    }, 'the outside write to reach the panel behind the other tab');
    assert.deepEqual(state!.outsideMarked, [2]);
    // Longer than the whole fade: in a tab shown all this time, the mark would be gone.
    const faded = await holdsWithin(LONGER_THAN_THE_FADE_MS, async () => {
      state = await hook.panelState(uri);
      return state.outsideMarked.length === 0;
    });
    note(
      `behind the other tab, marked lines after ${LONGER_THAN_THE_FADE_MS} ms: ${JSON.stringify(state!.outsideMarked)}`,
    );
    assert.equal(faded, false, 'the mark faded while its tab was behind another');

    await openRich(uri);
    await waitFor(() => activeTabIsRich(uri), 'the rich tab to be in front again');
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.outsideMarked.length === 0;
    }, 'the mark to fade once its tab is shown');
  });
});
