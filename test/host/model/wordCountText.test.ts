// The status bar's word count: its text and tooltip.

import { describe, expect, it } from 'vitest';
import { countWords } from '../../../src/core/words';
import { bodyStart, countBody, countSelection, countText, countTexts } from '../../../src/host/model/wordCountText';

const words = (total: number, part: number | null = null) => countText(total, part, 'word', 'words');

describe('countText', () => {
  it('writes zero, one and many for the whole', () => {
    expect(words(0)).toBe('No words');
    expect(words(1)).toBe('1 word');
    expect(words(2)).toBe('2 words');
    expect(words(1204)).toBe('1,204 words');
    expect(words(1234567)).toBe('1,234,567 words');
  });

  it('writes zero, one and many for a part of the whole; the noun agrees with the whole', () => {
    expect(words(0, 0)).toBe('No words');
    expect(words(1, 0)).toBe('0 of 1 word');
    expect(words(1, 1)).toBe('1 of 1 word');
    expect(words(2, 0)).toBe('0 of 2 words');
    expect(words(2, 1)).toBe('1 of 2 words');
    expect(words(2, 2)).toBe('2 of 2 words');
    expect(words(1204, 37)).toBe('37 of 1,204 words');
    expect(words(1204, 1204)).toBe('1,204 of 1,204 words');
  });

  it('gives the words as the text and the characters as the tooltip', () => {
    expect(countTexts({ words: 0, characters: 0 }, null)).toEqual({ text: 'No words', tooltip: 'No characters' });
    expect(countTexts({ words: 1, characters: 1 }, null)).toEqual({ text: '1 word', tooltip: '1 character' });
    expect(countTexts({ words: 2, characters: 2 }, { words: 1, characters: 1 })).toEqual({
      text: '1 of 2 words',
      tooltip: '1 of 2 characters',
    });
    expect(countTexts({ words: 1204, characters: 6532 }, { words: 0, characters: 2 })).toEqual({
      text: '0 of 1,204 words',
      tooltip: '2 of 6,532 characters',
    });
  });
});

// The front matter rule itself is tested once, in test/core/frontmatter.test.ts.
describe('bodyStart', () => {
  it('is just after the closing line of a front matter block, and 0 without one', () => {
    expect(bodyStart('# Title\n')).toBe(0);
    expect(bodyStart('---\ntitle: x\n')).toBe(0);
    expect(bodyStart('---\ntitle: x\n---\n# Title\n')).toBe('---\ntitle: x\n---'.length);
  });
});

describe('countBody and countSelection', () => {
  const text = '---\ntitle: Three words here\n---\n# Heading\n\nOne two three four.\n';
  const start = bodyStart(text);

  it('leaves the front matter out of the whole', () => {
    expect(countBody(text, start)).toEqual(countWords(text.slice(start)));
    expect(countBody(text, start).words).toBe(5);
    expect(countBody('Just this', 0).words).toBe(2);
  });

  it('counts the selected text, either way round, leaving out the front matter', () => {
    const from = text.indexOf('two');
    const to = text.indexOf(' four');
    expect(countSelection(text, start, { anchor: from, head: to })).toEqual(countWords('two three'));
    expect(countSelection(text, start, { anchor: to, head: from })).toEqual(countWords('two three'));
    // A select-all covers the front matter too, but never counts more than the whole.
    expect(countSelection(text, start, { anchor: 0, head: text.length })).toEqual(countBody(text, start));
    expect(countSelection(text, start, { anchor: 4, head: 10 })).toEqual({ words: 0, characters: 0 });
  });

  it('is null with nothing selected, and clamps offsets to the text', () => {
    expect(countSelection(text, start, undefined)).toBeNull();
    expect(countSelection(text, start, { anchor: 40, head: 40 })).toBeNull();
    expect(countSelection(text, start, { anchor: text.length - 6, head: text.length + 50 })).toEqual(
      countWords('four.\n'),
    );
    expect(countSelection(text, start, { anchor: Number.NaN, head: Number.NaN })).toBeNull();
    expect(countSelection(text, start, { anchor: Number.NaN, head: text.length })).toEqual(countBody(text, start));
  });
});
