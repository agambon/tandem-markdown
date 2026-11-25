/// <reference types="mocha" />
// The status bar and the outline, in a real VS Code with the real panel. Nothing here types into
// a document: files are written from outside, opened in the rich editor, and the status bar and
// the tree are read back through the test hook.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { countWords } from '../../src/core/words';
import { api, closeEverything, note, openRich, openText, waitFor, writeFile } from './helpers';

const statusBar = async () => (await api()).statusBar();
const outline = async () => (await api()).outline();

/** The count text written out here, apart from the code under test. */
const wordsText = (n: number) => (n === 0 ? 'No words' : `${n.toLocaleString('en-US')} ${n === 1 ? 'word' : 'words'}`);

const FRONTMATTER = '---\ntitle: Status and outline\ntags: [one, two, three]\n---';
const paragraphs = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `Paragraph ${from + i} has a few words in it, enough to fill most of a line in the panel.\n`,
  ).join('\n');
const SAMPLE = [
  FRONTMATTER,
  '# Status and outline',
  '',
  'An opening paragraph before the first part.',
  '',
  '## First part',
  '',
  paragraphs(1, 20),
  '### A detail',
  '',
  paragraphs(21, 20),
  '## Second part',
  '',
  paragraphs(41, 40),
  '### Another detail',
  '',
  paragraphs(81, 20),
  '## Last part',
  '',
  paragraphs(101, 2),
].join('\n');

const EXPECTED_OUTLINE: [string, number][] = [
  ['Status and outline', 0],
  ['First part', 1],
  ['A detail', 2],
  ['Second part', 1],
  ['Another detail', 2],
  ['Last part', 1],
];

/** Offset of the start of the line that is exactly `line`. */
const lineStart = (text: string, line: string) => {
  const at = text.indexOf(`\n${line}\n`);
  assert.ok(at >= 0, `the sample holds the line ${line}`);
  return at + 1;
};
const lineNumber = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1;

suite('Status bar and outline', () => {
  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('the count matches countWords, the outline lists the headings, and choosing one scrolls the panel', async () => {
    const hook = await api();
    const uri = writeFile('status-outline.md', SAMPLE);
    await openRich(uri);
    // The outline builds its headings only while it is in sight.
    await vscode.commands.executeCommand('tandemMarkdown.outline.focus');

    // The status bar: the count of the text after the front matter, and the view's name.
    const total = countWords(SAMPLE.slice(FRONTMATTER.length)).words;
    await waitFor(
      async () => {
        const s = await statusBar();
        return s.visible && s.count.text === wordsText(total);
      },
      `the status bar to show "${wordsText(total)}"`,
    );
    const record = () => hook.coordinatorState(uri)!.panels[0]!;
    const bar = await statusBar();
    assert.equal(
      bar.view.text,
      record().mode === 'edit' ? 'Rich editor' : 'Rich view',
      "the view's name matches the panel's mode",
    );
    assert.equal(bar.view.command, 'tandemMarkdown.switchView');
    note(`status bar: "${bar.count.text}" (tooltip "${bar.count.tooltip}"), "${bar.view.text}"`);

    // A selection is counted against the whole.
    const from = SAMPLE.indexOf('Paragraph 3 has');
    const to = from + 'Paragraph 3 has a few words'.length;
    await hook.runInPanel(uri, [{ type: 'select', anchor: from, head: to }]);
    const part = countWords(SAMPLE.slice(from, to)).words;
    const partText = `${part} of ${total.toLocaleString('en-US')} words`;
    await waitFor(async () => (await statusBar()).count.text === partText, `the status bar to show "${partText}"`);
    await hook.runInPanel(uri, [{ type: 'select', anchor: from, head: from }]);
    await waitFor(async () => (await statusBar()).count.text === wordsText(total), 'the count of the whole again');

    // The outline: the file's headings in order, nested by level, each running revealHeading at its line.
    await waitFor(async () => {
      const o = await outline();
      return o.visible && o.items.length === EXPECTED_OUTLINE.length;
    }, 'the outline to list the headings');
    const tree = await outline();
    assert.deepEqual(
      tree.items.map((i) => [i.label, i.depth]),
      EXPECTED_OUTLINE,
    );
    assert.equal(tree.message, null);
    for (const [i, item] of tree.items.entries()) {
      const hashes = '#'.repeat(EXPECTED_OUTLINE[i]![1] + 1);
      assert.equal(item.command, 'tandemMarkdown.revealHeading');
      assert.deepEqual(
        item.arguments,
        [{ from: lineStart(SAMPLE, `${hashes} ${item.label}`) }],
        `${item.label}: its line's offset`,
      );
    }

    // Choosing "Second part" scrolls the panel so that its line is the first one in view.
    await waitFor(() => record().viewState !== undefined, 'the panel to report where it is');
    const before = record().viewState!.topLine;
    const chosen = tree.items[3]!;
    const line = lineNumber(SAMPLE, (chosen.arguments[0] as { from: number }).from);
    await vscode.commands.executeCommand(chosen.command!, ...chosen.arguments);
    await waitFor(() => {
      const vs = record().viewState!;
      return vs.topLine !== before && (vs.topLine === line || vs.topLine === line - 1);
    }, `the panel's top line to move to line ${line}`);
    const vs = record().viewState!;
    note(`top line ${before} before, ${vs.topLine} (${vs.topOffsetPx} px in) after choosing line ${line}`);
    assert.ok(
      vs.topLine === line ? vs.topOffsetPx === 0 : vs.topOffsetPx > 0,
      'the heading is the first line whose start is in view',
    );

    // The heading the panel is scrolled to is selected in the tree.
    await waitFor(async () => (await outline()).selection.join() === '3', 'the tree to select "Second part"');

    // A file with nothing after its front matter: no words, no headings.
    const empty = writeFile('status-outline-empty.md', '---\ntitle: Words that are not counted\n---\n');
    await openRich(empty);
    await waitFor(async () => {
      const [s, o] = [await statusBar(), await outline()];
      return (
        s.visible && s.count.text === 'No words' && o.items.length === 0 && o.message === 'No headings in this file.'
      );
    }, 'the status bar to show "No words" and the outline its message');

    // Neither shows while the active editor is not ours.
    await openText(uri);
    await waitFor(async () => !(await statusBar()).visible, 'the status bar items to hide');
  });
});
