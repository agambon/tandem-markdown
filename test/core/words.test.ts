// Word and character counts for the status bar.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countWords } from '../../src/core/words';
import { seeded } from '../random';

/** What Intl.Segmenter itself says, for comparison: word-like segments. */
function segmenterWords(text: string): number {
  let n = 0;
  for (const s of new Intl.Segmenter('en', { granularity: 'word' }).segment(text)) if (s.isWordLike) n++;
  return n;
}

describe('countWords', () => {
  it('counts words by Unicode word boundaries', () => {
    expect(countWords('').words).toBe(0);
    expect(countWords('Hello, world!').words).toBe(2);
    expect(countWords("don't stop e.g. 3.14 and 1,000 a:b").words).toBe(7);
    expect(countWords('**bold** _it_ `code` [link](https://x.y/z)').words).toBe(7); // bold it code link https x.y z
    expect(countWords('# Heading\n\n- item one\n- item two\n').words).toBe(5);
    expect(countWords('émigré naïve café').words).toBe(3);
  });

  it('counts each CJK character as a word', () => {
    expect(countWords('東京都').words).toBe(3);
    expect(countWords('ひらがな カタカナ').words).toBe(8);
    expect(countWords('I live in 東京.').words).toBe(5);
    expect(countWords('한국어 문장').words).toBe(2); // Hangul is written with spaces: counted by words
  });

  it('counts characters as a reader does, leaving out line breaks', () => {
    expect(countWords('abc\ndef').characters).toBe(6);
    expect(countWords('a\n\n\nb\n').characters).toBe(2);
    expect(countWords('two  spaces').characters).toBe(11);
    expect(countWords('👍🏽 é').characters).toBe(3); // one emoji with its skin tone, a space, e with its accent
    expect(countWords('東京').characters).toBe(2);
  });

  it('gives the same word count as Intl.Segmenter on plain Latin text (the fast path)', () => {
    const cp = (...c: number[]) => String.fromCodePoint(...c);
    const unit = fc.constantFrom(
      'a',
      'b',
      'Z',
      '0',
      '7',
      '_',
      '.',
      ',',
      ';',
      ':',
      "'",
      '-',
      ' ',
      ' ',
      '\n',
      '#',
      '*',
      '`',
      '[',
      ']',
      '(',
      ')',
      '/',
      '@',
      'é',
      'ÿ',
      'À',
      cp(0x17d),
      cp(0x2018),
      cp(0x2019),
      cp(0x201c),
      cp(0x201d),
      cp(0x2013),
      cp(0x2014),
      cp(0x2026),
      cp(0xa0),
    );
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 60 }), (s) => {
        expect(countWords(s).words).toBe(segmenterWords(s));
      }),
      seeded({ numRuns: 5000 }),
    );
  });

  it('gives the counts of a whole-text Intl.Segmenter pass on mixed text', () => {
    const cp = (...c: number[]) => String.fromCodePoint(...c);
    const reference = (s: string) => {
      let words = 0;
      for (const seg of new Intl.Segmenter('en', { granularity: 'word' }).segment(s)) {
        if (!seg.isWordLike) continue;
        const cjk = seg.segment.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
        words += cjk
          ? cjk.length +
            (/[\p{L}\p{N}\p{M}\p{Pc}]/u.test(
              seg.segment.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ''),
            )
              ? 1
              : 0)
          : 1;
      }
      let characters = 0;
      for (const g of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s))
        if (g.segment !== '\n' && g.segment !== '\r') characters++;
      return { words, characters };
    };
    const unit = fc.constantFrom(
      'a',
      'b',
      '1',
      '.',
      "'",
      ' ',
      ' ',
      '\t',
      '\n',
      '-',
      '_',
      'é',
      '東',
      'カ',
      '한',
      '👍',
      cp(0x1f3fd),
      cp(0x0301),
      cp(0x2019),
      cp(0x200d),
      cp(0x1f1fa),
      cp(0x1f1f8),
      cp(0x00a0),
      cp(0x201c),
      cp(0xb7),
      cp(0xd7),
      cp(0x17f),
      cp(0x180),
      'ß',
      'Ω',
    );
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 60 }), (s) => {
        expect(countWords(s)).toEqual(reference(s));
      }),
      seeded({ numRuns: 5000 }),
    );
  });

  it('gives the same count line by line as over the whole text', () => {
    const unit = fc.constantFrom('a', 'é', '東', ' ', '\n', '.', "'", '1', '👍');
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 40 }), fc.string({ unit, maxLength: 40 }), (a, b) => {
        const joined = countWords(a + '\n' + b);
        expect(joined.words).toBe(countWords(a).words + countWords(b).words);
        expect(joined.characters).toBe(countWords(a).characters + countWords(b).characters);
      }),
      seeded({ numRuns: 1000 }),
    );
  });
});
