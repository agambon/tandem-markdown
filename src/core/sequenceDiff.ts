// The bounded sequence diff: the differences between two sequences of small integer ids, as
// ascending hunks, under a work allowance (past it, what is left is taken as changed whole). It is
// the linear-space form of E. W. Myers, "An O(ND) Difference Algorithm and Its Variations",
// Algorithmica 1 (1986), section 4b. StringIds gives strings the ids it compares, for every caller:
// diff.ts builds the text diff on it, merge3.ts its line and token diffs, and diffStrings compares
// two lists of strings, for the host's change marks and conflict file parts
// (src/host/model/lineChanges.ts, textChanges.ts) and for the lines typing changed (typingAtClose.ts).

export interface SequenceHunk {
  /** Old range [a1, a2) and new range [b1, b2), in elements. */
  a1: number;
  a2: number;
  b1: number;
  b2: number;
}
type Hunk = SequenceHunk;

/**
 * Differences between a and b, whose elements are ids in [0, idCount). Ascending, maximal
 * runs. `budget.left` caps the search work (one unit per diagonal visited and per element
 * a snake steps over) and is spent as the search goes; past it, each part not yet compared
 * is taken as changed whole. The answer is always a correct diff, and a shortest one when
 * the allowance is not spent.
 */
export function diffSequences(a: Int32Array, b: Int32Array, idCount: number, budget: { left: number }): SequenceHunk[] {
  const n = a.length;
  const m = b.length;
  const changedA = new Uint8Array(n);
  const changedB = new Uint8Array(m);

  // Common prefix and suffix first: they are by far the most common case.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start < endA || start < endB) {
    // Count occurrences in the middle parts; an element missing from the other side is changed.
    const inA = new Int32Array(idCount);
    const inB = new Int32Array(idCount);
    for (let i = start; i < endA; i++) inA[a[i]!]!++;
    for (let i = start; i < endB; i++) inB[b[i]!]!++;
    const keep = (seq: Int32Array, end: number, other: Int32Array, changed: Uint8Array) => {
      const kept = new Int32Array(end - start);
      const index = new Int32Array(end - start);
      let count = 0;
      for (let i = start; i < end; i++) {
        if (other[seq[i]!] === 0) changed[i] = 1;
        else {
          kept[count] = seq[i]!;
          index[count++] = i;
        }
      }
      return { kept: kept.subarray(0, count), index };
    };
    const ka = keep(a, endA, inB, changedA);
    const kb = keep(b, endB, inA, changedB);
    const rca = new Uint8Array(ka.kept.length);
    const rcb = new Uint8Array(kb.kept.length);
    compareRecords(ka.kept, kb.kept, rca, rcb, budget);
    for (let k = 0; k < rca.length; k++) if (rca[k]) changedA[ka.index[k]!] = 1;
    for (let k = 0; k < rcb.length; k++) if (rcb[k]) changedB[kb.index[k]!] = 1;
  }

  // Walk both sequences together: unchanged elements pair up in order. The common
  // prefix and suffix hold no change, so the walk covers only what lies between.
  const hunks: Hunk[] = [];
  let i = start;
  let j = start;
  while (i < endA || j < endB) {
    if ((i < n && changedA[i]) || (j < m && changedB[j])) {
      const a1 = i;
      const b1 = j;
      while (i < n && changedA[i]) i++;
      while (j < m && changedB[j]) j++;
      hunks.push({ a1, a2: i, b1, b2: j });
    } else {
      i++;
      j++;
    }
  }
  return hunks;
}

/**
 * Marks in ca and cb (1 = changed) the elements of a and b that are not part of the common
 * subsequence the search settles on. Unmarked elements of a and of b must pair up in order:
 * the same number of them, with equal ids. `budget.left` is the work allowance; once it is
 * spent, every part not yet compared is marked changed whole.
 *
 * The work is a stack of boxes, a[aLo, aHi) against b[bLo, bHi). A box first loses the
 * elements its two sides start and end with in common. If a side is then empty, the rest of
 * the other side is changed; otherwise the box is split at a middle snake into the box
 * before the snake and the box after it. With the allowance unspent the marks are a
 * shortest edit script.
 */
function compareRecords(a: Int32Array, b: Int32Array, ca: Uint8Array, cb: Uint8Array, budget: { left: number }): void {
  const boxes: number[] = [0, a.length, 0, b.length];
  let arrays: [Int32Array, Int32Array] | null = null;
  while (boxes.length > 0) {
    let bHi = boxes.pop()!;
    let bLo = boxes.pop()!;
    let aHi = boxes.pop()!;
    let aLo = boxes.pop()!;
    if (budget.left > 0) {
      const aStart = aLo;
      const aEnd = aHi;
      while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
        aLo++;
        bLo++;
      }
      while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
        aHi--;
        bHi--;
      }
      budget.left -= aLo - aStart + (aEnd - aHi);
      if (aLo < aHi && bLo < bHi) {
        arrays ??= searchArrays(a.length + b.length + 3);
        if (middleSnake(a, b, aLo, aHi, bLo, bHi, arrays[0], arrays[1], budget, found)) {
          boxes.push(found[2]!, aHi, found[3]!, bHi, aLo, found[0]!, bLo, found[1]!);
          continue;
        }
      }
    }
    // Spent allowance, or one side empty: what is left of the box is changed.
    ca.fill(1, aLo, aHi);
    cb.fill(1, bLo, bHi);
  }
}

/**
 * The search's working arrays (see middleSnake) are kept between calls, so the many small
 * diffs of one merge do not each allocate them; a call that needs more entries than this
 * gets arrays of its own, which are not kept. Every entry the search reads it has written
 * earlier in the same box, so nothing needs clearing.
 */
const SEARCH_KEEP = 1 << 16;
let keptFwd = new Int32Array(0);
let keptBwd = new Int32Array(0);
/** Where middleSnake writes the snake it finds. */
const found = new Int32Array(4);

/** The forward and backward arrays for one call's search, of at least `size` entries. */
function searchArrays(size: number): [Int32Array, Int32Array] {
  if (size > SEARCH_KEEP) return [new Int32Array(size), new Int32Array(size)];
  if (keptFwd.length < size) {
    const grown = Math.min(SEARCH_KEEP, Math.max(1024, 2 ** Math.ceil(Math.log2(size))));
    keptFwd = new Int32Array(grown);
    keptBwd = new Int32Array(grown);
  }
  return [keptFwd, keptBwd];
}

/** Above any x, for the edges of the backward search's diagonals. */
const BEYOND = 0x3fffffff;

/**
 * Finds a middle snake of the box a[aLo, aHi) against b[bLo, bHi), whose sides are both
 * non-empty and differ in their first elements and in their last. Writes it to `snake` as
 * [x1, y1, x2, y2], the snake running from (x1, y1) to (x2, y2), and returns true; returns
 * false, leaving `snake` as it was, if the allowance runs out first.
 *
 * Diagonal k = x - y lives at index k + b.length + 1 of `fwd`, which holds the furthest x
 * the forward search has reached on it, and of `bwd`, which holds the least x the backward
 * search has reached. A box spans diagonals aLo - bHi to aHi - bLo; the entry just outside
 * each end is a sentinel that never wins. A move that would leave the box through its far
 * side is cut to the point of that diagonal on the edge: some path with no more edits
 * reaches that point, so the furthest points stay exact.
 */
function middleSnake(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  fwd: Int32Array,
  bwd: Int32Array,
  budget: { left: number },
  snake: Int32Array,
): boolean {
  const shift = b.length + 1;
  const kMin = aLo - bHi;
  const kMax = aHi - bLo;
  const kFwd = aLo - bLo; // where the forward search starts
  const kBwd = aHi - bHi; // where the backward search starts
  const odd = ((kBwd - kFwd) & 1) !== 0;
  fwd[kMin - 1 + shift] = -1;
  fwd[kMax + 1 + shift] = -1;
  bwd[kMin - 1 + shift] = BEYOND;
  bwd[kMax + 1 + shift] = BEYOND;
  // Step 0 of each search is its snake from its corner, which the box's trimming has taken.
  fwd[kFwd + shift] = aLo;
  bwd[kBwd + shift] = aHi;

  for (let d = 1; ; d++) {
    // Forward step d: the furthest point on each diagonal kFwd - d, kFwd - d + 2, ... kFwd + d
    // within the box, from a step right off diagonal k - 1 or down off k + 1.
    if (budget.left <= 0) return false;
    let lo = kFwd - d;
    let hi = kFwd + d;
    if (lo < kMin) lo = kMin + ((kMin - lo) & 1);
    if (hi > kMax) hi = kMax - ((hi - kMax) & 1);
    let work = 0;
    for (let k = lo; k <= hi; k += 2) {
      let x: number;
      if (k === kFwd - d) {
        x = fwd[k + 1 + shift]!;
        if (x > bHi + k) x = bHi + k;
      } else {
        x = fwd[k - 1 + shift]! + 1;
        if (x > aHi) x = aHi;
        if (k !== kFwd + d) {
          let down = fwd[k + 1 + shift]!;
          if (down > bHi + k) down = bHi + k;
          if (down > x) x = down;
        }
      }
      const start = x;
      let y = x - k;
      while (x < aHi && y < bHi && a[x] === b[y]) {
        x++;
        y++;
      }
      fwd[k + shift] = x;
      work += 1 + x - start;
      // With an odd difference between the start diagonals, the searches can first meet here,
      // against the backward search's step d - 1.
      if (odd && k >= kBwd - d + 1 && k <= kBwd + d - 1 && x >= bwd[k + shift]!) {
        snake[0] = start;
        snake[1] = start - k;
        snake[2] = x;
        snake[3] = y;
        budget.left -= work;
        return true;
      }
    }
    budget.left -= work;

    // Backward step d, the mirror image: the least point on each diagonal kBwd - d ... kBwd + d,
    // from a step left off diagonal k + 1 or up off k - 1.
    if (budget.left <= 0) return false;
    lo = kBwd - d;
    hi = kBwd + d;
    if (lo < kMin) lo = kMin + ((kMin - lo) & 1);
    if (hi > kMax) hi = kMax - ((hi - kMax) & 1);
    work = 0;
    for (let k = lo; k <= hi; k += 2) {
      let x: number;
      if (k === kBwd + d) {
        x = bwd[k - 1 + shift]!;
        if (x < bLo + k) x = bLo + k;
      } else {
        x = bwd[k + 1 + shift]! - 1;
        if (x < aLo) x = aLo;
        if (k !== kBwd - d) {
          let up = bwd[k - 1 + shift]!;
          if (up < bLo + k) up = bLo + k;
          if (up < x) x = up;
        }
      }
      const end = x;
      let y = x - k;
      while (x > aLo && y > bLo && a[x - 1] === b[y - 1]) {
        x--;
        y--;
      }
      bwd[k + shift] = x;
      work += 1 + end - x;
      // With an even difference, the searches can first meet here, against forward step d.
      if (!odd && k >= kFwd - d && k <= kFwd + d && x <= fwd[k + shift]!) {
        snake[0] = x;
        snake[1] = y;
        snake[2] = end;
        snake[3] = end - k;
        budget.left -= work;
        return true;
      }
    }
    budget.left -= work;
  }
}

/**
 * Small integer ids for strings (lines or tokens), in the order each is first seen, shared by every
 * list one instance encodes: the ids diffSequences compares, `count` its `idCount`.
 */
export class StringIds {
  private readonly map = new Map<string, number>();

  get count(): number {
    return this.map.size;
  }

  /** The id of `item`, given one now if it has none. */
  idFor(item: string): number {
    let id = this.map.get(item);
    if (id === undefined) {
      id = this.map.size;
      this.map.set(item, id);
    }
    return id;
  }

  /** The id of a string already given one. */
  idOf(item: string): number | undefined {
    return this.map.get(item);
  }

  of(items: readonly string[]): Int32Array {
    const out = new Int32Array(items.length);
    for (let i = 0; i < items.length; i++) out[i] = this.idFor(items[i]!);
    return out;
  }
}

/** Differences between two lists of strings, each string compared whole (diffSequences over their ids). */
export function diffStrings(a: readonly string[], b: readonly string[], budget: { left: number }): SequenceHunk[] {
  const ids = new StringIds();
  const aIds = ids.of(a);
  const bIds = ids.of(b);
  return diffSequences(aIds, bIds, ids.count, budget);
}

/** How many of `a`'s items `b` holds in the same order: the length of their longest common subsequence. */
export function commonSubsequenceLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}
