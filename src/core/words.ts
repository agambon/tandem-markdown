// Word and character counts, for the status bar. Words follow Unicode word boundaries (UAX #29,
// through Intl.Segmenter), except that each Chinese or Japanese character counts as a word of its
// own; characters are grapheme clusters, line breaks excluded. Intl.Segmenter takes about 0.6 s a
// megabyte, so plain Latin text (FAST_CHARS) is counted by a pattern that gives its answer, and only
// the stretches of a line holding other characters go to it: a line is cut at each space or tab
// before a printable ASCII character, where word and character boundaries always fall.

import { CJK, WORD_CHARACTER } from './wordChars';

const CJK_CHAR = new RegExp(`[${CJK}]`, 'gu');
const WORD_CHAR = new RegExp(`[${WORD_CHARACTER}]`, 'u');

// The fast path covers plain Latin text: ASCII, precomposed Latin letters (Latin-1 and
// Latin Extended-A), the curly quotes, the en and em dash, the ellipsis and the no-break
// space. Each of those is one character on its own, and its UAX #29 word-break class is
// fixed: letters are ALetter, the curly single quotes are MidNumLet like the period,
// the rest break words. Built from code points so no invisible character sits in the source.
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const LATIN = `A-Za-z\\xc0-\\xd6\\xd8-\\xf6\\xf8-\\xff${ch(0x100)}-${ch(0x17f)}`;
const SINGLE_QUOTES = ch(0x2018, 0x2019);
const FAST_CHARS = `\\x00-\\x7f\\xa0\\xc0-\\xd6\\xd8-\\xf6\\xf8-\\xff${ch(0x100)}-${ch(0x17f)}${ch(0x2013, 0x2014, 0x201c, 0x201d, 0x2026)}${SINGLE_QUOTES}`;
const NOT_FAST = new RegExp(`[^${FAST_CHARS}]`);

// A word in that text as UAX #29 sees it: letters, digits and underscores, joined across
// one of : . ' and the curly single quotes between two letters (WB6, WB7), or one of
// , ; . ' and the curly single quotes between two digits (WB11, WB12). A lone underscore
// is not a word (ICU gives it no word status); two or more are.
const FAST_WORD = new RegExp(
  `[${LATIN}0-9_]+(?:(?:(?<=[${LATIN}])[:.'${SINGLE_QUOTES}](?=[${LATIN}])|(?<=[0-9])[,;.'${SINGLE_QUOTES}](?=[0-9]))[${LATIN}0-9_]+)*`,
  'g',
);

let wordSegmenter: Intl.Segmenter | undefined;
let graphemeSegmenter: Intl.Segmenter | undefined;

function segmenters(): { words: Intl.Segmenter; graphemes: Intl.Segmenter } {
  // A fixed locale, so the host and the panel count alike whatever their display language.
  wordSegmenter ??= new Intl.Segmenter('en', { granularity: 'word' });
  graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return { words: wordSegmenter, graphemes: graphemeSegmenter };
}

/** A space or tab followed by a printable ASCII character: the cut falls after the space. */
const SAFE_CUT = /[ \t](?=[!-~])/g;

export function countWords(text: string): { words: number; characters: number } {
  const seg = segmenters();
  let words = 0;
  let characters = 0;
  const fast = (part: string) => {
    words += countFastWords(part);
    characters += part.length - countCarriageReturns(part);
  };
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length === 0) continue;
    if (!NOT_FAST.test(line)) {
      fast(line);
    } else {
      // Gather the line's pieces into runs of plain Latin text and runs holding anything else.
      let runStart = 0;
      let runSlow = false;
      let pieceStart = 0;
      const flush = (to: number) => {
        if (to <= runStart) return;
        const run = line.slice(runStart, to);
        if (runSlow) {
          words += countSegmentedWords(run, seg.words);
          for (const g of seg.graphemes.segment(run)) if (g.segment !== '\r') characters++;
        } else {
          fast(run);
        }
        runStart = to;
      };
      const piece = (to: number) => {
        const slow = NOT_FAST.test(line.slice(pieceStart, to));
        if (slow !== runSlow) {
          flush(pieceStart);
          runSlow = slow;
        }
        pieceStart = to;
      };
      SAFE_CUT.lastIndex = 0;
      for (let m = SAFE_CUT.exec(line); m; m = SAFE_CUT.exec(line)) piece(m.index + 1);
      piece(line.length);
      flush(line.length);
    }
  }
  return { words, characters };
}

function countFastWords(line: string): number {
  let n = 0;
  for (const m of line.matchAll(FAST_WORD)) if (m[0] !== '_') n++;
  return n;
}

function countCarriageReturns(line: string): number {
  let n = 0;
  for (let i = line.indexOf('\r'); i >= 0; i = line.indexOf('\r', i + 1)) n++;
  return n;
}

function countSegmentedWords(line: string, segmenter: Intl.Segmenter): number {
  let n = 0;
  for (const s of segmenter.segment(line)) {
    if (!s.isWordLike) continue;
    const cjk = s.segment.match(CJK_CHAR);
    if (!cjk) {
      n++;
      continue;
    }
    n += cjk.length;
    // Anything word-like left once the CJK characters are removed is one more word.
    if (WORD_CHAR.test(s.segment.replace(CJK_CHAR, ''))) n++;
  }
  return n;
}
