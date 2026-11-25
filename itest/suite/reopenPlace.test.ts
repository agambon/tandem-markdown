/// <reference types="mocha" />
// A note opens where it was left: a rich tab closed and opened again comes back with the same
// selection, the same line at the top and the same rich view, and so does a note renamed in
// VS Code while it was closed, at its new path. The suite keeps places as the extension does
// everywhere; closeEverything forgets them, so each test starts with none.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ViewState } from '../../src/core/protocol';
import { api, closeEverything, lf, openRich, readText, waitFor, workspaceDir, writeFile } from './helpers';

/** Writes a note of 200 numbered paragraphs at `name` in the workspace. */
function writeLongNote(name: string): vscode.Uri {
  const paragraphs = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1} of the note.`);
  return writeFile(name, paragraphs.join('\n\n') + '\n');
}

/**
 * Opens the note in a rich tab, selects a word far down it in Rich view, closes the tab, and
 * returns the place kept for the note.
 */
async function leaveFarDown(uri: vscode.Uri): Promise<ViewState> {
  const hook = await api();
  await openRich(uri);
  // Far down the note, so the place is not the top, and in Rich view, which is not where a note opens first.
  const at = lf(readText(uri)).indexOf('Paragraph 150 of');
  await hook.runInPanel(uri, [
    { type: 'select', anchor: at, head: at + 9 },
    { type: 'setMode', mode: 'view' },
  ]);
  const reported = () => hook.coordinatorState(uri)?.panels[0]?.viewState;
  await waitFor(
    () =>
      reported()?.selection.anchor === at &&
      reported()?.selection.head === at + 9 &&
      reported()?.mode === 'view' &&
      (reported()?.topLine ?? 0) > 0,
    'the rich tab to report the selection, scrolled to it, and Rich view',
  );

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await waitFor(() => (hook.coordinatorState(uri)?.panels.length ?? 0) === 0, 'the rich tab to close');
  const kept = hook.keptViewState(uri);
  assert.ok(kept, 'a place was kept when the tab closed');
  assert.deepEqual(kept.selection, { anchor: at, head: at + 9 });
  assert.equal(kept.mode, 'view');
  assert.ok(kept.topLine > 0, `the line at the top was kept (${kept.topLine})`);
  return kept;
}

/** Opens the note in a rich tab and waits for it to show the selection, top line and rich view of `kept`. */
async function opensAt(uri: vscode.Uri, kept: ViewState): Promise<void> {
  const hook = await api();
  await openRich(uri);
  const reported = () => hook.coordinatorState(uri)?.panels[0]?.viewState;
  await waitFor(
    () =>
      reported()?.selection.anchor === kept.selection.anchor &&
      reported()?.selection.head === kept.selection.head &&
      reported()?.topLine === kept.topLine &&
      reported()?.mode === 'view',
    `the note to open again at line ${kept.topLine}, with the selection and Rich view it was left with`,
  );
}

suite('A note opens where it was left', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('a rich tab closed and opened again has the same selection, top line and rich view', async () => {
    const uri = writeLongNote('places/long.md');
    await closeEverything();
    await opensAt(uri, await leaveFarDown(uri));
  });

  test('a note renamed in VS Code while closed opens at its new path where it was left', async () => {
    const hook = await api();
    const from = writeLongNote('places/Before the rename.md');
    await closeEverything();
    const kept = await leaveFarDown(from);

    const to = vscode.Uri.file(path.join(workspaceDir(), 'places', 'After the rename.md'));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(from, to);
    assert.equal(await vscode.workspace.applyEdit(edit), true, 'the rename was applied');
    await waitFor(() => hook.keptViewState(to) !== undefined, 'the place to be kept under the new path');
    assert.deepEqual(hook.keptViewState(to), kept);
    assert.equal(hook.keptViewState(from), undefined, 'nothing is kept under the old path');

    await opensAt(to, kept);
  });
});
