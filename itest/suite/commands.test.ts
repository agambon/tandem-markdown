/// <reference types="mocha" />
// The host's general commands (src/host/commands.ts) that no other file of the suite covers:
// Show Keyboard Shortcuts opens VS Code's Keyboard Shortcuts editor.

import * as vscode from 'vscode';
import { closeEverything, waitFor } from './helpers';

suite('Show Keyboard Shortcuts', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('opens the Keyboard Shortcuts editor', async () => {
    await vscode.commands.executeCommand('tandemMarkdown.showKeys');
    await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Keyboard Shortcuts',
      'the Keyboard Shortcuts editor',
    );
  });
});
