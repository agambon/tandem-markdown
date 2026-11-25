/// <reference types="mocha" />
// Untitled documents and `.txt` files in a real VS Code. The rich editor is offered for them
// and never their default: a `.txt` file opens in Source, and opens in the rich editor when
// asked, where it is edited and another program's changes to it are merged as a markdown
// file's are. An untitled document, markdown or plain text, switches to the rich editor and is
// edited there; what needs a file on disk (merging another program's changes, change marks) is
// absent for it, and nothing fails.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activeTabIsRich,
  api,
  closeEverything,
  documentFor,
  note,
  openRich,
  readText,
  waitFor,
  writeFile,
} from './helpers';

suite('Untitled documents and .txt files', () => {
  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('a .txt file opens in Source unless the rich editor is asked for, and merges outside changes', async () => {
    const hook = await api();
    const uri = writeFile('plain/todo.txt', '# To do\n\n- one\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString(), 'Source to open');
    assert.ok(!activeTabIsRich(uri), 'the rich editor is not the default for a .txt file');
    await closeEverything();

    await openRich(uri);
    const coordinator = hook.coordinatorState(uri);
    note(`coordinator: reconciled ${coordinator?.reconciled}, read-only ${coordinator?.readOnly}`);
    assert.equal(coordinator?.reconciled, true, "another program's changes are merged");
    assert.equal(coordinator?.readOnly, false);

    await hook.runInPanel(uri, [{ type: 'insert', at: '# To do\n\n- one\n'.length, text: '- two\n' }]);
    assert.ok(await hook.flush(uri));
    const document = documentFor(uri);
    assert.ok(document && (await document.save()));
    assert.equal(readText(uri), '# To do\n\n- one\n- two\n');

    writeFile('plain/todo.txt', '# To do\n\n- one\n- two\n- three, from another program\n');
    await waitFor(
      async () => (await hook.panelState(uri)).text.includes('three, from another program'),
      "the other program's change to reach the panel",
    );
  });

  for (const language of ['markdown', 'plaintext']) {
    test(`an untitled ${language} document switches to the rich editor and is edited there`, async () => {
      const hook = await api();
      const document = await vscode.workspace.openTextDocument({
        language,
        content: '# Draft\n\nA picture beside it: ![picture](pic.png)\n',
      });
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('tandemMarkdown.showRichEditor');
      await waitFor(() => activeTabIsRich(document.uri), 'the rich editor to replace Source');
      await hook.whenPanelLive(document.uri);
      const coordinator = hook.coordinatorState(document.uri);
      assert.equal(coordinator?.readOnly, false, 'an untitled document can be edited');
      assert.equal(coordinator?.reconciled, false, 'there is no file to merge changes from');

      const state = await hook.runInPanel(document.uri, [{ type: 'insert', at: '# Draft'.length, text: ', typed' }]);
      assert.equal(state.mode, 'edit');
      assert.ok(await hook.flush(document.uri));
      assert.ok(document.getText().startsWith('# Draft, typed\n'));
      let widgets: string[] = [];
      await waitFor(async () => {
        widgets = (await hook.panelState(document.uri)).widgets;
        return widgets.some((w) => w.includes('tm-image-failed'));
      }, 'a picture beside an untitled note to say why it is not shown');
      note(`drawn widgets: ${JSON.stringify(widgets)}`);
      assert.deepEqual(state.changeMarks, [], 'an untitled document has no change marks');
      const errors = hook.logLines().filter((l) => l.level === 'error');
      assert.deepEqual(errors, [], 'nothing failed');

      await vscode.commands.executeCommand('tandemMarkdown.showSource');
      await waitFor(
        () => vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString(),
        'Source to come back',
      );
      assert.ok(vscode.window.activeTextEditor!.document.getText().startsWith('# Draft, typed\n'));
    });
  }
});
