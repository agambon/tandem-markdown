/// <reference types="mocha" />
// What document tools write, in a real VS Code: a link to an id written in a heading's
// attributes, or in a bookmark Word left, jumps to it through the host (src/host/links), and the
// outline shows a heading without its attributes. What each construct draws is checked in the
// browser (harness/tests/syntax.spec.mjs).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { api, closeEverything, openRich, waitFor, writeFile } from './helpers';

const filler = Array.from(
  { length: 60 },
  (_, i) => `Filler paragraph ${i + 1}, so the targets stand well down.\n`,
).join('\n');

const TEXT = [
  '# Start',
  '',
  'Go to [the introduction](#intro) or to [the bookmark](#_Toc42).',
  '',
  filler,
  '## Introduction {#intro .big}',
  '',
  filler,
  'A paragraph with []{#_Toc42 .anchor}a bookmark Word left.',
  '',
  filler,
].join('\n');

const at = (needle: string) => {
  const i = TEXT.indexOf(needle);
  assert.ok(i >= 0, `the text holds ${needle}`);
  return i;
};

suite('What document tools write', () => {
  teardown(() => closeEverything());

  test("links jump to a heading's id and to a bookmark's", async () => {
    const hook = await api();
    const uri = writeFile('boxes/Ids.md', TEXT);
    await openRich(uri);
    const headingLine = TEXT.slice(0, at('## Introduction')).split('\n').length - 1;
    const bookmarkLine = TEXT.slice(0, at('A paragraph with')).split('\n').length - 1;
    const lineOfCursor = async () => {
      const state = await hook.panelState(uri);
      return TEXT.slice(0, state.selection.anchor).split('\n').length - 1;
    };

    await hook.runInPanel(uri, [{ type: 'command', id: 'openLink', args: { at: at('the introduction') } }]);
    await waitFor(async () => (await lineOfCursor()) === headingLine, 'the cursor to go to the heading with the id');

    await hook.runInPanel(uri, [{ type: 'command', id: 'openLink', args: { at: at('the bookmark') } }]);
    await waitFor(async () => (await lineOfCursor()) === bookmarkLine, 'the cursor to go to the bookmark');
    assert.equal((await hook.panelState(uri)).text, TEXT, 'the document is as it was');
  });

  test('the outline shows a heading without its attributes', async () => {
    const hook = await api();
    const uri = writeFile('boxes/Outline.md', TEXT);
    await openRich(uri);
    // The outline builds its headings only while it is in sight.
    await vscode.commands.executeCommand('tandemMarkdown.outline.focus');
    const labels = () => hook.outline().items.map((item) => item.label);
    await waitFor(() => labels().includes('Introduction'), 'the heading in the outline, without its braces');
    assert.ok(!labels().some((label) => label.includes('{')), `no braces in the outline: ${labels().join(', ')}`);
  });
});
