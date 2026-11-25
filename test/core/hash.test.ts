// The sync checksum. Host and panel must agree on it whatever shape their texts' trees have,
// and it must tell texts apart.
import { ChangeSet, Text } from '@codemirror/state';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sameStamp, stampOf, textHash } from '../../src/core/hash';
import { seeded } from '../random';

/** A small seeded generator, so a failure names the pair that caused it. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const textOf = (s: string) => Text.of(s.split('\n'));

describe('textHash', () => {
  it('is 14 lowercase hex digits for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(textHash(s)).toMatch(/^[0-9a-f]{14}$/);
      }),
      seeded(),
    );
    expect(textHash('')).toMatch(/^[0-9a-f]{14}$/);
  });

  it('tells apart texts that differ by one character', () => {
    const base = 'The quick brown fox jumps over the lazy dog.\n'.repeat(50);
    const seen = new Set<string>([textHash(base)]);
    for (let i = 0; i < base.length; i++) {
      const changed = base.slice(0, i) + (base[i] === 'x' ? 'y' : 'x') + base.slice(i + 1);
      seen.add(textHash(changed));
    }
    expect(seen.size).toBe(base.length + 1);
  });
});

describe('stamps', () => {
  it('pairs the length with the hash', () => {
    expect(stampOf('hello')).toEqual({ length: 5, hash: textHash('hello') });
  });

  it('are the same exactly when the texts are', () => {
    expect(sameStamp(stampOf('one\ntwo'), stampOf('one\ntwo'))).toBe(true);
    expect(sameStamp(stampOf('one\ntwo'), stampOf('one\ntwO'))).toBe(false);
    expect(sameStamp({ length: 3, hash: textHash('abc') }, { length: 4, hash: textHash('abc') })).toBe(false);
  });

  it('are the same for a string and for a Text holding it, however the Text was built', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'é😀'.repeat(i % 7)}`);
    const whole = lines.join('\n');
    // Line by line from the end: a different tree from the one Text.of builds in one go.
    let grown = Text.of([lines[0]!]);
    for (const line of lines.slice(1)) grown = grown.replace(grown.length, grown.length, Text.of(['', line]));
    expect(grown.toString()).toBe(whole);
    expect(grown.children).not.toBeNull();
    expect(stampOf(grown)).toEqual(stampOf(whole));
    expect(stampOf(textOf(whole))).toEqual(stampOf(whole));
    expect(stampOf(Text.of(['']))).toEqual(stampOf(''));
  });

  it('are equal for equal texts built by different edit histories', () => {
    const unit = fc.constantFrom('a', 'b', ' ', '\n', '\n', 'é', '😀', '\ud800');
    const edit = fc.record({
      at: fc.double({ min: 0, max: 1, noNaN: true }),
      remove: fc.integer({ min: 0, max: 400 }),
      insert: fc.string({ unit, maxLength: 300 }),
    });
    const lineCount = fc.integer({ min: 0, max: 3000 });
    fc.assert(
      fc.property(lineCount, fc.array(edit, { maxLength: 12 }), (lines, edits) => {
        const start = Array.from({ length: lines }, (_, i) => `l${i % 13}`).join('\n');
        // One history: each edit applied to the tree on its own, and its hash taken each time.
        let stepwise = textOf(start);
        let plain = start;
        let composed = ChangeSet.empty(start.length);
        for (const e of edits) {
          const from = Math.floor(e.at * plain.length);
          const to = Math.min(plain.length, from + e.remove);
          const change = ChangeSet.of([{ from, to, insert: e.insert }], plain.length);
          stepwise = change.apply(stepwise);
          stampOf(stepwise);
          composed = composed.compose(change);
          plain = plain.slice(0, from) + e.insert + plain.slice(to);
        }
        // Another: all of them at once on a fresh tree. And the text built afresh from its lines.
        const atOnce = composed.apply(textOf(start));
        expect(stepwise.toString()).toBe(plain);
        expect(stampOf(stepwise)).toEqual(stampOf(plain));
        expect(stampOf(atOnce)).toEqual(stampOf(plain));
        expect(stampOf(textOf(plain))).toEqual(stampOf(plain));
      }),
      seeded({ numRuns: 300 }),
    );
  });

  it('are unequal for unequal texts of equal length, over 100,000 random pairs', () => {
    const rand = random(20261114);
    const alphabets = ['ab', 'ab \n', 'abcdefghij \n.,', '\u0000\u0001\uffff\ud800\udc00'];
    const randomText = (length: number, alphabet: string) => {
      let s = '';
      for (let i = 0; i < length; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      return s;
    };
    let pairs = 0;
    while (pairs < 100_000) {
      const length = rand() < 0.9 ? 1 + Math.floor(rand() * 80) : 1 + Math.floor(rand() * 3000);
      const alphabet = alphabets[Math.floor(rand() * alphabets.length)]!;
      const a = randomText(length, alphabet);
      let b: string;
      const kind = rand();
      if (kind < 0.25) {
        b = randomText(length, alphabet);
      } else if (kind < 0.6) {
        // A few characters changed.
        const chars = a.split('');
        for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++)
          chars[Math.floor(rand() * length)] = alphabet[Math.floor(rand() * alphabet.length)]!;
        b = chars.join('');
      } else if (kind < 0.8) {
        // Two characters swapped.
        const chars = a.split('');
        const i = Math.floor(rand() * length);
        const j = Math.floor(rand() * length);
        [chars[i], chars[j]] = [chars[j]!, chars[i]!];
        b = chars.join('');
      } else {
        // Rotated: the same characters, moved.
        const k = Math.floor(rand() * length);
        b = a.slice(k) + a.slice(0, k);
      }
      if (a === b) continue;
      pairs++;
      if (sameStamp(stampOf(a), stampOf(b)))
        expect.fail(`equal stamps for ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
    }
  });
});
