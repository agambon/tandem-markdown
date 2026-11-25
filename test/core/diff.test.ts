// diffChanges and applyChanges guard the user's file. A wrong change here is a wrong edit in
// someone's document.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type TextChange, applyChanges, diffChanges, diffInPlace } from '../../src/core/diff';
import { seeded } from '../random';
import { buildLines, lineCase } from './lineCases';

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const splitsPair = (text: string, k: number) =>
  k > 0 && k < text.length && isHigh(text.charCodeAt(k - 1)) && isLow(text.charCodeAt(k));

/** The promise plus every rule of the contract: order, separation, no empty change, no split pair. */
function expectValid(a: string, b: string, changes: TextChange[]): void {
  expect(applyChanges(a, changes) === b).toBe(true);
  if (a === b) expect(changes).toEqual([]);
  // Plain checks, one assertion at the end: big texts give tens of thousands of changes.
  let fault = '';
  let prevTo = -1;
  let delta = 0;
  for (const c of changes) {
    const newFrom = c.from + delta;
    const newTo = newFrom + c.insert.length;
    if (!(c.from > prevTo)) fault = 'not ascending and apart';
    else if (!(c.to >= c.from && c.to <= a.length)) fault = 'out of range';
    else if (c.from === c.to && c.insert === '') fault = 'empty change';
    else if (splitsPair(a, c.from) || splitsPair(a, c.to)) fault = 'splits a pair in the old text';
    else if (splitsPair(b, newFrom) || splitsPair(b, newTo)) fault = 'splits a pair in the new text';
    if (fault) {
      fault += ` at ${JSON.stringify(c)}`;
      break;
    }
    delta += c.insert.length - (c.to - c.from);
    prevTo = c.to;
  }
  expect(fault).toBe('');
}

function check(a: string, b: string): TextChange[] {
  const changes = diffChanges(a, b);
  expectValid(a, b, changes);
  return changes;
}

describe('diffChanges by hand', () => {
  it('returns nothing for equal texts', () => {
    expect(diffChanges('', '')).toEqual([]);
    expect(diffChanges('same\ntext\n', 'same\ntext\n')).toEqual([]);
  });

  it('handles empty sides and missing final newlines', () => {
    expect(check('', 'abc')).toEqual([{ from: 0, to: 0, insert: 'abc' }]);
    expect(check('abc', '')).toEqual([{ from: 0, to: 3, insert: '' }]);
    expect(check('a\nb', 'a\nb\n')).toEqual([{ from: 3, to: 3, insert: '\n' }]);
    expect(check('a\nb\n', 'a\nb')).toEqual([{ from: 3, to: 4, insert: '' }]);
    check('a\nb', 'a\nc');
    check('\n\n\n', '\n\n');
  });

  it('keeps a change to one word small', () => {
    expect(check('one two three\n', 'one TWO three\n')).toEqual([{ from: 4, to: 7, insert: 'TWO' }]);
  });

  it('gives two changes for two edits far apart in one long line', () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
    const a = words.join(' ') + '\n';
    const edited = [...words];
    edited[10] = 'CHANGED';
    edited[280] = 'ALSO';
    const b = edited.join(' ') + '\n';
    const changes = check(a, b);
    expect(changes).toHaveLength(2);
    expect(a.slice(changes[0]!.from, changes[0]!.to)).toContain('10');
    expect(a.slice(changes[1]!.from, changes[1]!.to)).toContain('280');
  });

  it('keeps a stretch of 4,000 characters or more as one trimmed replacement', () => {
    const line = 'x'.repeat(2500) + 'MIDDLE' + 'y'.repeat(2500);
    const a = `top\n${line}\nbottom\n`;
    const b = `top\n${'x'.repeat(10)}A${'x'.repeat(2489)}MIDDLE${'y'.repeat(2489)}B${'y'.repeat(10)}\nbottom\n`;
    const changes = check(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBe(4 + 10);
    expect(changes[0]!.to).toBe(4 + line.length - 10);
  });

  it('gives separate changes for edits on separate lines', () => {
    const a = 'alpha\nbeta\ngamma\ndelta\n';
    const b = 'alpha\nBETA\ngamma\nDELTA\n';
    expect(check(a, b)).toEqual([
      { from: 6, to: 10, insert: 'BETA' },
      { from: 17, to: 22, insert: 'DELTA' },
    ]);
  });

  it('never splits a surrogate pair', () => {
    expect(check('a😀b', 'a😁b')).toEqual([{ from: 1, to: 3, insert: '😁' }]);
    expect(check('😀😀', '😀😁')).toEqual([{ from: 2, to: 4, insert: '😁' }]);
    check('😀\ud83d', '\ud83d😀');
    check('x\udc00', '𐀀');
  });

  it('folds a rewritten sentence into one change', () => {
    const a = 'Keep this. The quick brown fox jumps over the dog. Keep that.\n';
    const b = 'Keep this. A slow red cat sleeps under a tree. Keep that.\n';
    expect(check(a, b)).toHaveLength(1);
  });

  it('matches a last line with no line break to the same line followed by one', () => {
    // The first line becomes the last and is left alone; its line break goes with the line after it.
    expect(check('one ⟦1⟧ one\ntwo ⟦2⟧ two', 'six ⟦6⟧ six\none ⟦1⟧ one')).toEqual([
      { from: 0, to: 0, insert: 'six ⟦6⟧ six\n' },
      { from: 11, to: 23, insert: '' },
    ]);
    // The last line gains a line break before the new one after it, and is left alone.
    expect(check('head\nlast ⟦1⟧ line', 'head\nnew\nlast ⟦1⟧ line\nmore')).toEqual([
      { from: 5, to: 5, insert: 'new\n' },
      { from: 18, to: 18, insert: '\nmore' },
    ]);
    // The empty line after a final line break matches only another text's.
    expect(check('a\n', '\nb')).toEqual([{ from: 0, to: 2, insert: '\nb' }]);
  });
});

describe('diffInPlace', () => {
  it('reads a block edited line by line, whose first line repeats below, as its edits', () => {
    const a = '- [ ] item\nCall the plumber\n- [ ] item\nFix the gate\nNotes\n';
    const b = '- [ ] item first\nCall the plumber today\n- [ ] item\nFix the gate soon\nNotes\n';
    const inPlace = diffInPlace(a, b);
    expectValid(a, b, inPlace);
    expect(inPlace.map((c) => c.insert)).toEqual([' first', ' today', ' soon']);
  });
});

describe('applyChanges', () => {
  it('applies changes in order', () => {
    expect(
      applyChanges('hello world', [
        { from: 0, to: 5, insert: 'HELLO' },
        { from: 6, to: 6, insert: 'big ' },
      ]),
    ).toBe('HELLO big world');
  });

  it('refuses changes out of order, overlapping or out of range', () => {
    expect(() =>
      applyChanges('abc', [
        { from: 2, to: 3, insert: '' },
        { from: 0, to: 1, insert: '' },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      applyChanges('abc', [
        { from: 0, to: 2, insert: '' },
        { from: 1, to: 3, insert: '' },
      ]),
    ).toThrow(RangeError);
    expect(() => applyChanges('abc', [{ from: 2, to: 9, insert: '' }])).toThrow(RangeError);
    expect(() => applyChanges('abc', [{ from: 2, to: 1, insert: '' }])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Properties

const smallAlphabet = fc.constantFrom(
  'a',
  'b',
  'c',
  ' ',
  '\n',
  '\n',
  '#',
  '|',
  '😀',
  '😁',
  'é',
  '東',
  '\ud83d',
  '\ude00',
);
const smallText = fc.string({ unit: smallAlphabet, maxLength: 60 });

const WORDS = [
  'the',
  'and',
  'note',
  'link',
  '[[Page]]',
  '**bold**',
  '`code`',
  'émigré',
  '東京',
  '👍🏽',
  'a',
  '|',
  '-',
  '1.',
];
const word = fc.constantFrom(...WORDS);
const paragraph = (maxWords: number) => fc.array(word, { minLength: 1, maxLength: maxWords }).map((w) => w.join(' '));
const markdownLine = fc.oneof(
  { weight: 3, arbitrary: paragraph(12) },
  { weight: 1, arbitrary: paragraph(900) }, // a long single-line paragraph, sometimes over 4,000 characters
  { weight: 3, arbitrary: fc.constant('') }, // blank lines, often repeated
  { weight: 1, arbitrary: fc.constantFrom('# Heading', '## Heading', '- item', '- [ ] task', '> quote', '```', '---') },
  { weight: 1, arbitrary: fc.constantFrom('| a | b |', '| --- | --- |', '| 1 | 2 |') },
);
const markdown = fc.array(markdownLine, { maxLength: 40 }).map((lines) => lines.join('\n'));
/** Lines from a few kinds, blank ones among them, so the same line is often found in many places. */
const repetitive = fc
  .array(fc.constantFrom('', '', 'same', 'same', 'other', '| a |'), { maxLength: 80 })
  .map((l) => l.join('\n'));

/** Random edits of a text: each picks a place, removes up to some characters and inserts a snippet. */
const edited = (source: string) =>
  fc
    .array(
      fc.record({
        at: fc.double({ min: 0, max: 1, noNaN: true }),
        remove: fc.integer({ min: 0, max: 30 }),
        insert: fc.oneof(fc.constant(''), word, paragraph(5), fc.constantFrom('\n', '\n\n', '| x | y |\n', '😀')),
      }),
      { maxLength: 8 },
    )
    .map((edits) => {
      let text = source;
      for (const e of edits) {
        const at = Math.floor(e.at * text.length);
        text = text.slice(0, at) + e.insert + text.slice(Math.min(text.length, at + e.remove));
      }
      return text;
    });

describe('diffChanges properties', () => {
  it('reproduces the new text from random texts', () => {
    fc.assert(
      fc.property(smallText, smallText, (a, b) => {
        expectValid(a, b, diffChanges(a, b));
      }),
      seeded({ numRuns: 3000 }),
    );
  });

  it('reproduces the new text from random edits of realistic markdown', () => {
    fc.assert(
      fc.property(
        markdown.chain((a) => fc.tuple(fc.constant(a), edited(a))),
        ([a, b]) => {
          expectValid(a, b, diffChanges(a, b));
        },
      ),
      seeded({ numRuns: 400 }),
    );
  });

  it('reproduces the new text when lines repeat heavily', () => {
    fc.assert(
      fc.property(repetitive, repetitive, (a, b) => {
        expectValid(a, b, diffChanges(a, b));
      }),
      seeded({ numRuns: 1000 }),
    );
  });

  it('reads in place exactly, never changing more text than diffChanges', () => {
    const changed = (cs: TextChange[]) => cs.reduce((n, c) => n + (c.to - c.from) + c.insert.length, 0);
    fc.assert(
      fc.property(
        fc.oneof(
          markdown.chain((a) => fc.tuple(fc.constant(a), edited(a))),
          fc.tuple(repetitive, repetitive),
        ),
        ([a, b]) => {
          const inPlace = diffInPlace(a, b);
          expectValid(a, b, inPlace);
          expect(changed(inPlace)).toBeLessThanOrEqual(changed(diffChanges(a, b)));
        },
      ),
      seeded({ numRuns: 600 }),
    );
  });

  it('reproduces the new text whether or not each text ends in a line break', () => {
    const ending = (t: string, lineBreak: boolean) => (t.endsWith('\n') ? t.slice(0, -1) : t) + (lineBreak ? '\n' : '');
    const pairs = fc.oneof(
      markdown.chain((a) => fc.tuple(fc.constant(a), edited(a))),
      fc.tuple(repetitive, repetitive),
    );
    fc.assert(
      fc.property(pairs, fc.boolean(), fc.boolean(), ([a, b], endA, endB) => {
        const x = ending(a, endA);
        const y = ending(b, endB);
        expectValid(x, y, diffChanges(x, y));
      }),
      seeded({ numRuns: 3000 }),
    );
  });

  it('stays exact when its work allowance runs out (every line changed, or a different text)', () => {
    // About 600 KB: past the allowance, so the rest of the text comes out as coarse replacements.
    const para = (i: number) =>
      `Paragraph ${i}: the note and the garden, a weekly review of the project with 😀 and 東京.`;
    const a = Array.from({ length: 7000 }, (_, i) => para(i)).join('\n\n') + '\n';
    const everyLine = a.replace(/e/g, 'E');
    const different =
      Array.from({ length: 7000 }, (_, i) =>
        para(i * 7919)
          .split(' ')
          .reverse()
          .join(' '),
      ).join('\n\n') + '\n';
    for (const b of [everyLine, different]) expectValid(a, b, diffChanges(a, b));
  });

  it('reproduces the new text for two unrelated large texts', () => {
    // Large enough that the line search spends its allowance, so the coarse path runs.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        let x = seed >>> 0; // mulberry32: a 32-bit generator that keeps its full period
        const rand = () => {
          x = (x + 0x6d2b79f5) >>> 0;
          let t = Math.imul(x ^ (x >>> 15), x | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const make = () =>
          Array.from({ length: 3000 }, () => (rand() < 0.3 ? '' : `line ${Math.floor(rand() * 400)}`)).join('\n');
        const a = make();
        const b = make();
        expectValid(a, b, diffChanges(a, b));
      }),
      seeded({ numRuns: 5 }),
    );
  });
});

describe('diffChanges of whole-line operations', () => {
  for (const finalBreak of [true, false]) {
    it(`keeps every change within the lines operated on, ${finalBreak ? 'every line' : 'the last line not'} ending in a line break`, () => {
      fc.assert(
        fc.property(lineCase, (c) => {
          const { a, b, spans } = buildLines(c, finalBreak);
          const changes = check(a, b);
          const outside = changes.filter((ch) => !spans.some(([lo, hi]) => lo <= ch.from && ch.to <= hi));
          expect(outside).toEqual([]);
        }),
        seeded({ numRuns: 3000 }),
      );
    });
  }
});
