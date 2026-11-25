// How a wikilink is read: from the parser's nodes, in either order around the bar; in plain
// text such as a front matter value; the wiki contents markers, which are not links; and a
// picture's size after the bar in a table cell, which is not shown text.

import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { isContentsMarker, linkAt, wikilinkOf, wikilinksIn } from '../../../src/panel/links/read';
import { cellReadings, fakeContext, gridsOf, stateOf } from '../helpers';

function linkIn(text: string, wikilinks: string) {
  const { ctx } = fakeContext({ settings: { syntax: { wikilinks } } });
  const state = stateOf(`‸${text}`, { ctx });
  let found: ReturnType<typeof wikilinkOf> | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (!found && (node.name === 'Wikilink' || node.name === 'Embed')) found = wikilinkOf(state.doc, node.node);
    },
  });
  return found;
}

describe('a wikilink read from its nodes', () => {
  it('takes the target and the shown text from either side of the bar, as the setting says', () => {
    expect(linkIn('[[Note#Part|shown]]', 'noteFirst')).toEqual({ target: 'Note', heading: 'Part', alias: 'shown' });
    expect(linkIn('[[shown|Note#Part]]', 'textFirst')).toEqual({ target: 'Note', heading: 'Part', alias: 'shown' });
  });

  it('links to the target the setting puts first', () => {
    const { ctx } = fakeContext({ settings: { syntax: { wikilinks: 'textFirst' } } });
    const state = stateOf('‸See [[the note|Folder/Note]] here.', { ctx });
    expect(linkAt(state, 6)).toMatchObject({ kind: 'wikilink', href: 'Folder/Note', target: 'Folder/Note' });
  });
});

describe('wikilinks in plain text', () => {
  it('finds each link by the parser rule, in either order', () => {
    const value = 'By [[Jane Doe]] and [[the topic|Topic#Part]], not [[a]b]] or [[open';
    expect(wikilinksIn(value, false).map((w) => [value.slice(w.from, w.to), w.link])).toEqual([
      ['[[Jane Doe]]', { target: 'Jane Doe' }],
      ['[[the topic|Topic#Part]]', { target: 'the topic', alias: 'Topic#Part' }],
    ]);
    expect(wikilinksIn(value, true).map((w) => w.link)).toEqual([
      { target: 'Jane Doe' },
      { target: 'Topic', heading: 'Part', alias: 'the topic' },
    ]);
  });

  it('needs a target or a heading', () => {
    expect(wikilinksIn('[[]] [[ ]] [[#Part]]', false).map((w) => w.link)).toEqual([{ target: '', heading: 'Part' }]);
  });
});

describe('the wiki contents markers', () => {
  it('are not links', () => {
    expect(isContentsMarker({ target: '_TOC_' })).toBe(true);
    expect(isContentsMarker({ target: '_TOSP_' })).toBe(true);
    expect(isContentsMarker({ target: 'toc' })).toBe(false);
    expect(isContentsMarker({ target: '_TOC_', alias: 'Contents' })).toBe(false);
    const state = stateOf('‸Pages [[_TOSP_]] and [[toc]].');
    expect(linkAt(state, 8)).toBeNull();
    expect(linkAt(state, 24)).toMatchObject({ kind: 'wikilink', target: 'toc' });
  });
});

describe('a wikilink in a table cell', () => {
  it("reads a picture's size after an escaped bar as its size, not as text to show", () => {
    const state = stateOf('‸| a | b |\n|---|---|\n| ![[pic.png\\|100]] | [[Note\\|shown]] |\n');
    const [[a, b] = [], [picture, link] = []] = cellReadings(gridsOf(state)[0]!);
    expect([a, b, link].map((cell) => cell!.text)).toEqual(['a', 'b', 'shown']);
    expect(picture!.text).toBe('[ImageWidget]');
    expect((picture!.widgets[0] as unknown as { spec: object }).spec).toMatchObject({
      address: '[[pic.png]]',
      alt: '',
      width: 100,
      height: null,
    });
  });
});
