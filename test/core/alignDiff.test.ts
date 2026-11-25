// Where a change between two texts is placed: in the fewest changes that sliding allows, at word
// boundaries, never inside a bracket.
import { ChangeSet, Text } from '@codemirror/state';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { alignToWords, alignedDiff } from '../../src/core/alignDiff';
import { type TextChange, applyChanges } from '../../src/core/diff';
import { seeded } from '../random';
import { buildLines, lineCase } from './lineCases';

const WORD = /[\p{L}\p{N}]/u;
const isWord = (ch: string | undefined) => ch !== undefined && WORD.test(ch);

/** The text after a panel's unsent deletion of a[from, to) is mapped through `script`, as collab maps it. */
function afterUnsentDeletion(a: string, script: readonly TextChange[], from: number, to: number): string {
  const b = applyChanges(a, script);
  const unsent = ChangeSet.of([{ from, to }], a.length).map(ChangeSet.of(script, a.length));
  return unsent.apply(Text.of(b.split('\n'))).toString();
}

/** How far a pure change slides through the unchanged text before `limit`, moved one place at a time. */
function slideCount(text: string, c: TextChange, dir: 1 | -1, limit: number): number {
  let { from, to, insert } = c;
  let k = 0;
  if (from === to) {
    while (dir > 0 ? from < limit && text[from] === insert[0] : from > limit && text[from - 1] === insert.at(-1)) {
      insert = dir > 0 ? insert.slice(1) + text[from] : text[from - 1] + insert.slice(0, -1);
      from += dir;
      k++;
    }
  } else {
    while (dir > 0 ? to < limit && text[from] === text[to] : from > limit && text[from - 1] === text[to - 1]) {
      from += dir;
      to += dir;
      k++;
    }
  }
  return k;
}

const isPure = (c: TextChange) => c.from === c.to || c.insert.length === 0;

/** A boundary strictly inside a word of `a`, or inserted text that extends one. */
function cutsAWord(a: string, c: TextChange): boolean {
  const inside = (i: number) => isWord(a[i - 1]) && isWord(a[i]);
  const extendsOne =
    c.insert.length > 0 &&
    ((isWord(c.insert[0]) && isWord(a[c.from - 1])) || (isWord(c.insert.at(-1)) && isWord(a[c.to])));
  return inside(c.from) || inside(c.to) || extendsOne;
}

const OPENERS = '([{<⟦«"';
const CLOSERS = ')]}>⟧»"';
const isOpener = (ch: string | undefined) => ch !== undefined && OPENERS.includes(ch);
const isCloser = (ch: string | undefined) => ch !== undefined && CLOSERS.includes(ch);

/**
 * A change that leaves part of a bracketed word: it takes the closing bracket from the word
 * before it or the opening bracket from the word after it, or it starts just inside an opening
 * bracket or ends just inside a closing one, next to a word or with a letter or digit.
 */
function cutsABracket(a: string, c: TextChange): boolean {
  const takes = c.from < c.to;
  return (
    (takes && isWord(a[c.from - 1]) && isCloser(a[c.from])) ||
    (takes && isWord(a[c.to]) && isOpener(a[c.to - 1])) ||
    (isOpener(a[c.from - 1]) && (isWord(a[c.from]) || isWord(c.insert[0]))) ||
    (isCloser(a[c.to]) && (isWord(a[c.to - 1]) || isWord(c.insert.at(-1))))
  );
}

/** Neighboring changes one of which is pure and can slide until it touches the other. */
function couldTouch(a: string, x: TextChange, y: TextChange): boolean {
  const gap = y.from - x.to;
  return (isPure(x) && slideCount(a, x, 1, y.from) >= gap) || (isPure(y) && slideCount(a, y, -1, x.to) >= gap);
}

// Texts from a small stock of words, tokens, brackets, spaces and line breaks, so pieces repeat.
const piece = fc.constantFrom(
  'cat',
  'cats',
  'at',
  'dog',
  'a',
  '7',
  '12',
  '⟦1⟧',
  '⟦12⟧',
  '⟦10⟧',
  '⟦',
  '⟧',
  '[',
  ']',
  '(',
  ')',
  ' ',
  ' ',
  '  ',
  '\n',
  '\n',
  '.',
  ', ',
);
const text = fc.array(piece, { maxLength: 24 }).map((p) => p.join(''));
const edit = fc.record({
  at: fc.nat(),
  cut: fc.nat({ max: 6 }),
  add: fc.array(piece, { maxLength: 4 }).map((p) => p.join('')),
});
/** A text and another made from it by a few edits at any offsets, or two unrelated texts. */
const pair = fc.oneof(
  fc.tuple(text, fc.array(edit, { minLength: 1, maxLength: 5 })).map(([a, edits]) => {
    let b = a;
    for (const e of edits) {
      const at = e.at % (b.length + 1);
      b = b.slice(0, at) + e.add + b.slice(Math.min(b.length, at + e.cut));
    }
    return [a, b] as const;
  }),
  fc.tuple(text, text),
);
/** A text and a script for it that need not be shortest: changes may touch, be empty or redo text. */
const script = fc.tuple(text, fc.array(edit, { maxLength: 6 })).map(([a, edits]) => {
  const points = edits.map((e) => e.at % (a.length + 1)).sort((x, y) => x - y);
  const changes: TextChange[] = [];
  let pos = 0;
  edits.forEach((e, i) => {
    const from = Math.max(pos, points[i]!);
    const to = Math.min(a.length, from + e.cut);
    changes.push({ from, to, insert: e.add });
    pos = to;
  });
  return [a, changes] as const;
});

describe('alignedDiff', () => {
  it('always reproduces the new text', () => {
    const alphabet = fc.constantFrom('a', 'b', ' ', '\n', '[', ']', 'é', '😀');
    const chars = fc.array(alphabet, { maxLength: 40 }).map((a) => a.join(''));
    fc.assert(
      fc.property(chars, chars, (a, b) => applyChanges(a, alignedDiff(a, b)) === b),
      seeded({ numRuns: 2000 }),
    );
  });

  it('moves a change to start before a bracket rather than inside it', () => {
    expect(alignedDiff('fox ⟦9004⟧', 'fox ⟦5⟧  ⟦9004⟧')).toEqual([{ from: 4, to: 4, insert: '⟦5⟧  ' }]);
    // Deletes "⟦1⟧\npha ec" whole, not "1⟧\npha ec⟦" from inside two markers.
    expect(alignedDiff('al⟦1⟧\npha ec⟦9001⟧', 'al⟦9001⟧')).toEqual([{ from: 2, to: 12, insert: '' }]);
  });

  it('gives text added on both sides of a word as two insertions, not a replacement of the word', () => {
    // The diff alone replaces "9004⟧" with "2⟧  ⟦9004⟧ ⟦1⟧ ".
    const a = 'x ⟦9003⟧ ⟦9004⟧\n\necho';
    const b = 'x ⟦9003⟧ ⟦2⟧  ⟦9004⟧ ⟦1⟧ \n\necho';
    const changes = alignedDiff(a, b);
    expect(changes.every((c) => c.from === c.to)).toBe(true);
    expect(changes.map((c) => c.insert)).toEqual(['⟦2⟧  ', ' ⟦1⟧ ']);
    expect(applyChanges(a, changes)).toBe(b);
    // A replacement inside a marker covers the whole marker, and one next to a marker leaves
    // the marker's bracket alone.
    expect(alignedDiff('golf  ⟦2⟧.⟦9006⟧', 'golf ⟦4⟧  ⟦9006⟧').some((c) => c.insert.startsWith('⟦4⟧'))).toBe(true);
    expect(alignedDiff('hotel\n⟦9004⟧ india', 'hotel⟦1⟧⟦9004⟧ india')).toEqual([{ from: 5, to: 6, insert: '⟦1⟧' }]);
    // And text deleted on both sides as two deletions.
    expect(alignedDiff(b, a).every((c) => c.insert === '')).toBe(true);
    expect(applyChanges(b, alignedDiff(b, a))).toBe(a);
  });

  it('gives a line inserted after a token that starts the same as its own as one insertion', () => {
    // The diff matches the old "⟦1⟧ " with the brackets and the 1 of the new "⟦10⟧", and
    // inserts the rest in three pieces around them.
    const head = 'golf ⟦9001⟧ delta alpha beta\n⟦9002⟧ ⟦9003⟧\nhotel ⟦3⟧ gamma\n';
    const a = head + 'golf delta golf ⟦1⟧ \nk ⟦2⟧ ilo fox';
    const b =
      head +
      'golf del ⟦9⟧ ta golf ⟦1⟧ \nfox ⟦10⟧ lima\nk ⟦2⟧ ilo fox\n⟦9004⟧ fox india ⟦9005⟧ mikepha\n\ndelta ⟦9006⟧\n';
    const changes = alignedDiff(a, b);
    expect(applyChanges(a, changes)).toBe(b);
    const line = a.indexOf('k ⟦2⟧');
    expect(changes.filter((c) => c.insert.includes('⟦10⟧'))).toEqual([
      { from: line, to: line, insert: 'fox ⟦10⟧ lima\n' },
    ]);
    // A panel's unsent deletion of the old token deletes that token and nothing of the new line.
    const at = a.indexOf('⟦1⟧');
    expect(afterUnsentDeletion(a, changes, at, at + 3)).toBe(b.replace('⟦1⟧', ''));
  });

  it('replaces a whole word when the change would start, end or add inside one', () => {
    expect(alignedDiff('the cat sat', 'the cats sat')).toEqual([{ from: 4, to: 7, insert: 'cats' }]);
    expect(alignedDiff('the cats sat', 'the cat sat')).toEqual([{ from: 4, to: 8, insert: 'cat' }]);
    expect(alignedDiff('a ⟦12⟧ b', 'a ⟦132⟧ b')).toEqual([{ from: 2, to: 6, insert: '⟦132⟧' }]);
    // A panel's unsent deletion of "cat" leaves the other program's word whole, not a stray "s".
    expect(afterUnsentDeletion('the cat sat', alignedDiff('the cat sat', 'the cats sat'), 4, 7)).toBe('the cats sat');
  });

  it('does not join an insertion and a deletion that reach each other only by both sliding', () => {
    // The added line can slide 11 places (it begins "fox kilo ⟦1" like the line after it) and
    // the deleted lines 2 (both end in "⟧" and a line break): 13 apart, neither reaches the other.
    const a = 'fox kilo ⟦1⟧\nalpha ⟦2⟧ alpha\nalpha alpha ⟦3⟧\nalpha ⟦4⟧ alpha\n';
    const b = 'fox kilo ⟦10⟧\nfox kilo ⟦1⟧\nalpha ⟦4⟧ alpha\n';
    const changes = alignedDiff(a, b);
    expect(changes).toEqual([
      { from: 0, to: 0, insert: 'fox kilo ⟦10⟧\n' },
      { from: 12, to: 44, insert: '' },
    ]);
    const at = a.indexOf('⟦1⟧');
    expect(afterUnsentDeletion(a, changes, at, at + 3)).toBe(b.replace('⟦1⟧', ''));
  });

  it('keeps every change out of the inside of a word, and adds to no word', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => alignedDiff(a, b).every((c) => !cutsAWord(a, c))),
      seeded({ numRuns: 4000 }),
    );
  });

  it('keeps every bracket around a word with its word', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => alignedDiff(a, b).every((c) => !cutsABracket(a, c))),
      seeded({ numRuns: 4000 }),
    );
    // Deleting the brackets between two tokens joins them; the change covers both whole.
    expect(alignedDiff('x ⟦1⟧\n⟦2⟧ y', 'x ⟦12⟧ y')).toEqual([{ from: 2, to: 9, insert: '⟦12⟧' }]);
  });

  it('leaves no pure insertion or deletion that can slide to touch its neighbor', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const changes = alignedDiff(a, b);
        return changes.every((c, i) => i === 0 || !couldTouch(a, changes[i - 1]!, c));
      }),
      seeded({ numRuns: 4000 }),
    );
  });

  it('changes nothing when given a script it has already aligned', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const changes = alignedDiff(a, b);
        expect(alignToWords(a, changes)).toEqual(changes);
      }),
      seeded({ numRuns: 4000 }),
    );
  });

  it('never puts a boundary between the halves of a pair, whatever lone surrogates the texts hold', () => {
    const high = '\ud83d';
    const low = '\ude00';
    const isPairAt = (t: string, k: number) => k > 0 && k < t.length && t[k - 1] === high && t[k] === low;
    const halves = fc.array(fc.constantFrom('😀', high, low, 'a', ' ', '\n', '[', ']'), { maxLength: 12 });
    fc.assert(
      fc.property(halves, halves, (x, y) => {
        const a = x.join('');
        const b = y.join('');
        let delta = 0;
        for (const c of alignedDiff(a, b)) {
          const at = c.from + delta;
          expect([isPairAt(a, c.from), isPairAt(a, c.to), isPairAt(b, at), isPairAt(b, at + c.insert.length)]).toEqual([
            false,
            false,
            false,
            false,
          ]);
          delta += c.insert.length - (c.to - c.from);
        }
      }),
      seeded({ numRuns: 4000 }),
    );
    // The insertion of "😀" before a lone high half slides no further than that half.
    expect(alignedDiff(high, `😀${high}`)).toEqual([{ from: 0, to: 0, insert: '😀' }]);
  });

  it('holds every property for any script it is given, not only a shortest one', () => {
    fc.assert(
      fc.property(script, ([a, given]) => {
        const changes = alignToWords(a, given);
        expect(applyChanges(a, changes)).toBe(applyChanges(a, given));
        expect(changes.filter((c) => c.insert === a.slice(c.from, c.to))).toEqual([]);
        expect(changes.filter((c) => cutsAWord(a, c) || cutsABracket(a, c))).toEqual([]);
        expect(changes.filter((c, i) => i > 0 && couldTouch(a, changes[i - 1]!, c))).toEqual([]);
        expect(alignToWords(a, changes)).toEqual(changes);
      }),
      seeded({ numRuns: 4000 }),
    );
  });
});

for (const finalBreak of [true, false]) {
  describe(`alignedDiff of whole-line operations, ${finalBreak ? 'every line ending' : 'the last line not ending'} in a line break`, () => {
    it('keeps every change within the lines operated on', () => {
      fc.assert(
        fc.property(lineCase, (c) => {
          const { a, b, spans } = buildLines(c, finalBreak);
          const changes = alignedDiff(a, b);
          expect(applyChanges(a, changes)).toBe(b);
          const outside = changes.filter((ch) => !spans.some(([lo, hi]) => lo <= ch.from && ch.to <= hi));
          expect(outside).toEqual([]);
        }),
        seeded({ numRuns: 3000 }),
      );
    });

    it('maps an unsent deletion of a token on an untouched line onto exactly that token', () => {
      fc.assert(
        fc.property(lineCase, (c) => {
          const { a, b, untouched } = buildLines(c, finalBreak);
          const changes = alignedDiff(a, b);
          for (const token of untouched) {
            const at = a.indexOf(token);
            expect(afterUnsentDeletion(a, changes, at, at + token.length)).toBe(b.replace(token, ''));
          }
        }),
        seeded({ numRuns: 3000 }),
      );
    });

    // The script may pair the old line with another new line that is closer by characters, and
    // replace the token whole; then the deletion is absorbed. It never cuts into other text.
    it('maps an unsent deletion of a token a replacing line kept onto that token or onto nothing', () => {
      fc.assert(
        fc.property(lineCase, (c) => {
          const { a, b, kept } = buildLines(c, finalBreak);
          const changes = alignedDiff(a, b);
          for (const token of kept) {
            const at = a.indexOf(token);
            expect([b.replace(token, ''), b]).toContain(afterUnsentDeletion(a, changes, at, at + token.length));
          }
        }),
        seeded({ numRuns: 3000 }),
      );
    });
  });
}
