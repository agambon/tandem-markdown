/// <reference types="mocha" />
// Tab Moves Focus across the host and its panels: the command reaches every open panel, a panel
// that opens or whose page starts again while the mode is on is told, and turning it off reaches
// them all. An extension cannot press keys inside a webview, so what Tab then does in the page is
// checked in the browser (harness/tests/editing.spec.mjs).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { api, closeEverything, openRich, waitFor, writeFile } from './helpers';

const TOGGLE = 'tandemMarkdown.toggleTabMovesFocus';

suite('Tab Moves Focus', () => {
  /** The mode as this test has set it, so a failure partway does not leave it on for the next file. */
  let on = false;

  async function toggle(): Promise<void> {
    await vscode.commands.executeCommand(TOGGLE);
    on = !on;
  }

  async function panelSays(uri: vscode.Uri, want: boolean, what: string): Promise<void> {
    const hook = await api();
    await waitFor(async () => (await hook.panelState(uri)).tabMovesFocus === want, what);
  }

  teardown(async () => {
    if (on) await toggle();
    await closeEverything();
  });

  test('the mode reaches open panels, panels that open or start again while it is on, and is turned off', async () => {
    const hook = await api();
    const first = writeFile('tab-focus/First.md', '- one\n- two\n');
    const second = writeFile('tab-focus/Second.md', 'Some text.\n');
    await openRich(first);
    assert.equal((await hook.panelState(first)).tabMovesFocus, false, 'a panel starts with Tab indenting');

    await toggle();
    await panelSays(first, true, 'the open panel to be told the mode is on');

    await openRich(second, vscode.ViewColumn.Beside);
    await panelSays(second, true, 'a panel opened while the mode is on to be told');

    // Every page starts again with the mode off; each is sent a fresh init, then the mode.
    const before = hook.coordinatorState(first)?.panels[0]?.clientId;
    await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
    await waitFor(() => {
      const now = hook.coordinatorState(first)?.panels[0]?.clientId;
      return !!now && now !== before;
    }, 'the panel to start again');
    await panelSays(first, true, 'a panel that started again to be told the mode is on');

    await toggle();
    await panelSays(first, false, 'the first panel to be told the mode is off');
    await panelSays(second, false, 'the second panel to be told the mode is off');
  });
});
