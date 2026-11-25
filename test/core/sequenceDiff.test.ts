// The bounded sequence diff under diffChanges and merge3 (src/core/sequenceDiff.ts): a correct
// diff whatever the allowance, and a shortest one when the allowance is not spent.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type SequenceHunk, diffSequences } from '../../src/core/sequenceDiff';
import { seeded } from '../random';

/** An allowance no test here can spend. */
const AMPLE = 1e12;

/**
 * Checks a sequence diff against its contract (hunks ascending, apart, non-empty and in range;
 * the elements left unchanged pair up in order with equal ids) and returns how many elements
 * it marks as changed.
 */
function checkHunks(a: Int32Array, b: Int32Array, hunks: SequenceHunk[]): number {
  let fault = '';
  let i = 0;
  let j = 0;
  let marks = 0;
  const pairUp = (count: number) => {
    for (let k = 0; k < count; k++) if (a[i + k] !== b[j + k]) return false;
    return true;
  };
  for (let n = 0; n < hunks.length && !fault; n++) {
    const h = hunks[n]!;
    if (h.a1 < i || h.b1 < j || h.a2 < h.a1 || h.b2 < h.b1 || h.a2 > a.length || h.b2 > b.length)
      fault = 'out of order or range';
    else if (h.a1 === h.a2 && h.b1 === h.b2) fault = 'empty hunk';
    else if (n > 0 && h.a1 === i) fault = 'hunks not apart';
    else if (h.a1 - i !== h.b1 - j) fault = 'unchanged runs of different lengths';
    else if (!pairUp(h.a1 - i)) fault = 'unchanged elements differ';
    if (fault) fault += ` at hunk ${n} ${JSON.stringify(h)}`;
    marks += h.a2 - h.a1 + (h.b2 - h.b1);
    i = h.a2;
    j = h.b2;
  }
  if (!fault && (a.length - i !== b.length - j || !pairUp(a.length - i))) fault = 'unchanged tail differs';
  expect(fault).toBe('');
  return marks;
}

/** Length of a longest common subsequence, by the plain table. */
function lcsLength(a: Int32Array, b: Int32Array): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table[a.length]![b.length]!;
}

const idsOf = (alphabet: number, maxLength: number) =>
  fc.array(fc.integer({ min: 0, max: alphabet - 1 }), { maxLength }).map((x) => Int32Array.from(x));

/** Two sequences: unrelated, or the second made from the first by a few random edits. */
const pairOf = (alphabet: number, maxLength: number) =>
  fc.oneof(
    fc.tuple(idsOf(alphabet, maxLength), idsOf(alphabet, maxLength)),
    idsOf(alphabet, maxLength).chain((a) =>
      fc
        .array(
          fc.record({
            at: fc.double({ min: 0, max: 1, noNaN: true }),
            remove: fc.integer({ min: 0, max: 5 }),
            insert: fc.array(fc.integer({ min: 0, max: alphabet - 1 }), { maxLength: 5 }),
          }),
          { maxLength: 8 },
        )
        .map((edits) => {
          const b = Array.from(a);
          for (const e of edits) b.splice(Math.floor(e.at * b.length), e.remove, ...e.insert);
          return [a, Int32Array.from(b)] as const;
        }),
    ),
  );

describe('diffSequences properties', () => {
  it('keeps its contract on random sequences, with an ample allowance and with a tiny one', () => {
    for (const [alphabet, maxLength] of [
      [3, 60],
      [1000, 300],
    ] as const) {
      fc.assert(
        fc.property(pairOf(alphabet, maxLength), fc.integer({ min: 0, max: 60 }), ([a, b], tiny) => {
          checkHunks(a, b, diffSequences(a, b, alphabet, { left: AMPLE }));
          checkHunks(a, b, diffSequences(a, b, alphabet, { left: tiny }));
        }),
        seeded({ numRuns: 3000 }),
      );
    }
  });

  it('gives a shortest edit script when the allowance is ample', () => {
    fc.assert(
      fc.property(idsOf(3, 14), idsOf(3, 14), (a, b) => {
        const marks = checkHunks(a, b, diffSequences(a, b, 3, { left: AMPLE }));
        expect(marks).toBe(a.length + b.length - 2 * lcsLength(a, b));
      }),
      seeded({ numRuns: 10000 }),
    );
  });

  it('stops with a tiny allowance on two unrelated sequences of 200,000 elements', () => {
    let x = 0x5eed >>> 0; // mulberry32
    const rand = () => {
      x = (x + 0x6d2b79f5) >>> 0;
      let t = Math.imul(x ^ (x >>> 15), x | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (const alphabet of [4, 50_000]) {
      const a = Int32Array.from({ length: 200_000 }, () => Math.floor(rand() * alphabet));
      const b = Int32Array.from({ length: 200_000 }, () => Math.floor(rand() * alphabet));
      const budget = { left: 50 };
      checkHunks(a, b, diffSequences(a, b, alphabet, budget));
      expect(budget.left).toBeLessThanOrEqual(0);
    }
  });
});
