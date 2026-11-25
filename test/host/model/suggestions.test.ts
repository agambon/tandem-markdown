// VS Code's completion items as the panel's suggestions, each snippet as plain text with the
// cursor's place in it.

import { describe, expect, it } from 'vitest';
import { textOf } from '../../../src/core/positions';
import { MAX_SUGGESTIONS, snippetText, suggestions, type RawSuggestion } from '../../../src/host/model/suggestions';

function item(label: string, extra: Partial<RawSuggestion> = {}): RawSuggestion {
  return { label, detail: '', snippet: false, snippetKind: false, hasExtraEdits: false, again: false, ...extra };
}

const at = (line: number, character: number) => ({ line, character });

describe("a snippet's plain text", () => {
  it('fills each placeholder with its default and puts the cursor at the first tab stop', () => {
    expect(snippetText('[${1:text}](${2:url})')).toEqual({ text: '[text](url)', cursor: 1 });
    expect(snippetText('a $2 b $1 c')).toEqual({ text: 'a  b  c', cursor: 5 });
  });

  it('puts the cursor at $0 only when there is no other tab stop, and at the end when there is none', () => {
    expect(snippetText('done$0 and $1more')).toEqual({ text: 'done and more', cursor: 9 });
    expect(snippetText('done$0')).toEqual({ text: 'done', cursor: 4 });
    expect(snippetText('plain')).toEqual({ text: 'plain', cursor: 5 });
  });

  it('takes the first option of a choice, nested defaults, and nothing for a variable', () => {
    expect(snippetText('${1|one,two|} x')).toEqual({ text: 'one x', cursor: 0 });
    expect(snippetText('${1:outer ${2:inner}}')).toEqual({ text: 'outer inner', cursor: 0 });
    expect(snippetText('$TM_FILENAME-${CURRENT_YEAR}-${name:fallback}')).toEqual({ text: '--fallback', cursor: 10 });
    expect(snippetText('${TM_FILENAME/(.*)/${1:/upcase}/}!')).toEqual({ text: '!', cursor: 1 });
  });

  it('keeps escaped characters as typed', () => {
    expect(snippetText('\\$5 and \\} and \\\\')).toEqual({ text: '$5 and } and \\', cursor: 14 });
  });

  it('keeps a dollar sign that starts nothing', () => {
    expect(snippetText('costs $ more ${')).toEqual({ text: 'costs $ more ${', cursor: 15 });
  });
});

describe("VS Code's completion items as suggestions", () => {
  const LINE = 'See [x](./notes/fo';
  const doc = textOf(`# Head\n${LINE}\n`);
  const cursor = doc.line(2).to;

  it('gives the place every item replaces from, and each item its text and cursor', () => {
    const result = suggestions(doc, cursor, [
      item('folder/', { range: { start: at(1, 16), end: at(1, 18) }, again: true, sortText: 'a' }),
      item('food.md', { range: { start: at(1, 16), end: at(1, 18) }, detail: 'File', sortText: 'b' }),
    ]);
    expect(result).toEqual({
      from: doc.line(2).from + 16,
      items: [
        { label: 'folder/', filter: 'folder/', detail: '', insert: 'folder/', cursor: 7, again: true },
        { label: 'food.md', filter: 'food.md', detail: 'File', insert: 'food.md', cursor: 7, again: false },
      ],
    });
  });

  it('sorts by the sort text, then the label, as VS Code does', () => {
    const range = { start: at(1, 16), end: at(1, 18) };
    const result = suggestions(doc, cursor, [
      item('b', { range }),
      item('a', { range, sortText: 'z' }),
      item('c', { range, sortText: '0' }),
    ]);
    expect('items' in result && result.items.map((i) => i.label)).toEqual(['c', 'b', 'a']);
  });

  it("leaves out VS Code's snippets, items that change text elsewhere and items on another line", () => {
    const range = { start: at(1, 16), end: at(1, 18) };
    const result = suggestions(doc, cursor, [
      item('snippet', { range, snippetKind: true }),
      item('extra', { range, hasExtraEdits: true }),
      item('above', { range: { start: at(0, 0), end: at(1, 18) } }),
      item('below', { range: { start: at(2, 0), end: at(2, 0) } }),
      item('kept', { range }),
    ]);
    expect('items' in result && result.items.map((i) => i.label)).toEqual(['kept']);
  });

  it('keeps the items that share the most common start', () => {
    const result = suggestions(doc, cursor, [
      item('one', { range: { start: at(1, 8), end: at(1, 18) } }),
      item('two', { range: { start: at(1, 16), end: at(1, 18) } }),
      item('three', { range: { start: at(1, 16), end: at(1, 18) } }),
    ]);
    expect(result).toMatchObject({ from: doc.line(2).from + 16 });
    expect('items' in result && result.items.map((i) => i.label)).toEqual(['three', 'two']);
  });

  it('replaces the run of characters before the cursor when an item gives no range', () => {
    const result = suggestions(doc, cursor, [item('food.md')]);
    expect(result).toMatchObject({ from: doc.line(2).from + 16 });
  });

  it('reads a snippet item as its text, with the cursor at its first tab stop', () => {
    const result = suggestions(doc, cursor, [
      item('heading', { range: { start: at(1, 16), end: at(1, 18) }, insertText: '#${1:heading}', snippet: true }),
    ]);
    expect('items' in result && result.items[0]).toMatchObject({ insert: '#heading', cursor: 1 });
  });

  it('sends at most MAX_SUGGESTIONS', () => {
    const range = { start: at(1, 16), end: at(1, 18) };
    const many = Array.from({ length: MAX_SUGGESTIONS + 10 }, (_, i) => item(`f${i}`, { range }));
    const result = suggestions(doc, cursor, many);
    expect('items' in result && result.items).toHaveLength(MAX_SUGGESTIONS);
  });

  it('answers with no items at the cursor when nothing can be offered', () => {
    expect(suggestions(doc, cursor, [])).toEqual({ from: cursor, items: [] });
  });
});
