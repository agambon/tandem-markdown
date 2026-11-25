// What a screen reader is told of changes from outside, through PanelSync as a panel receives
// them: which lines count and how, where they are, and what decides whether the sentence on the
// line the cursor is on may say the person's cursor and unsaved typing are as they left them.

import type { EditorState, StateEffect } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { dropNews, newsField, toldNews, unsavedNews } from '../../../src/panel/announce/news';
import { toldOf, toldOnYourLine } from '../../../src/panel/announce/places';
import { createEditorState } from '../../../src/panel/editor';
import { withFullTree } from '../../../src/panel/render/framework';
import { fakeContext, SyncedPanel, type HostChange } from '../helpers';

/** A panel with every feature over PanelSync, and a host log that sends it updates. */
class World extends SyncedPanel {
  constructor(text: string) {
    super(text, (sync) => createEditorState({ ctx: fakeContext().ctx, text, mode: 'edit', sync }));
  }
  /** The state with its whole tree parsed, as the sentences read it. */
  get parsed(): EditorState {
    return withFullTree(this.state);
  }
  get news() {
    return this.state.field(newsField);
  }
  /** One update from another program, as a merge. */
  outside(changes: HostChange[]): void {
    this.receive(this.update(changes, 'merge'));
  }
  select(head: number): void {
    this.apply({ selection: { anchor: head } });
  }
  effect(e: StateEffect<unknown>): void {
    this.apply({ effects: e });
  }
  told() {
    return toldOf(this.parsed, this.news.lines, this.news.gone, () => null, 'Field notes.md', false);
  }
}

const world = (text: string) => new World(text);

const NOTE = '# Route\n\nwalk\n\n# Questions\n\none\ntwo\nthree\n';
const at = (needle: string, text = NOTE) => text.indexOf(needle);
const under = (...names: string[]) => names.map((name) => ({ name, isNew: false }));

describe('what a change from outside is told as', () => {
  it('counts reworded lines as changed, whole lines put in as added, and whole lines deleted as taken out', () => {
    const reworded = world(NOTE);
    reworded.outside([
      { from: at('one'), to: at('one') + 3, insert: 'ONE' },
      { from: at('two'), to: at('two') + 3, insert: 'TWO' },
    ]);
    expect(reworded.told()).toMatchObject({
      shape: 'changed',
      count: 2,
      unit: 'line',
      place: { headings: under('Questions') },
    });

    const added = world(NOTE);
    added.outside([{ from: NOTE.length, insert: 'four\nfive\nsix\n' }]);
    expect(added.told()).toMatchObject({ shape: 'added', count: 3, place: { headings: under('Questions') } });

    const takenOut = world(NOTE);
    takenOut.outside([{ from: at('one'), to: at('three') }]);
    expect(takenOut.told()).toMatchObject({ shape: 'tookOut', count: 2, place: { headings: under('Questions') } });

    const inLine = world(NOTE);
    inLine.outside([{ from: at('walk') + 1, to: at('walk') + 2 }]);
    expect(inLine.told()).toMatchObject({ shape: 'changed', count: 1, place: { headings: under('Route') } });

    // Two lines joined: one reworded, one gone.
    const joined = world(NOTE);
    joined.outside([{ from: at('\ntwo'), to: at('\ntwo') + 1, insert: ' ' }]);
    expect(joined.told()).toMatchObject({ shape: 'changed', count: 2 });
  });

  it('names a new heading, and an empty one, with the heading with words next to it', () => {
    const w = world(NOTE);
    w.outside([{ from: NOTE.length, insert: '\n# Sightings\n\nheron\n' }]);
    expect(w.told()).toMatchObject({
      shape: 'added',
      count: 4,
      place: { headings: [{ name: 'Sightings', isNew: true, nextTo: { side: 'after', name: 'Questions' } }] },
    });

    const empty = '#\n\nfirst\n\n# Route\n\nwalk\n\n#\n\nlast\n';
    const after = world(empty);
    after.outside([{ from: at('last', empty), insert: 'the ' }]);
    expect(after.told()).toMatchObject({
      place: { headings: [{ name: '', nextTo: { side: 'after', name: 'Route' } }] },
    });
    const before = world(empty);
    before.outside([{ from: at('first', empty), insert: 'the ' }]);
    expect(before.told()).toMatchObject({
      place: { headings: [{ name: '', nextTo: { side: 'before', name: 'Route' } }] },
    });
  });

  it('quotes the first words of a line the change is at, in a note with no headings', () => {
    const plain = 'a\nb\nc\nd\n- [ ] buy milk and eggs for the week\nf\n';
    const on = world(plain);
    on.outside([{ from: at('week', plain), insert: 'whole ' }]);
    expect(on.told()).toMatchObject({
      place: { thirds: ['last'], quote: { words: 'buy milk and eggs for', at: 'on' } },
    });
    const above = world(plain);
    above.outside([{ from: at('b', plain), to: at('d', plain) }]);
    expect(above.told()).toMatchObject({ shape: 'tookOut', place: { quote: { words: 'd', at: 'above' } } });
    const below = world(plain);
    below.outside([{ from: plain.lastIndexOf('f\n'), to: plain.length }]);
    expect(below.told()).toMatchObject({
      shape: 'tookOut',
      place: { quote: { words: 'buy milk and eggs for', at: 'below' } },
    });
  });

  it('places a change above the first heading, under several headings, and in thirds of a note with none', () => {
    const top = world(`intro\n\n${NOTE}`);
    top.outside([{ from: 0, to: 5, insert: 'INTRO' }]);
    expect(top.told()).toMatchObject({ place: { aboveFirst: true, headings: [] } });

    const both = world(NOTE);
    both.outside([
      { from: at('walk'), insert: 'x' },
      { from: at('three'), insert: 'y' },
    ]);
    expect(both.told()).toMatchObject({ count: 2, place: { headings: under('Route', 'Questions') } });

    const plain = 'a\nb\nc\nd\ne\nf\n';
    const none = world(plain);
    none.outside([{ from: at('f', plain), insert: 'F' }]);
    expect(none.told()).toMatchObject({ place: { headings: [], thirds: ['last'] } });
  });

  it('counts a table by its rows, never its line of dashes, and names the front matter', () => {
    const table = '# Birds seen\n\n| Bird | Count |\n| --- | --- |\n| Heron | 1 |\n| Owl | 2 |\n';
    const w = world(table);
    w.outside([
      { from: at('1 |', table), to: at('1 |', table) + 1, insert: '3' },
      { from: at('2 |', table), to: at('2 |', table) + 1, insert: '4' },
    ]);
    expect(w.told()).toMatchObject({ count: 2, unit: 'row', block: { name: 'a table', lines: 2 } });

    const columns = world(table);
    columns.outside([
      { from: at(' |\n| ---', table) + 2, insert: ' Where |' },
      { from: at('--- |\n', table) + 5, insert: ' --- |' },
    ]);
    expect(columns.told()).toMatchObject({ count: 1, unit: 'row' });

    const front = '---\ntitle: Field notes\ntags: birds\n---\n\n# Route\n';
    const f = world(front);
    f.outside([{ from: at('birds', front), to: at('birds', front) + 5, insert: 'owls' }]);
    expect(f.told()).toMatchObject({ frontMatter: true, count: 1 });
  });

  it('counts a grid table by the rows its changed lines are in, and lines taken out of it as lines', () => {
    const grid = [
      '# Birds seen',
      '',
      '+-------+-------+',
      '| Bird  | Count |',
      '+=======+=======+',
      '| Heron | 1     |',
      '| grey  |       |',
      '+-------+-------+',
      '| Owl   | 2     |',
      '+-------+-------+',
      '',
    ].join('\n');
    const oneRow = world(grid);
    oneRow.outside([
      { from: at('Heron', grid), to: at('Heron', grid) + 5, insert: 'Egret' },
      { from: at('grey', grid), to: at('grey', grid) + 4, insert: 'pale' },
    ]);
    expect(oneRow.told()).toMatchObject({ count: 1, unit: 'row', block: { name: 'a table', lines: 1 } });

    const twoRows = world(grid);
    twoRows.outside([
      { from: at('grey', grid), to: at('grey', grid) + 4, insert: 'pale' },
      { from: at('2 ', grid), to: at('2 ', grid) + 1, insert: '3' },
    ]);
    expect(twoRows.told()).toMatchObject({ count: 2, unit: 'row' });

    const border = world(grid);
    border.outside([{ from: at('+=', grid) + 1, to: at('+=', grid) + 2, insert: ':' }]);
    expect(border.told()).toMatchObject({ count: 1, unit: 'row' });

    // The row of Owl and the border above it: which rows lines taken out were is gone with them.
    const takenOut = world(grid);
    const line = '+-------+-------+\n'.length;
    takenOut.outside([{ from: at('| Owl', grid) - line, to: at('| Owl', grid) + line }]);
    expect(takenOut.told()).toMatchObject({
      shape: 'tookOut',
      count: 2,
      unit: 'line',
      block: { name: 'a table', lines: 2 },
    });
  });

  it('gathers nothing for typing in Source, undo, redo or this tab', () => {
    const w = world(NOTE);
    w.receive(w.update([{ from: at('one'), insert: 'x' }]));
    w.receive(w.update([{ from: at('two') + 1, insert: 'y' }], 'undo'));
    w.type(0, 'z');
    expect(w.told()).toBeNull();
    expect(w.news.typing.length).toBeGreaterThan(0);
  });

  it("gathers nothing for the person's press of a notice's button, and the change beside it as any", () => {
    const w = world(NOTE);
    w.receive(w.update([{ from: at('one'), to: at('one') + 3, insert: 'ONE' }], 'press'));
    w.outside([{ from: at('walk'), insert: 'y' }]);
    expect(w.told()).toMatchObject({ shape: 'changed', count: 1, place: { headings: under('Route') } });
  });

  it('drops what a message tells of, and does not gather again what was told', () => {
    const w = world(NOTE);
    w.outside([{ from: at('one'), insert: 'x' }]);
    w.outside([{ from: at('walk'), insert: 'y' }]);
    w.effect(dropNews.of((version) => version === 1));
    expect(w.told()).toMatchObject({ count: 1, place: { headings: under('Route') } });
    w.effect(toldNews.of(2));
    expect(w.told()).toBeNull();
  });
});

describe('the cursor and the unsaved typing', () => {
  it('are touched by a change at the unsent typing or the cursor, and not by one elsewhere', () => {
    const away = world(NOTE);
    away.type(at('three') + 5, ' typed');
    away.outside([{ from: at('walk'), insert: 'x' }]);
    expect(away.news.touched).toBe(false);

    const there = world(NOTE);
    there.type(at('three') + 5, ' typed');
    there.outside([{ from: at('three'), to: at('three') + 5, insert: 'THREE' }]);
    expect(there.news.touched).toBe(true);

    const cursor = world(NOTE);
    cursor.select(at('two') + 1);
    cursor.outside([{ from: at('two'), to: at('two') + 3, insert: 'TWO' }]);
    expect(cursor.news.touched).toBe(true);
  });

  it('forget what was saved, but not what this tab has not sent', () => {
    const w = world(NOTE);
    w.effect(unsavedNews.of({ held: false, first: true }));
    expect(w.news.typingKnown).toBe(true);
    w.type(at('three') + 5, ' typed');
    w.effect(unsavedNews.of({ held: false, first: false }));
    expect(w.news.typing).toEqual([{ from: at('three') + 5, to: at('three') + 11 }]);

    const dirty = world(NOTE);
    dirty.effect(unsavedNews.of({ held: true, first: true }));
    expect(dirty.news.typingKnown).toBe(false);
  });

  it('are told of on the line the cursor is on, with the other lines and where they are', () => {
    const w = world(NOTE);
    w.select(at('two') + 1);
    w.outside([
      { from: at('two') + 2, insert: '!' },
      { from: at('walk'), insert: 'x' },
    ]);
    const n = w.news;
    const place = (name: string) => ({
      aboveFirst: false,
      headings: [{ name, isNew: false, nextTo: null }],
      thirds: [],
      quote: null,
    });
    expect(toldOnYourLine(w.parsed, n.lines, n.gone, 'cursorNoTyping')).toEqual({
      more: 1,
      place: place('Route'),
      yours: place('Questions'),
      kept: 'cursorNoTyping',
    });
  });
});
