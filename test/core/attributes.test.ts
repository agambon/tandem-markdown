// Attributes in braces, as Pandoc, kramdown and Python-Markdown write them.
import { describe, expect, it } from 'vitest';
import {
  attributesEnd,
  findAnchor,
  headingAttributes,
  readAttributes,
  spanStyle,
  trailingAttributes,
} from '../../src/core/attributes';

describe('readAttributes', () => {
  it('reads an id, classes, pairs with bare and quoted values, and the colon kramdown writes', () => {
    expect(readAttributes('{#intro .big .x key=v title="A } b" other=\'c d\'}')).toEqual({
      id: 'intro',
      classes: ['big', 'x'],
      pairs: [
        ['key', 'v'],
        ['title', 'A } b'],
        ['other', 'c d'],
      ],
    });
    expect(readAttributes('{: #id .cls }')).toEqual({ id: 'id', classes: ['cls'], pairs: [] });
    expect(readAttributes('{#sec.intro:a}')?.id).toBe('sec.intro:a');
    expect(readAttributes('{-}')?.classes).toEqual(['unnumbered']);
  });

  it('reads them as Pandoc does where the programs that write them differ', () => {
    expect(readAttributes('{.a#b .c.d}')).toEqual({ id: 'b', classes: ['a', 'c.d'], pairs: [] });
    expect(readAttributes('{width="50%".big -}')).toEqual({
      id: null,
      classes: ['big', 'unnumbered'],
      pairs: [['width', '50%']],
    });
    expect(readAttributes('{#a #b}')?.id).toBe('b');
    expect(readAttributes('{#caf\u00e9 .\u65e5\u672c}')).toEqual({
      id: 'caf\u00e9',
      classes: ['\u65e5\u672c'],
      pairs: [],
    });
    expect(readAttributes('{.a\nwidth=5}')?.pairs).toEqual([['width', '5']]);
    expect(readAttributes('{w=a"b}')?.pairs).toEqual([['w', 'a"b']]);
  });

  it('gives null for braces that are not attributes', () => {
    for (const text of [
      '{a b}',
      '{x=}',
      '{=x}',
      '{1x=y}',
      '{.a key="open}',
      '{ word }',
      '{#a/b}',
      '{.a+b}',
      'no braces',
    ]) {
      expect(readAttributes(text), text).toBeNull();
    }
  });
});

describe('finding attribute braces', () => {
  it('ends at the brace that closes them, past quoted braces, across one line break', () => {
    expect(attributesEnd('{.a title="}"} after', 0)).toBe('{.a title="}"}'.length);
    expect(attributesEnd('{.a\n.b}', 0)).toBe(7);
    expect(attributesEnd('{.a\n \n}', 0)).toBe(-1);
    expect(attributesEnd('{.a title="x\ny"}', 0)).toBe(-1);
    expect(attributesEnd('{.a {.b}', 0)).toBe(-1);
  });

  it('finds the braces that end a text, holding at least one attribute', () => {
    const text = 'Title {#intro .big}  ';
    expect(trailingAttributes(text)).toEqual({ from: 6, to: 19 });
    expect(trailingAttributes('Title {}')).toBeNull();
    expect(trailingAttributes('Map {a b}')).toBeNull();
    expect(trailingAttributes('Title {#id} more')).toBeNull();
  });

  it('finds where an id is given, looking at each occurrence once', () => {
    const text = 'Text #intro here.\n\n## Intro {#intro}\n\nA []{#_Toc12 .anchor}mark.';
    expect(findAnchor(text, 'intro')).toBe(text.indexOf('{#intro}'));
    expect(findAnchor(text, '_Toc12')).toBe(text.indexOf('{#_Toc12'));
    expect(findAnchor(text, 'missing')).toBe(-1);
    expect(findAnchor(text, '')).toBe(-1);
  });
});

describe('spanStyle', () => {
  it("draws Pandoc's three styles and a bookmark, and nothing else", () => {
    const of = (text: string, empty = false) => spanStyle(readAttributes(text)!, empty);
    expect(of('{.underline}')).toBe('underline');
    expect(of('{.smallcaps}')).toBe('smallcaps');
    expect(of('{.mark}')).toBe('mark');
    expect(of('{#_Toc1 .anchor}', true)).toBe('anchor');
    expect(of('{#only-id}', true)).toBe('anchor');
    expect(of('{#only-id}')).toBeNull();
    expect(of('{.red}')).toBeNull();
  });
});

describe('headingAttributes', () => {
  const read = (line: string) => {
    const from = line.indexOf(' ');
    const found = headingAttributes(line, from);
    if (!found) return null;
    const { textTo, closing, braces } = found;
    return {
      text: line.slice(from, textTo).trim(),
      closing: closing ? line.slice(closing.from, closing.to) : null,
      braces: line.slice(braces.from, braces.to),
    };
  };

  it('ends the heading text before the braces and any closing hashes', () => {
    expect(read('## Title {#intro}')).toEqual({ text: 'Title', closing: null, braces: '{#intro}' });
    expect(read('## Title ## {#intro}')).toEqual({ text: 'Title', closing: '##', braces: '{#intro}' });
    expect(read('# # {-}')).toEqual({ text: '', closing: '#', braces: '{-}' });
    expect(read('# C# {.lang}')).toEqual({ text: 'C#', closing: null, braces: '{.lang}' });
  });

  it('reads no attributes where none end the line, or where they style a span', () => {
    expect(read('## Title')).toBeNull();
    expect(read('## Title {}')).toBeNull();
    expect(read('## A [word]{.mark}')).toBeNull();
  });
});
