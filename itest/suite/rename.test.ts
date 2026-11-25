/// <reference types="mocha" />
// Renames from inside VS Code (a workspace edit, as the Explorer makes) of a file open in a
// rich tab with unsaved text. VS Code closes the document and opens one at the new path.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  api,
  closeEverything,
  documentFor,
  lf,
  openRich,
  tabsFor,
  type TandemMarkdownTestApi,
  VIEW_TYPE,
  waitFor,
  workspaceDir,
  writeFile,
} from './helpers';

async function rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(from, to);
  assert.equal(await vscode.workspace.applyEdit(edit), true, 'the rename was applied');
}

/** Waits until the file at `uri` has its base from a read of the disk, then checks nothing was raised. */
async function settledWithoutNotice(uri: vscode.Uri, saved: string): Promise<void> {
  const hook = await api();
  await waitFor(() => hook.coordinatorState(uri)?.base === saved, 'the renamed document to find its base');
  assert.deepEqual(
    hook.notices().map((n) => n.notice.kind),
    [],
  );
}

function richTabs(uri: vscode.Uri): vscode.Tab[] {
  return tabsFor(uri).filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE);
}

/** Waits for `to` to be back in one rich tab, with no text tab beside it, and returns its panel's state. */
async function backInOneRichTab(to: vscode.Uri, what: string): ReturnType<TandemMarkdownTestApi['panelState']> {
  const hook = await api();
  await waitFor(() => richTabs(to).length === 1, what);
  await hook.whenPanelLive(to);
  assert.equal(tabsFor(to).length, 1, 'no text tab is left beside it');
  return hook.panelState(to);
}

suite('Renames', () => {
  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('renaming an unsaved file keeps its rich tab and its text, and raises nothing', async () => {
    const hook = await api();
    const saved = 'rename me\nsecond\n';
    const from = writeFile('rename/Note.md', saved);
    const doc = await openRich(from);
    await hook.runInPanel(from, [{ type: 'insert', at: 0, text: 'unsaved ' }, { type: 'flush' }]);
    await waitFor(() => lf(doc.getText()).startsWith('unsaved '), 'the typing to reach the document');

    const to = vscode.Uri.file(path.join(workspaceDir(), 'rename', 'Renamed.md'));
    await rename(from, to);
    const state = await backInOneRichTab(to, 'the renamed file to be back in a rich tab');
    assert.equal(state.text, `unsaved ${saved}`);
    assert.equal(state.mode, 'edit');
    assert.equal(documentFor(to)?.isDirty, true);
    await settledWithoutNotice(to, saved);
  });

  test('renaming the folder of an unsaved file keeps its rich tab in Rich view at its selection', async () => {
    const hook = await api();
    const saved = 'first line\nsecond line\n';
    const from = writeFile('rename-folder/inner/Note.md', saved);
    const doc = await openRich(from);
    await hook.runInPanel(from, [{ type: 'insert', at: 0, text: 'unsaved ' }, { type: 'flush' }]);
    await waitFor(() => lf(doc.getText()).startsWith('unsaved '), 'the typing to reach the document');
    const selection = { anchor: 14, head: 20 };
    await hook.runInPanel(from, [
      { type: 'setMode', mode: 'view' },
      { type: 'select', ...selection },
    ]);
    await waitFor(
      () => hook.coordinatorState(from)?.panels[0]?.viewState?.selection.head === selection.head,
      'the panel to report its view',
    );

    const folder = vscode.Uri.file(path.join(workspaceDir(), 'rename-folder', 'inner'));
    const renamedFolder = vscode.Uri.file(path.join(workspaceDir(), 'rename-folder', 'moved'));
    await rename(folder, renamedFolder);
    const to = vscode.Uri.joinPath(renamedFolder, 'Note.md');
    const state = await backInOneRichTab(to, 'the moved file to be back in a rich tab');
    assert.equal(state.text, `unsaved ${saved}`);
    assert.equal(state.mode, 'view');
    assert.deepEqual(state.selection, selection);
    await settledWithoutNotice(to, saved);
  });
});
