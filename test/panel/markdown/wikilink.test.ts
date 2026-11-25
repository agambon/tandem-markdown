import { describe, expect, it } from 'vitest';
import { parserFor } from '../../../src/panel/markdown';
import { testSettings } from '../helpers';
import { find, findIn } from './treeHelpers';

const parts = (text: string) =>
  find(text, 'Wikilink', 'Embed', 'WikilinkMark', 'WikilinkTarget', 'WikilinkAlias').map((n) => `${n.name}:${n.text}`);

describe('wikilinks', () => {
  it('reads target, alias and marks', () => {
    expect(parts('See [[Folder/Note#Part|the note]] here.')).toEqual([
      'Wikilink:[[Folder/Note#Part|the note]]',
      'WikilinkMark:[[',
      'WikilinkTarget:Folder/Note#Part',
      'WikilinkMark:|',
      'WikilinkAlias:the note',
      'WikilinkMark:]]',
    ]);
  });

  it('reads an embed', () => {
    expect(parts('![[image.png]]')).toEqual([
      'Embed:![[image.png]]',
      'WikilinkMark:![[',
      'WikilinkTarget:image.png',
      'WikilinkMark:]]',
    ]);
    expect(find('![[image.png]]', 'Image')).toEqual([]);
  });

  it('wins over an ordinary link', () => {
    expect(find('[[Note]]', 'Link')).toEqual([]);
    expect(find('[[Note]](https://example.com)', 'Wikilink').length).toBe(1);
  });

  it('is not read inside code', () => {
    expect(find('`[[Note]]`', 'Wikilink')).toEqual([]);
    expect(find('```\n[[Note]]\n```', 'Wikilink')).toEqual([]);
    expect(find('    [[Note]]', 'Wikilink')).toEqual([]);
  });

  it('needs one line, no brackets inside and a target', () => {
    expect(find('[[Not\nthis]]', 'Wikilink')).toEqual([]);
    expect(find('[[a[b]]', 'Wikilink')).toEqual([]);
    expect(find('[[a]b]]', 'Wikilink')).toEqual([]);
    expect(find('[[]]', 'Wikilink')).toEqual([]);
    expect(find('[[ ]]', 'Wikilink')).toEqual([]);
    expect(find('[[|alias]]', 'Wikilink')).toEqual([]);
    expect(find('\\[[Note]]', 'Wikilink')).toEqual([]);
  });

  it('leaves out an empty alias', () => {
    expect(parts('[[Note|]]')).toEqual([
      'Wikilink:[[Note|]]',
      'WikilinkMark:[[',
      'WikilinkTarget:Note',
      'WikilinkMark:|',
      'WikilinkMark:]]',
    ]);
  });

  // GFM splits a table cell at every `|` that is not written `\|`, before inline parsing.
  // So `[[a|b]]` in a cell is cut into two cells and is not a wikilink. Obsidian behaves the
  // same, which is why its tables use `[[a\|b]]`.
  it('in a table, [[a|b]] splits the cell; [[a\\|b]] is one wikilink', () => {
    const split = '| x | y |\n|---|---|\n| [[a|b]] | c |\n';
    expect(find(split, 'Wikilink')).toEqual([]);
    expect(find(split, 'TableCell').map((c) => c.text)).toEqual(['x', 'y', '[[a', 'b]]', 'c']);

    const escaped = '| x | y |\n|---|---|\n| [[a\\|b]] | c |\n';
    expect(find(escaped, 'TableCell').map((c) => c.text)).toEqual(['x', 'y', '[[a\\|b]]', 'c']);
    expect(parts(escaped)).toEqual([
      'Wikilink:[[a\\|b]]',
      'WikilinkMark:[[',
      'WikilinkTarget:a',
      'WikilinkMark:\\|',
      'WikilinkAlias:b',
      'WikilinkMark:]]',
    ]);
  });
});

describe('wikilinks with the shown text first', () => {
  const parser = parserFor({ ...testSettings, syntax: { wikilinks: 'textFirst' } });
  const partsOf = (text: string) =>
    findIn(parser.parse(text), text, ['Wikilink', 'Embed', 'WikilinkMark', 'WikilinkTarget', 'WikilinkAlias']).map(
      (n) => `${n.name}:${n.text}`,
    );

  it('reads the shown text before the bar and the target after it', () => {
    expect(partsOf('See [[the note|Folder/Note#Part]] here.')).toEqual([
      'Wikilink:[[the note|Folder/Note#Part]]',
      'WikilinkMark:[[',
      'WikilinkAlias:the note',
      'WikilinkMark:|',
      'WikilinkTarget:Folder/Note#Part',
      'WikilinkMark:]]',
    ]);
  });

  it('reads a link with no bar, and an escaped bar in a table, the same way', () => {
    expect(partsOf('[[Note]]')).toEqual([
      'Wikilink:[[Note]]',
      'WikilinkMark:[[',
      'WikilinkTarget:Note',
      'WikilinkMark:]]',
    ]);
    const escaped = '| x |\n|---|\n| [[b\\|a]] |\n';
    expect(partsOf(escaped)).toEqual([
      'Wikilink:[[b\\|a]]',
      'WikilinkMark:[[',
      'WikilinkAlias:b',
      'WikilinkMark:\\|',
      'WikilinkTarget:a',
      'WikilinkMark:]]',
    ]);
  });

  it('keeps an embed in Obsidian order, its size after the bar', () => {
    expect(partsOf('![[picture.png|300]]')).toEqual([
      'Embed:![[picture.png|300]]',
      'WikilinkMark:![[',
      'WikilinkTarget:picture.png',
      'WikilinkMark:|',
      'WikilinkAlias:300',
      'WikilinkMark:]]',
    ]);
  });

  it('needs a target after the bar', () => {
    expect(partsOf('[[shown|]]')).toEqual([]);
    expect(partsOf('[[|Note]]')).toEqual([
      'Wikilink:[[|Note]]',
      'WikilinkMark:[[',
      'WikilinkMark:|',
      'WikilinkTarget:Note',
      'WikilinkMark:]]',
    ]);
  });
});
