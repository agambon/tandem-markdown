// The sync checksum: a text's length plus a hash of it. The host and the panel both import
// this module, so they always agree on a stamp.
//
// The hash is polynomial over the text's UTF-16 code units, modulo two primes, so the hash
// of two texts joined follows from the hashes of the two. A CodeMirror Text is hashed from
// its tree: every node's hash is cached, so after an edit only the changed leaf and the
// nodes above it are hashed again. A string and a Text holding the same characters hash
// alike, whatever the shape of the tree.

import type { Text } from '@codemirror/state';

export interface TextStamp {
  length: number;
  hash: string;
}

/** Lowercase hex, HEX_DIGITS for each prime. Not for security: it only tells two copies of a text apart. */
export function textHash(text: string | Text): string {
  const h = typeof text === 'string' ? hashString(text) : hashTree(text);
  return h.h1.toString(16).padStart(HEX_DIGITS, '0') + h.h2.toString(16).padStart(HEX_DIGITS, '0');
}

export function stampOf(text: string | Text): TextStamp {
  return { length: text.length, hash: textHash(text) };
}

export function sameStamp(a: TextStamp, b: TextStamp): boolean {
  return a.length === b.length && a.hash === b.hash;
}

/** True for a value shaped like a stamp, such as one read back from a message or from workspaceState. */
export function isStamp(x: unknown): x is TextStamp {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as TextStamp).length === 'number' &&
    typeof (x as TextStamp).hash === 'string'
  );
}

// ---------------------------------------------------------------------------
// The polynomial hash

// The two largest primes below 2^26: a product of two residues stays below 2^53, so plain
// floating-point arithmetic is exact. Each base is a primitive root of its prime.
const P1 = 67_108_859;
const P2 = 67_108_837;
const B1 = 39_879_704;
const B2 = 52_588_637;
const INVERSE_P1 = 1 / P1;
const INVERSE_P2 = 1 / P2;
/** Hex digits of one residue (26 bits). */
const HEX_DIGITS = 7;
/**
 * Code units summed between two reductions. Each term is below 2^16 * 2^26, so a block's
 * terms and the running hash carried over it add up to less than 2^53.
 */
const BLOCK = 64;

/** The hash of a text and B^length, for each prime. */
interface Hashed {
  h1: number;
  h2: number;
  p1: number;
  p2: number;
}

/** v mod P1, for an integer v from 0 to 2^53; the estimated quotient is off by one at most. */
function mod1(v: number): number {
  const r = v - Math.floor(v * INVERSE_P1) * P1;
  return r < 0 ? r + P1 : r >= P1 ? r - P1 : r;
}

function mod2(v: number): number {
  const r = v - Math.floor(v * INVERSE_P2) * P2;
  return r < 0 ? r + P2 : r >= P2 ? r - P2 : r;
}

function powers(base: number, mod: (v: number) => number): Float64Array {
  const out = new Float64Array(BLOCK + 1);
  out[0] = 1;
  for (let i = 1; i <= BLOCK; i++) out[i] = mod(out[i - 1]! * base);
  return out;
}

const POWERS1 = powers(B1, mod1);
const POWERS2 = powers(B2, mod2);
const BLOCK_POWER1 = POWERS1[BLOCK]!;
const BLOCK_POWER2 = POWERS2[BLOCK]!;

function hashString(text: string): Hashed {
  let h1 = 0;
  let h2 = 0;
  let p1 = 1;
  let p2 = 1;
  const n = text.length;
  const whole = n - (n % BLOCK);
  let i = 0;
  for (; i < whole; i += BLOCK) {
    let s1 = h1 * BLOCK_POWER1;
    let s2 = h2 * BLOCK_POWER2;
    for (let j = 0; j < BLOCK; j++) {
      const c = text.charCodeAt(i + j);
      s1 += c * POWERS1[BLOCK - 1 - j]!;
      s2 += c * POWERS2[BLOCK - 1 - j]!;
    }
    h1 = mod1(s1);
    h2 = mod2(s2);
    p1 = mod1(p1 * BLOCK_POWER1);
    p2 = mod2(p2 * BLOCK_POWER2);
  }
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    h1 = mod1(h1 * B1 + c);
    h2 = mod2(h2 * B2 + c);
    p1 = mod1(p1 * B1);
    p2 = mod2(p2 * B2);
  }
  return { h1, h2, p1, p2 };
}

/** The hash of `a` followed by `b`. */
function join(a: Hashed, b: Hashed): Hashed {
  return {
    h1: mod1(mod1(a.h1 * b.p1) + b.h1),
    h2: mod2(mod2(a.h2 * b.p2) + b.h2),
    p1: mod1(a.p1 * b.p1),
    p2: mod2(a.p2 * b.p2),
  };
}

const LINE_BREAK = hashString('\n');

/** Text nodes are immutable and shared between versions of a document, so a node's hash never goes stale. */
const treeHashes = new WeakMap<Text, Hashed>();

/** A branch's children hold whole lines, with a line break between each child and the next. */
function hashTree(text: Text): Hashed {
  const known = treeHashes.get(text);
  if (known) return known;
  const children = text.children;
  let h: Hashed;
  if (children === null || children.length === 0) {
    h = hashString(text.sliceString(0));
  } else {
    h = hashTree(children[0]!);
    for (let i = 1; i < children.length; i++) h = join(join(h, LINE_BREAK), hashTree(children[i]!));
  }
  treeHashes.set(text, h);
  return h;
}
