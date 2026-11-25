/// <reference types="mocha" />
// Problems and their fixes from another extension, in a real VS Code. The test helper
// (itest/helper), loaded beside Tandem Markdown, reports words as a spell checker does and
// offers quick fixes. This checks that it reports on a document open only in the rich editor,
// that its problems reach the panel at their words and stay there as the panel is typed in,
// and that its fixes, by edit and by command, are applied by VS Code and come back to the panel
// as ordinary changes, not marked as another program's.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FIXED_BY_COMMAND, FIXED_BY_EDIT, HELPER_SOURCE } from '../helper/words';
import { api, closeEverything, documentFor, note, openRich, waitFor, writeFile } from './helpers';

type State = Awaited<ReturnType<Awaited<ReturnType<typeof api>>['panelState']>>;

const TEXT = `# Problems\n\nA ${FIXED_BY_EDIT.word} word, and a ${FIXED_BY_COMMAND.word} too.\n`;

/** The words the panel's problems cover, in order. */
const covered = (state: State) => state.diagnostics.map((d) => state.text.slice(d.from, d.to));

suite('Problems and fixes from another extension', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('a problem reported on a document open only in the rich editor reaches the panel at its word', async () => {
    const hook = await api();
    const uri = writeFile('problems/Only rich.md', TEXT);
    await openRich(uri);
    assert.ok(
      vscode.window.visibleTextEditors.every((e) => e.document.uri.toString() !== uri.toString()),
      'no text editor shows the document',
    );
    await waitFor(
      () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === HELPER_SOURCE).length === 2,
      'the helper to report on the document',
    );
    let state: State | null = null;
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.diagnostics.length === 2;
    }, 'the problems to reach the panel');
    note(`problems in the panel: ${JSON.stringify(state!.diagnostics)}`);
    assert.deepEqual(covered(state!), [FIXED_BY_EDIT.word, FIXED_BY_COMMAND.word]);
    assert.ok(state!.diagnostics.every((d) => d.severity === 'warning' && d.message.startsWith('Unknown word')));

    await hook.runInPanel(uri, [{ type: 'setMode', mode: 'view' }]);
    state = await hook.panelState(uri);
    assert.equal(state.mode, 'view');
    assert.deepEqual(covered(state), [FIXED_BY_EDIT.word, FIXED_BY_COMMAND.word], 'Rich view holds them too');
  });

  test('typing in the panel before a problem keeps it on its word', async () => {
    const hook = await api();
    const uri = writeFile('problems/Typing.md', TEXT);
    await openRich(uri);
    await waitFor(async () => (await hook.panelState(uri)).diagnostics.length === 2, 'the problems');
    const at = TEXT.indexOf('A ');
    let state = await hook.runInPanel(uri, [{ type: 'insert', at, text: 'Typed first. ' }]);
    // Before the typing is sent, and before the helper reports again, the problems are carried over it.
    assert.deepEqual(covered(state), [FIXED_BY_EDIT.word, FIXED_BY_COMMAND.word]);
    await hook.flush(uri);
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return documentFor(uri)?.getText().includes('Typed first.') === true && state.diagnostics.length === 2;
    }, 'the typing to reach the document');
    assert.deepEqual(covered(state), [FIXED_BY_EDIT.word, FIXED_BY_COMMAND.word]);
  });

  test('a fix by edit and a fix by command are applied by VS Code and are not marked', async () => {
    const hook = await api();
    const uri = writeFile('problems/Fixes.md', TEXT);
    await openRich(uri);
    await waitFor(async () => (await hook.panelState(uri)).diagnostics.length === 2, 'the problems');

    const inside = (word: string) => TEXT.indexOf(word) + 2;
    let state = await hook.runInPanel(uri, [
      { type: 'select', anchor: inside(FIXED_BY_EDIT.word), head: inside(FIXED_BY_EDIT.word) },
      { type: 'command', id: 'quickFix', args: { apply: 'first' } },
    ]);
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.text.includes(`A ${FIXED_BY_EDIT.fix} word`) && state.diagnostics.length === 1;
    }, 'the fix by edit to reach the panel');
    assert.equal(documentFor(uri)?.getText(), state.text);
    note(`after the fix by edit, marked lines: ${JSON.stringify(state.outsideMarked)}`);
    assert.deepEqual(state.outsideMarked, [], "a fix the user chose is not marked as another program's change");

    const at = state.text.indexOf(FIXED_BY_COMMAND.word) + 2;
    await hook.runInPanel(uri, [
      { type: 'select', anchor: at, head: at },
      { type: 'command', id: 'quickFix', args: { apply: 'first' } },
    ]);
    await waitFor(async () => {
      state = await hook.panelState(uri);
      return state.text.includes(`a ${FIXED_BY_COMMAND.fix} too`) && state.diagnostics.length === 0;
    }, 'the fix by command to reach the panel');
    note(`after the fix by command, marked lines: ${JSON.stringify(state.outsideMarked)}`);
    assert.deepEqual(state.outsideMarked, []);
    assert.equal(documentFor(uri)?.getText(), state.text);
  });
});
