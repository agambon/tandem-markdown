// Find and replace. The panel itself is DOM and is checked in the browser
// (harness/tests/find-paste.spec.mjs); here: counting, the label, where typing lands, what
// Replace and Replace all dispatch, and the text highlighted next to a hidden match in Rich view.

import { getSearchQuery, replaceAll, replaceNext, SearchQuery, setSearchQuery } from '@codemirror/search';
import { EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { panelCommands } from '../../../src/panel/commands/registry';
import { nearestVisible } from '../../../src/panel/render/inlineDom';
import { COUNT_LIMIT, countLabel, currentMatch, listMatches, matchFrom, withQuery } from '../../../src/panel/ui/search';
import { standInView, stateOf } from '../helpers';

const q = (
  search: string,
  options: Partial<{ caseSensitive: boolean; wholeWord: boolean; regexp: boolean; replace: string }> = {},
) => new SearchQuery({ search, literal: true, ...options });

describe('counting matches', () => {
  const state = stateOf('Lantern, lantern; LANTERN lanterns.‸');

  it('counts with and without case and whole word', () => {
    expect(listMatches(state, q('lantern')).starts).toHaveLength(4);
    expect(listMatches(state, q('lantern', { caseSensitive: true })).starts).toHaveLength(2);
    expect(listMatches(state, q('lantern', { wholeWord: true })).starts).toHaveLength(3);
    expect(listMatches(state, q('lantern', { caseSensitive: true, wholeWord: true })).starts).toEqual([9]);
  });

  it('counts a regular expression, and nothing for one that is not valid', () => {
    expect(listMatches(state, q('l\\w+n\\b', { regexp: true })).starts).toHaveLength(3);
    expect(listMatches(state, q('lan(', { regexp: true })).starts).toEqual([]);
  });

  it('searches for backslashes as typed (not as escapes)', () => {
    const tex = stateOf('Use \\textbf and \\n here‸');
    expect(listMatches(tex, q('\\n')).starts).toEqual([tex.doc.toString().indexOf('\\n')]);
    expect(listMatches(tex, q('\\t')).starts).toEqual([4]);
  });

  it('stops counting at the limit and says so', () => {
    const many = stateOf(`${'a '.repeat(COUNT_LIMIT + 5)}‸`);
    const list = listMatches(many, q('a'));
    expect(list.starts).toHaveLength(COUNT_LIMIT);
    expect(list.capped).toBe(true);
    expect(countLabel(q('a'), list, 3)).toBe(`3 of ${COUNT_LIMIT}+`);
  });

  it('numbers the match the selection is on', () => {
    const list = listMatches(state, q('lantern'));
    expect(currentMatch(list, EditorSelection.range(9, 16))).toBe(2);
    expect(currentMatch(list, EditorSelection.range(0, 7))).toBe(1);
    expect(currentMatch(list, EditorSelection.cursor(9))).toBe(0);
    expect(currentMatch(list, EditorSelection.range(9, 15))).toBe(0);
  });

  it('labels the count as VS Code does', () => {
    const list = listMatches(state, q('lantern'));
    expect(countLabel(q('lantern'), list, 2)).toBe('2 of 4');
    expect(countLabel(q('lantern'), list, 0)).toBe('? of 4');
    expect(countLabel(q('zebra'), listMatches(state, q('zebra')), 0)).toBe('No results');
    expect(countLabel(q(''), listMatches(state, q('')), 0)).toBe('');
    expect(countLabel(q('a(', { regexp: true }), listMatches(state, q('a(', { regexp: true })), 0)).toBe(
      'Invalid expression',
    );
  });
});

describe('where typing in the find field lands', () => {
  it('takes the first match from the selection, wrapping to the start', () => {
    const state = stateOf('one two one two‸');
    expect(matchFrom(state, q('two'), 0)).toEqual({ from: 4, to: 7 });
    expect(matchFrom(state, q('two'), 5)).toEqual({ from: 12, to: 15 });
    expect(matchFrom(state, q('one'), 9)).toEqual({ from: 0, to: 3 });
    expect(matchFrom(state, q('none'), 0)).toBeNull();
  });

  it("keeps the query's other settings when one changes", () => {
    const next = withQuery(q('a', { caseSensitive: true, replace: 'b' }), { wholeWord: true });
    expect([next.search, next.caseSensitive, next.wholeWord, next.replace, next.literal]).toEqual([
      'a',
      true,
      true,
      'b',
      true,
    ]);
  });
});

describe('replace', () => {
  function withQueryIn(text: string, query: SearchQuery, selection?: [number, number]) {
    let state = stateOf(text).update({ effects: setSearchQuery.of(query) }).state;
    if (selection) state = state.update({ selection: EditorSelection.single(...selection) }).state;
    return standInView(state);
  }

  it('replaces the current match and moves to the next, as one change that is not typing', () => {
    const view = withQueryIn('cat cat cat‸', q('cat', { replace: 'dog' }), [4, 7]);
    expect(replaceNext(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('cat dog cat');
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 11 });
    const tr = withQueryIn('cat cat cat‸', q('cat', { replace: 'dog' }), [4, 7]).state.update(view.specs[0]!);
    expect(tr.isUserEvent('input.replace')).toBe(true);
    expect(tr.isUserEvent('input.type')).toBe(false);
  });

  it('replaces every match in one change', () => {
    const view = withQueryIn('a1 b2 c3‸', q('(\\w)(\\d)', { regexp: true, replace: '$2$1' }));
    expect(replaceAll(view)).toBe(true);
    expect(view.specs).toHaveLength(1);
    expect(view.state.doc.toString()).toBe('1a 2b 3c');
    const tr = withQueryIn('a1 b2 c3‸', q('(\\w)(\\d)', { regexp: true, replace: '$2$1' })).state.update(
      view.specs[0]!,
    );
    expect(tr.isUserEvent('input.replace.all')).toBe(true);
    expect(tr.isUserEvent('input.type')).toBe(false);
  });

  it('cannot replace in Rich view', () => {
    let state = stateOf('cat‸', { mode: 'view' }).update({
      effects: setSearchQuery.of(q('cat', { replace: 'dog' })),
    }).state;
    state = state.update({ selection: EditorSelection.single(0, 3) }).state;
    const view = standInView(state);
    expect(replaceAll(view)).toBe(false);
    expect(replaceNext(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('cat');
  });

  it('searches literally by default', () => {
    expect(getSearchQuery(stateOf('x‸')).literal).toBe(true);
  });

  it('puts find and replace in the editor as commands', () => {
    const commands = stateOf('x‸').facet(panelCommands);
    expect(commands.has('find')).toBe(true);
    expect(commands.has('replace')).toBe(true);
  });
});

describe('the visible text nearest a hidden match (Rich view)', () => {
  const doc = (text: string) => ({ length: text.length, sliceString: (a: number, b: number) => text.slice(a, b) });
  const linkText = 'See [the guide](https://example.com/lantern) now';
  const urlFrom = linkText.indexOf('https');
  const hidden = [
    { from: 4, to: 5, widget: false }, // [
    { from: linkText.indexOf(']('), to: linkText.indexOf(' now'), widget: false }, // ](address)
  ];

  it("marks the word just before a match hidden inside a link's address", () => {
    const match = { from: urlFrom + 'https://example.com/'.length, to: urlFrom + 'https://example.com/lantern'.length };
    expect(nearestVisible(doc(linkText), hidden, match.from, match.to)).toEqual({ from: 9, to: 14 }); // "guide"
  });

  it('marks the word after when nothing shows before it on the line', () => {
    const heading = '# Lantern notes';
    expect(nearestVisible(doc(heading), [{ from: 0, to: 2, widget: false }], 0, 1)).toEqual({ from: 2, to: 9 });
  });

  it('marks nothing when part of the match shows, or a widget stands for it', () => {
    expect(nearestVisible(doc(linkText), hidden, 2, 6)).toBeNull();
    expect(nearestVisible(doc('| a |\n| - |'), [{ from: 0, to: 11, widget: true }], 2, 3)).toBeNull();
  });

  it('looks to the nearer of the lines around a hidden line', () => {
    const text = 'Before\n<!-- lantern -->\nAfter';
    const comment = { from: 7, to: 23, widget: false };
    expect(nearestVisible(doc(text), [comment], 12, 19)).toEqual({ from: 24, to: 29 }); // "After", 5 away; "Before" is 7
    expect(nearestVisible(doc(text), [comment], 8, 10)).toEqual({ from: 0, to: 6 });
  });
});
