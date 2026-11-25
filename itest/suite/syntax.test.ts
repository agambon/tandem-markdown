/// <reference types="mocha" />
// The optional syntax in a real VS Code: the `tandemMarkdown.syntax.*` settings reach the panel,
// defaults included, and turning one off redraws an open panel without touching the document;
// KaTeX loads its stylesheet and fonts from the extension's own files under the page's policy;
// and a tag followed with Alt+Enter (the panel command `openLink`) opens VS Code's search. What
// each syntax draws is checked in the browser (harness/tests/syntax.spec.mjs).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { errorMessage } from '../../src/core/errors';
import { api, openRich, setSetting, undoAfterEach, waitFor, writeFile } from './helpers';

const TEXT = 'Nice :smile: and $a^2$ here, #topic.\n\n$$\nx^2\n$$\n';

/** How long a refusal (a font the policy blocks, a search VS Code turns down) is given to be reported; none may be. */
const REFUSAL_MS = 1500;

/**
 * Waits until the panel's drawn widgets hold every class in `classes`, and none holds
 * `waiting` (a drawing whose library has not loaded). On a timeout the error says what the
 * panel drew and logged, so a drawing that never came says why.
 */
async function waitForDrawn(uri: vscode.Uri, classes: string[], what: string, waiting?: string): Promise<void> {
  const hook = await api();
  try {
    await waitFor(async () => {
      const widgets = (await hook.panelState(uri)).widgets.join(' ');
      return classes.every((c) => widgets.includes(c)) && !(waiting && widgets.includes(waiting));
    }, what);
  } catch (error) {
    const state = await hook.panelState(uri);
    const lines = hook.logLines().map((line) => JSON.stringify(line));
    throw new Error(
      `${errorMessage(error)}\n` +
        `widgets: ${JSON.stringify(state.widgets)}\npolicy reports: ${JSON.stringify(state.cspViolations)}\n` +
        `log:\n${lines.join('\n')}`,
    );
  }
}

suite('Optional syntax', () => {
  const restore = undoAfterEach();

  test('the defaults reach the panel, and turning a syntax off redraws it as typed', async () => {
    const hook = await api();
    const uri = writeFile('syntax/Note.md', TEXT);
    await openRich(uri);
    await waitForDrawn(
      uri,
      ['tm-emoji', 'tm-math', 'tm-drawn'],
      'the emoji, the formula and the math block to be drawn',
    );

    restore.push(await setSetting('tandemMarkdown', 'syntax.emoji', false));
    await waitFor(
      async () => !(await hook.panelState(uri)).widgets.join(' ').includes('tm-emoji'),
      'the emoji to show as typed',
    );
    const state = await hook.panelState(uri);
    assert.equal(state.text, TEXT, 'the document is as it was');
    assert.ok(state.widgets.join(' ').includes('tm-math'), 'math is still drawn');
  });

  test('a setting with choices reaches the panel by its value, and off redraws as typed', async () => {
    const hook = await api();
    const text = 'A picture ![[picture.png]] and a note.^[In place.]\n';
    const uri = writeFile('syntax/Choices.md', text);
    await openRich(uri);
    const drawn = async (cls: string) => (await hook.panelState(uri)).widgets.join(' ').includes(cls);
    await waitFor(
      async () => (await drawn('tm-image')) && (await drawn('tm-footnote-ref')),
      'the picture and the note',
    );

    restore.push(await setSetting('tandemMarkdown', 'syntax.wikilinks', 'off'));
    await waitFor(async () => !(await drawn('tm-image')), 'the embed to show as typed');
    assert.ok(await drawn('tm-footnote-ref'), 'the note is still drawn');

    await setSetting('tandemMarkdown', 'syntax.wikilinks', 'textFirst');
    await waitFor(async () => drawn('tm-image'), 'the embed to be drawn again');
    assert.equal((await hook.panelState(uri)).text, text, 'the document is as it was');
  });

  test('math draws under the page policy, with its stylesheet and fonts from the extension', async () => {
    const hook = await api();
    const uri = writeFile('syntax/Math.md', TEXT);
    await openRich(uri);
    await waitForDrawn(uri, ['tm-drawn'], 'the math block', 'tm-drawn-waiting');
    // KaTeX has drawn the block; its fonts load as it is first laid out. A refused font raises a
    // policy report, which the panel keeps and logs.
    await new Promise((resolve) => setTimeout(resolve, REFUSAL_MS));
    assert.deepEqual((await hook.panelState(uri)).cspViolations, []);
  });

  test('Alt+Enter on a tag runs the search for it without a fault', async () => {
    const hook = await api();
    const uri = writeFile('syntax/Tag.md', 'Plan #topic today.\n');
    await openRich(uri);
    hook.clearRecords();
    await hook.runInPanel(uri, [
      { type: 'select', anchor: 7, head: 7 },
      { type: 'command', id: 'openLink' },
    ]);
    // A search that VS Code refused would come back to the panel as an error, which it logs.
    await new Promise((resolve) => setTimeout(resolve, REFUSAL_MS));
    const lines = hook.logLines().map((line) => JSON.stringify(line));
    assert.ok(!lines.some((line) => /searching for a tag|searchTag/i.test(line)), lines.join('\n'));
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
  });
});
