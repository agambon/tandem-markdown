// The readers of small pieces of markdown source: character classes and tags.

import { describe, expect, it } from 'vitest';
import { isAsciiLetter, isHtmlSpace, isSpaceOrTab, tagMayFollow, tagNameLength } from '../../src/core/markdownText';

const codes = (chars: string) => [...chars].map((c) => c.charCodeAt(0));

describe('character classes', () => {
  it('takes a space and a tab as space or tab, and nothing else', () => {
    expect(codes(' \t').every(isSpaceOrTab)).toBe(true);
    expect(codes('\n\r\f\u00a0\u3000a').some(isSpaceOrTab)).toBe(false);
  });

  it("takes the HTML tokenizer's white space and ASCII letters as it does", () => {
    expect(codes(' \t\n\f\r').every(isHtmlSpace)).toBe(true);
    expect(codes('\v\u00a0a').some(isHtmlSpace)).toBe(false);
    expect(codes('azAZ').every(isAsciiLetter)).toBe(true);
    expect(codes('@[`{0\u00e9').some(isAsciiLetter)).toBe(false);
  });
});

describe('tags', () => {
  const name = (text: string) => text.slice(1, 1 + tagNameLength(text, 1));

  it('reads a name with at least one character that is not a digit', () => {
    expect(name('#area/sub-2 and more')).toBe('area/sub-2');
    expect(name('#y1984.')).toBe('y1984');
    expect(name('#ff0000')).toBe('ff0000');
    expect(name('#1984')).toBe('');
    expect(name('#\u65e5\u672c\ud83d\ude00!')).toBe('\u65e5\u672c\ud83d\ude00');
  });

  it('ends a name at any white space Obsidian reads as such, and at control characters', () => {
    expect(name('#a\u1680b')).toBe('a');
    expect(name('#a\u2003b')).toBe('a');
    expect(name('#a\u0001b')).toBe('a');
  });

  it('reads no name longer than the limit', () => {
    expect(name(`#${'a'.repeat(200)} `)).toHaveLength(200);
    expect(name(`#${'a'.repeat(201)}`)).toBe('');
  });

  it('starts a tag at the start of a line or after any white space, not after other text', () => {
    expect(['', ' ', '\t', '\n', '\u00a0', '\u2003', '\u1680', '\u3000'].every(tagMayFollow)).toBe(true);
    expect(['a', 'C', '(', '\u00e9'].some(tagMayFollow)).toBe(false);
  });
});
