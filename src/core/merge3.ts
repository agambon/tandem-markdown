// Three-way merge of LF texts: the base both sides started from, ours (the open document) and
// theirs (the file as another program left it). Level 1 merges by lines with diff3's rule; a
// stretch both sides changed goes to level 2, which merges it again by tokens. Two changes merge
// only when every way of reading the two diffs gives the same result: where text repeats, each
// change is taken over every place it could sit (spanOfPlaces, changePlaces, certainMatches,
// joinSplitLines). A conflict keeps the preferred side's text. Work is bounded (MERGE_WORK), since
// a merge runs inside the save step; past it the result is the preferred side whole, one conflict.
// The reasoning is in docs/ARCHITECTURE.md, "Merging".
//
// diff3Regions is a port of diff3MergeRegions from node-diff3 4.0.0 (Bryan Housel, MIT), with
// each change widened as described above. node-diff3's notice:
//
//   diff function extracted from Project Synchrotron.
//   Copyright (c) 2006, 2008 Tony Garnock-Jones <tonyg@lshift.net>.
//   Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net>.
//   Copyright (c) 2019-2026 Bryan Housel <bhousel@gmail.com>.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { CODE_CR, CODE_LF, CODE_SPACE, CODE_TAB, CODE_UNDERSCORE, isAsciiDigit, isAsciiLetter } from './markdownText';
import { type SequenceHunk, StringIds, diffSequences } from './sequenceDiff';
import { withoutBreak } from './textLines';
import { CJK, WORD_CHARACTER, hasLetterOrDigit } from './wordChars';

export type Prefer = 'ours' | 'theirs';

export interface MergeConflict {
  /** Where the chosen side's text sits in MergeResult.text. */
  from: number;
  to: number;
  ours: string;
  theirs: string;
  base: string;
}

export interface MergeResult {
  text: string;
  conflicts: MergeConflict[];
}

export interface MergeOptions {
  /** Whose text a conflict keeps (ours unless given). */
  prefer?: Prefer;
  /**
   * The base is the text both sides started from, not an older one: different whole lines both
   * sides insert at one place are then both kept (keepBoth) instead of a conflict. Against an
   * older base such lines may be one line both already held, which kept would stand twice.
   */
  exactBase?: boolean;
}

/**
 * Where a merge's text came from (merge3Detailed): what it keeps of lines both sides inserted at
 * one place, and what each side's changes brought into it, which the repeat check reads (safeMerge).
 */
export interface MergeDetail extends MergeResult {
  bothInserted: BothInserted[];
  brought: Brought;
}

/**
 * The text each side's changes brought into a merge's result, stretch by stretch: a change only
 * that side made, that side's text where a conflict took it, and that side's lines where lines both
 * sides inserted at one place are kept together. Text both sides hold alike is in neither.
 */
interface Brought {
  ours: BroughtStretch[];
  theirs: BroughtStretch[];
}

/**
 * One stretch a side's changes brought in: its text, and where it starts in that side's text. At
 * the end of a side merged with its final line break put back, the text holds that line break.
 */
interface BroughtStretch {
  text: string;
  at: number;
}

/** Lines both sides inserted at one place, which the merge keeps together, ours's first (see keepBoth). */
export interface BothInserted {
  /** Where they sit in MergeResult.text. */
  from: number;
  to: number;
  /** What each side inserted there. */
  ours: string;
  theirs: string;
}

/**
 * Work allowed for one merge, in the units diff.ts's search counts, plus WORK_PER_ELEMENT for each
 * line or token handled, plus the reading work charged where it is done. A merge of 1 MB texts that
 * spends it all stops in about a quarter of a second; ordinary merges use a small part of it.
 */
const MERGE_WORK = 14_000_000;
/** What handing one line or token to a diff costs (splitting, interning), in MERGE_WORK units. */
const WORK_PER_ELEMENT = 20;
/**
 * Search work one token diff may spend per token of its stretch. A side that needs more has
 * rewritten the stretch, and its diff comes out coarse, as folding would have made it anyway.
 */
const TOKEN_WORK_PER_TOKEN = 16;
/** What weighing one pair of changes against each other in mergeTokens's rules costs, in MERGE_WORK units. */
const RULE_WORK = 8;

class AllowanceSpent {}

export function merge3(base: string, ours: string, theirs: string, options?: MergeOptions): MergeResult {
  const { text, conflicts } = merge3Detailed(base, ours, theirs, options);
  return { text, conflicts };
}

/**
 * merge3, also giving where its text came from (MergeDetail); lines both sides inserted are kept
 * together only with `exactBase`.
 */
export function merge3Detailed(base: string, ours: string, theirs: string, options?: MergeOptions): MergeDetail {
  const prefer: Prefer = options?.prefer ?? 'ours';
  if (ours === theirs) return { text: ours, conflicts: [], bothInserted: [], brought: { ours: [], theirs: [] } };
  if (ours === base) return { text: theirs, conflicts: [], bothInserted: [], brought: { ours: [], theirs: [] } };
  if (theirs === base) return { text: ours, conflicts: [], bothInserted: [], brought: { ours: [], theirs: [] } };
  const ending = endingOf(base, ours, theirs);
  try {
    return mergeLines(
      ending.open ? `${base}\n` : base,
      ending.cut[0] ? `${ours}\n` : ours,
      ending.cut[1] ? `${theirs}\n` : theirs,
      prefer,
      options?.exactBase === true,
      ending,
      { left: MERGE_WORK },
    );
  } catch (error) {
    if (!(error instanceof AllowanceSpent)) throw error;
    const text = prefer === 'ours' ? ours : theirs;
    return {
      text,
      conflicts: [{ from: 0, to: text.length, ours, theirs, base }],
      bothInserted: [],
      brought: { ours: [], theirs: [] },
    };
  }
}

/**
 * How the texts end, for the merge (Output.result). A side whose text lacks the base's final line
 * break took it off its own last line; merged as an edit, it would come off whatever line the merge
 * puts there. So each such side is merged with its line break restored (`cut`), and the merged text
 * loses it only where that side's lines end it. A base with no final line break is merged as one
 * with it (`open`), and so is each side with none either. A side that ends with a line break the
 * base lacks (`grew`) keeps it where it wrote the end, or both wrote it alike.
 */
interface Ending {
  open: boolean;
  cut: readonly [boolean, boolean];
  grew: readonly [boolean, boolean];
  /** Lines both sides insert at the end are a conflict: a side's text ends otherwise than the other's or the base's. */
  endConflicts: boolean;
}

function endingOf(base: string, ours: string, theirs: string): Ending {
  const open = base !== '' && !base.endsWith('\n');
  const sides = [ours, theirs] as const;
  const cut = sides.map((t) => t !== '' && !t.endsWith('\n') && (open || base.endsWith('\n'))) as [boolean, boolean];
  const grew = sides.map((t) => open && t.endsWith('\n')) as [boolean, boolean];
  return { open, cut, grew, endConflicts: open ? (cut[0] || cut[1]) && (grew[0] || grew[1]) : cut[0] || cut[1] };
}

// ---------------------------------------------------------------------------
// Work allowance and diffs

type Allowance = { left: number };

/**
 * The largest (or smallest) of f over a list, without spreading it into arguments (a long list
 * would overflow them).
 */
function maxOf<T>(list: readonly T[], f: (x: T) => number, start = -Infinity): number {
  let best = start;
  for (const x of list) {
    const v = f(x);
    if (v > best) best = v;
  }
  return best;
}
function minOf<T>(list: readonly T[], f: (x: T) => number): number {
  let best = Infinity;
  for (const x of list) {
    const v = f(x);
    if (v < best) best = v;
  }
  return best;
}

function spend(allowance: Allowance, units: number): void {
  allowance.left -= units;
  if (allowance.left <= 0) throw new AllowanceSpent();
}

/** Most cells `certainMatches` may fill for one stretch between fences (two Int32Arrays this long, 8 MB). */
const CERTAIN_CELLS = 1_000_000;

/** The line of b each line of a is matched to by a diff's hunks, or -1. */
function matchesOf(hunks: SequenceHunk[], n: number): Int32Array {
  const match = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  for (const h of hunks) {
    while (i < h.a1) match[i++] = j++;
    i = h.a2;
    j = h.b2;
  }
  while (i < n) match[i++] = j++;
  return match;
}

/**
 * For each line of a, the line of b that every shortest edit matches it to, or -1 when shortest
 * edits differ about it: the edit distance to and from every cell in the band of diagonals a
 * shortest edit can use. Null when the band is too large (CERTAIN_CELLS).
 */
function certainMatches(
  a: Int32Array,
  b: Int32Array,
  edits: number,
  allowance: Allowance,
): { match: Int32Array; possible: Uint8Array } | null {
  const n = a.length;
  const m = b.length;
  const del = (edits + n - m) / 2;
  const ins = (edits - n + m) / 2;
  const width = del + ins + 1;
  const cells = (n + 1) * width;
  if (cells > CERTAIN_CELLS) return null;
  spend(allowance, 2 * cells);
  const INF = 0x3fffffff;
  // Cell (i, j) of the band at index i * width + k, where k = j - i + del runs from 0 to
  // width - 1. Cell (i - 1, j) is then at index - width + 1, (i, j - 1) at index - 1 and
  // (i - 1, j - 1) at index - width; going on, (i + 1, j) at + width - 1, (i, j + 1) at
  // + 1 and (i + 1, j + 1) at + width. Cells off the graph (j < 0 or j > m) stay INF.
  const fwd = new Int32Array(cells).fill(INF);
  const bwd = new Int32Array(cells).fill(INF);
  for (let i = 0; i <= n; i++) {
    const row = i * width;
    const kLo = Math.max(0, del - i);
    const kHi = Math.min(width - 1, m - i + del);
    for (let k = kLo; k <= kHi; k++) {
      const x = row + k;
      const j = i + k - del;
      let d = i === 0 && j === 0 ? 0 : INF;
      if (i > 0 && k + 1 < width) {
        const up = fwd[x - width + 1]! + 1;
        if (up < d) d = up;
      }
      if (k > kLo) {
        const left = fwd[x - 1]! + 1;
        if (left < d) d = left;
      }
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        const diag = fwd[x - width]!;
        if (diag < d) d = diag;
      }
      fwd[x] = d;
    }
  }
  const best = fwd[n * width + m - n + del]!;
  const match = new Int32Array(n).fill(-1);
  const possible = new Uint8Array(n);
  for (let i = n; i >= 0; i--) {
    const row = i * width;
    const kLo = Math.max(0, del - i);
    const kHi = Math.min(width - 1, m - i + del);
    if (i < n) {
      // The edges of shortest edits that pass line i of a (a deletion of it, or a match),
      // from row i of the forward distances and row i + 1 of the backward ones.
      let count = 0;
      let matched = -1;
      for (let k = kLo; k <= kHi; k++) {
        const x = row + k;
        const f = fwd[x]!;
        if (f >= INF) continue;
        if (k > 0 && f + 1 + bwd[x + width - 1]! === best) count++;
        const j = i + k - del;
        if (j < m && a[i] === b[j] && f + bwd[x + width]! === best) {
          count++;
          matched = j;
          possible[i] = 1;
        }
      }
      if (count === 1 && matched >= 0) match[i] = matched;
    }
    for (let k = kHi; k >= kLo; k--) {
      const x = row + k;
      const j = i + k - del;
      let d = i === n && j === m ? 0 : INF;
      if (i < n && k > 0) {
        const down = bwd[x + width - 1]! + 1;
        if (down < d) d = down;
      }
      if (k < kHi) {
        const right = bwd[x + 1]! + 1;
        if (right < d) d = right;
      }
      if (i < n && j < m && a[i] === b[j]) {
        const diag = bwd[x + width]!;
        if (diag < d) d = diag;
      }
      bwd[x] = d;
    }
  }
  return { match, possible };
}

/**
 * A settled diff's change (see settle). `loose`: it holds an element some reading keeps, so which
 * new element stands for which old one is a matter of reading. `joined`: joined by joinSplitLines,
 * its first (`before`) or last (`after`) part being lines the side wrote beside a line the reading
 * that pairs equal lines keeps.
 */
type LineHunk = SequenceHunk & { loose: boolean; joined?: { before: boolean; after: boolean } };

/**
 * Whether a base line is a fence for one side's line diff: a line of text that the whole base
 * and the whole side each hold once (see joinSplitLines). Judged over the whole texts at both
 * levels, so that level 2 reads a stretch's lines as level 1 did.
 */
type Fence = (line: string) => boolean;

/**
 * Most cells (lines or tokens times edits) for which the exact reading is worked out over
 * a whole diff at once. Above it, a line diff is read between fences (see settle) and a
 * token diff is taken as it is.
 */
const WHOLE_CELLS = 250_000;

/**
 * A diff that holds every way of reading it. Where elements repeat, a diff can match a kept element
 * to any of its copies, and the other side's diff may read its changes the other way: the same line
 * inserted by both would then be merged twice, or an edit of one copy applied to another. So only
 * elements every shortest edit matches alike count as kept (certainMatches), and everything
 * between two such is one change. Where the reading is unique, this is the diff found.
 *
 * Exact over a whole diff of at most WHOLE_CELLS. A larger line diff (`fenced`) is read between
 * fences, lines that occur once in each text, taken as kept (another reading would move a block);
 * the work is then the lines times the edits between fences, and a stretch past CERTAIN_CELLS is
 * taken as found. A larger token diff is taken as found.
 */
function settle(
  a: Int32Array,
  b: Int32Array,
  forward: SequenceHunk[],
  idCount: number,
  allowance: Allowance,
  fenced: boolean,
): LineHunk[] {
  if (forward.length === 0) return [];
  const n = a.length;
  const m = b.length;
  const first = matchesOf(forward, n);
  // The reading found is the only shortest one when no value has two roles (kept, deleted,
  // inserted: 4, 1, 2): another reading would match such a pair, or keep fewer.
  const role = new Uint8Array(idCount);
  for (let i = 0; i < n; i++) role[a[i]!]! |= first[i]! >= 0 ? 4 : 1;
  for (const h of forward) for (let j = h.b1; j < h.b2; j++) role[b[j]!]! |= 2;
  let unique = true;
  for (let v = 0; v < idCount && unique; v++)
    if (role[v] !== 0 && role[v] !== 1 && role[v] !== 2 && role[v] !== 4) unique = false;
  spend(allowance, n + m + idCount);
  if (unique) return forward.map((h) => ({ ...h, loose: false }));
  const kept = first.slice();
  const possible = new Uint8Array(n);
  /** Works out a[from..to) against b[bFrom..bTo), whose diff has `edits` edits. */
  const readExactly = (from: number, to: number, bFrom: number, bTo: number, edits: number) => {
    const exact = certainMatches(a.subarray(from, to), b.subarray(bFrom, bTo), edits, allowance);
    if (!exact) return;
    for (let k = 0; k < to - from; k++) {
      const x = exact.match[k]!;
      kept[from + k] = x >= 0 ? bFrom + x : -1;
      possible[from + k] = exact.possible[k]!;
    }
  };
  let edits = 0;
  for (const h of forward) edits += h.a2 - h.a1 + h.b2 - h.b1;
  if ((n + 1) * (edits + 1) <= WHOLE_CELLS) {
    readExactly(0, n, 0, m, edits);
  } else if (fenced) {
    spend(allowance, WORK_PER_ELEMENT * (n + m));
    const countA = new Int32Array(idCount);
    const countB = new Int32Array(idCount);
    for (let i = 0; i < n; i++) countA[a[i]!]!++;
    for (let j = 0; j < m; j++) countB[b[j]!]!++;
    let fenceA = -1;
    let fenceB = -1;
    for (let i = 0; i <= n; i++) {
      const j = i < n ? first[i]! : m;
      if (i < n && (j < 0 || countA[a[i]!] !== 1 || countB[b[j]!] !== 1)) continue;
      // Elements fenceA + 1 .. i - 1 of a against fenceB + 1 .. j - 1 of b.
      let matched = 0;
      for (let k = fenceA + 1; k < i; k++) if (first[k]! >= 0) matched++;
      const stretchEdits = i - fenceA - 1 + (j - fenceB - 1) - 2 * matched;
      if (stretchEdits > 0) readExactly(fenceA + 1, i, fenceB + 1, j, stretchEdits);
      fenceA = i;
      fenceB = j;
    }
  }
  const hunks: LineHunk[] = [];
  let pi = -1;
  let pj = -1;
  for (let k = 0; k <= n; k++) {
    let jk = m;
    if (k < n) {
      if (kept[k]! < 0) continue;
      jk = kept[k]!;
    }
    if (k - pi > 1 || jk - pj > 1) {
      let loose = false;
      for (let i = pi + 1; i < k && !loose; i++) if (possible[i]) loose = true;
      hunks.push({ a1: pi + 1, a2: k, b1: pj + 1, b2: jk, loose });
    }
    pi = k;
    pj = jk;
  }
  return hunks;
}

/**
 * A settled line diff with every line it splits in two made one change again. A line diff pairs
 * only equal lines, so where a side moved a blank line from one side of a line it edited to the
 * other, every shortest diff reads the edited line as new and the old one as deleted, each its own
 * change, and the other side's change to that line would miss it.
 *
 * A line the side wrote is an edit of a line it removed when either shares the most words with the
 * other. Where the two are in different changes with only kept lines between that are no fence
 * (`isFence`; a blank line holds no text), they are one change read in two places, joined with the
 * lines between into one loose change. `aLines` and `bLines` are the base's and the side's lines.
 */
function joinSplitLines(
  hunks: LineHunk[],
  aLines: readonly string[],
  bLines: readonly string[],
  isFence: Fence,
  allowance: Allowance,
): LineHunk[] {
  if (hunks.length < 2) return hunks;
  /** Whether no kept line between hunks k and k + 1 is a fence. */
  const passable = (k: number) => {
    spend(allowance, hunks[k + 1]!.a1 - hunks[k]!.a2);
    for (let i = hunks[k]!.a2; i < hunks[k + 1]!.a1; i++) if (isFence(aLines[i]!)) return false;
    return true;
  };
  /** Whether hunk k removes or writes a line of text: only such a line holds words. */
  const holdsText = (k: number) => {
    const h = hunks[k]!;
    for (let i = h.a1; i < h.a2; i++) if (NOT_SPACE.test(aLines[i]!)) return true;
    for (let j = h.b1; j < h.b2; j++) if (NOT_SPACE.test(bLines[j]!)) return true;
    return false;
  };
  // For each hunk, the last hunk it is joined with (itself when none).
  const joinTo = hunks.map((_, k) => k);
  for (let first = 0; first < hunks.length;) {
    // A zone: hunks first..last with no fence between neighbors. With lines of text in only one
    // of its hunks, no line of it can stand in two.
    let last = first;
    while (last + 1 < hunks.length && passable(last)) last++;
    let withText = 0;
    for (let k = first; k <= last && withText < 2; k++) if (holdsText(k)) withText++;
    if (withText >= 2) {
      // Per word: the line the zone's changes remove it from and the line they write it in, or
      // -1 when more than one; and the hunk each of those lines is in.
      const removed = new Map<string, number>();
      const written = new Map<string, number>();
      const hunkOfA = new Map<number, number>();
      const hunkOfB = new Map<number, number>();
      const note = (map: Map<string, number>, line: string, at: number) => {
        const tokens = tokenize(line);
        spend(allowance, WORK_PER_ELEMENT * (tokens.length + 1));
        for (const t of tokens) if (hasLetterOrDigit(t)) map.set(t, map.has(t) && map.get(t) !== at ? -1 : at);
      };
      for (let k = first; k <= last; k++) {
        const h = hunks[k]!;
        for (let i = h.a1; i < h.a2; i++) {
          hunkOfA.set(i, k);
          note(removed, aLines[i]!, i);
        }
        for (let j = h.b1; j < h.b2; j++) {
          hunkOfB.set(j, k);
          note(written, bLines[j]!, j);
        }
      }
      // A removed line and a written line are one line edited when either shares more such words
      // with the other than with any other line (or as many: two lines joined into one): their
      // hunks are one change. `shared` holds, per written line, the removed lines it shares such
      // words with and how many; `mostOfA`, per removed line, the most it shares with one.
      const shared = new Map<number, Map<number, number>>();
      const mostOfA = new Map<number, number>();
      for (const [word, i] of removed) {
        const j = written.get(word);
        if (i < 0 || j === undefined || j < 0) continue;
        let partners = shared.get(j);
        if (!partners) shared.set(j, (partners = new Map()));
        const n = (partners.get(i) ?? 0) + 1;
        partners.set(i, n);
        mostOfA.set(i, Math.max(mostOfA.get(i) ?? 0, n));
      }
      for (const [j, partners] of shared) {
        const most = maxOf([...partners.values()], (n) => n);
        for (const [i, n] of partners) {
          if (n !== most && n !== mostOfA.get(i)) continue;
          const [x, y] = [hunkOfA.get(i)!, hunkOfB.get(j)!];
          const lo = Math.min(x, y);
          joinTo[lo] = Math.max(joinTo[lo]!, Math.max(x, y));
        }
      }
    }
    first = last + 1;
  }
  const out: LineHunk[] = [];
  for (let k = 0; k < hunks.length;) {
    let end = joinTo[k]!;
    for (let x = k + 1; x <= end; x++) end = Math.max(end, joinTo[x]!);
    const h = hunks[k]!;
    if (end === k) out.push(h);
    else {
      const last = hunks[end]!;
      const joined = { before: h.a1 === h.a2, after: last.a1 === last.a2 };
      out.push({ a1: h.a1, a2: last.a2, b1: h.b1, b2: last.b2, loose: true, joined });
    }
    k = end + 1;
  }
  return out;
}

/**
 * A side's line diff, settled (see settle), with the lines it splits in two joined (joinSplitLines).
 * It must be exact: if the allowance runs out during it, the merge stops.
 */
function lineDiff(
  a: Int32Array,
  b: Int32Array,
  idCount: number,
  aLines: readonly string[],
  bLines: readonly string[],
  isFence: Fence,
  allowance: Allowance,
): LineHunk[] {
  spend(allowance, WORK_PER_ELEMENT * (a.length + b.length));
  const forward = diffSequences(a, b, idCount, allowance);
  if (allowance.left <= 0) throw new AllowanceSpent(); // the search was cut short; its answer is coarse
  return joinSplitLines(settle(a, b, forward, idCount, allowance, true), aLines, bLines, isFence, allowance);
}
/** A token diff, which may come out coarse for a stretch the side rewrote (see TOKEN_WORK_PER_TOKEN). */
function tokenDiff(a: Int32Array, b: Int32Array, idCount: number, allowance: Allowance): SequenceHunk[] {
  const allowed = Math.min(TOKEN_WORK_PER_TOKEN * (a.length + b.length), allowance.left);
  const budget = { left: allowed };
  const hunks = diffSequences(a, b, idCount, budget);
  spend(allowance, allowed - budget.left);
  return hunks;
}

/** A token that is a run of spaces other than a line break. */
const SPACES = /^[^\S\n]+$/;

/**
 * What a token diff is read by first, in turn (tokenReading): words, then the other tokens that are
 * not spaces. Every token is read last.
 */
const READ_FIRST: readonly ((token: string) => boolean)[] = [hasLetterOrDigit, (token) => !SPACES.test(token)];

/**
 * A token diff of `aTokens` against `bTokens` (`a` and `b`, their ids), settled (see settle), read
 * by its words first, then by its other tokens that are not spaces, then with the spaces: at each
 * reading a token is kept where every shortest diff of those tokens alone keeps it, and the
 * stretches between two kept ones are read by the next. Read with the marks and spaces from the
 * start, a reading that keeps a mark or a space in place of a word is a shortest one too, and leaves
 * the word in doubt: "alpha beta gamma" made "alpha gamma delta" also reads as "beta" made "gamma"
 * and "gamma" made "delta", and "see [[a]] and [[b]] or [[c]]" made "se [[d]] e [[a]] and [[b]]"
 * as every word changed, the brackets kept; a change of the other side near any of those words
 * then meets this side's change.
 */
function tokenReading(
  aTokens: readonly string[],
  bTokens: readonly string[],
  a: Int32Array,
  b: Int32Array,
  idCount: number,
  allowance: Allowance,
): SequenceHunk[] {
  const read = (x: Int32Array, y: Int32Array) =>
    settle(x, y, tokenDiff(x, y, idCount, allowance), idCount, allowance, false);
  const hunks: SequenceHunk[] = [];
  // Reads a[fromA, toA) against b[fromB, toB), from the reading READ_FIRST[level] on.
  const readFrom = (level: number, fromA: number, toA: number, fromB: number, toB: number): void => {
    if (fromA === toA && fromB === toB) return;
    const solid = READ_FIRST[level];
    const aSolid: number[] = [];
    const bSolid: number[] = [];
    if (solid !== undefined) {
      for (let i = fromA; i < toA; i++) if (solid(aTokens[i]!)) aSolid.push(i);
      for (let j = fromB; j < toB; j++) if (solid(bTokens[j]!)) bSolid.push(j);
    }
    if (solid === undefined || (aSolid.length === toA - fromA && bSolid.length === toB - fromB)) {
      for (const h of read(a.subarray(fromA, toA), b.subarray(fromB, toB)))
        hunks.push({ a1: h.a1 + fromA, a2: h.a2 + fromA, b1: h.b1 + fromB, b2: h.b2 + fromB });
      return;
    }
    // The tokens of this reading that every reading of them keeps, as pairs of places in a and b.
    const kept: [number, number][] = [];
    if (aSolid.length > 0 && bSolid.length > 0) {
      let i = 0;
      let j = 0;
      for (const h of read(
        Int32Array.from(aSolid, (k) => a[k]!),
        Int32Array.from(bSolid, (k) => b[k]!),
      )) {
        while (i < h.a1) kept.push([aSolid[i++]!, bSolid[j++]!]);
        i = h.a2;
        j = h.b2;
      }
      while (i < aSolid.length) kept.push([aSolid[i++]!, bSolid[j++]!]);
    }
    kept.push([toA, toB]);
    let fromKeptA = fromA;
    let fromKeptB = fromB;
    for (const [keptA, keptB] of kept) {
      readFrom(level + 1, fromKeptA, keptA, fromKeptB, keptB);
      fromKeptA = keptA + 1;
      fromKeptB = keptB + 1;
    }
  };
  readFrom(0, 0, a.length, 0, b.length);
  return hunks;
}

// ---------------------------------------------------------------------------
// Level 1

/** Lines with their "\n" kept; a last line without one stays as it is. "" has no lines. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let i = text.indexOf('\n');
  while (i >= 0) {
    lines.push(text.slice(start, i + 1));
    start = i + 1;
    i = text.indexOf('\n', i + 1);
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

type Region =
  | { stable: true; side: 'o' | 'a' | 'b'; start: number; end: number; oStart: number; oEnd: number }
  | { stable: false; oStart: number; oEnd: number; aStart: number; aEnd: number; bStart: number; bEnd: number };

/**
 * Every base element a change could involve. Where the text repeats, a diff can trade an element a
 * change removes or inserts for an equal neighbor without changing the result ("x" inserted before
 * an "x" or after it; either of two equal lines deleted), and the other side's diff may pick the
 * other, so one change can look like two (merged twice) and two deletions of one copy like
 * deletions of two (both lost). So a change's span is widened over every equal neighbor, within
 * the elements this side left unchanged (`prevEnd` to `nextStart`); and, when every element up to
 * a neighboring change of the same side can be passed, over elements involved in that neighbor
 * (the callers build `left` and `right` so).
 *
 * For an insertion at p, [p1, p2] is the points it could sit at; otherwise [s, e) is the base
 * elements it could touch.
 */
function spanOfPlaces(
  start: number,
  end: number,
  prevEnd: number,
  nextStart: number,
  left: (baseIndex: number) => boolean,
  right: (baseIndex: number) => boolean = left,
): [number, number] {
  let lo = start;
  while (lo > prevEnd && left(lo - 1)) lo--;
  let hi = end;
  while (hi < nextStart && right(hi)) hi++;
  return [lo, hi];
}

/**
 * diff3's regions from the diffs base to a and base to b (node-diff3's diff3MergeRegions, after
 * Khanna, Kunal and Pierce, "A Formal Investigation of Diff3"), each change widened by spanOfPlaces.
 * Changes of the two sides that overlap or touch make one unstable region.
 */
function diff3Regions(ha: SequenceHunk[], hb: SequenceHunk[], b: Int32Array, a: Int32Array, t: Int32Array): Region[] {
  const widen = (hunks: SequenceHunk[], side: Int32Array, which: 'a' | 'b') => {
    const ids = hunks.map((h) => new Set<number>([...b.subarray(h.a1, h.a2), ...side.subarray(h.b1, h.b2)]));
    const either = (x: Set<number>, y: Set<number> | undefined) => (v: number) =>
      x.has(v) || (y !== undefined && y.has(v));
    // A neighbor's lines count only if the whole stretch to it can be passed (spanOfPlaces).
    const passable = (from: number, to: number, x: Set<number>, y: Set<number>) => {
      for (let li = from; li < to; li++) if (!x.has(b[li]!) && !y.has(b[li]!)) return false;
      return true;
    };
    return hunks.map((h, i) => {
      const prevEnd = i > 0 ? hunks[i - 1]!.a2 : 0;
      const nextStart = i + 1 < hunks.length ? hunks[i + 1]!.a1 : b.length;
      const withPrev = i > 0 && passable(prevEnd, h.a1, ids[i]!, ids[i - 1]!) ? ids[i - 1] : undefined;
      const withNext = i + 1 < hunks.length && passable(h.a2, nextStart, ids[i]!, ids[i + 1]!) ? ids[i + 1] : undefined;
      // Each way, a neighbor's lines count too, from either neighbor the stretch to which
      // can be passed: the kept lines between can be matched one further along, the
      // neighbor giving up a line equal to the one this change inserts ("a" inserted after
      // a blank line, with blank lines inserted further on, can stand before that blank line).
      const both = new Set<number>([...(withPrev ?? []), ...(withNext ?? [])]);
      const toLeft = either(ids[i]!, both);
      const toRight = either(ids[i]!, both);
      const [hullStart, hullEnd] = spanOfPlaces(
        h.a1,
        h.a2,
        prevEnd,
        nextStart,
        (bi) => toLeft(b[bi]!),
        (bi) => toRight(b[bi]!),
      );
      return { side: which, oStart: h.a1, oEnd: h.a2, abStart: h.b1, abEnd: h.b2, hullStart, hullEnd };
    });
  };
  const hunks = [...widen(ha, a, 'a'), ...widen(hb, t, 'b')];
  hunks.sort((x, y) => x.hullStart - y.hullStart); // stable: a's first at equal starts

  const regions: Region[] = [];
  let current = 0;
  const advanceTo = (end: number) => {
    if (end > current) {
      regions.push({ stable: true, side: 'o', start: current, end, oStart: current, oEnd: end });
      current = end;
    }
  };
  let i = 0;
  while (i < hunks.length) {
    const first = hunks[i++]!;
    const regionStart = first.hullStart;
    let regionEnd = first.hullEnd;
    const group = [first];
    advanceTo(regionStart);
    while (i < hunks.length && hunks[i]!.hullStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[i]!.hullEnd);
      group.push(hunks[i++]!);
    }
    // Each side's lines over the region: its changed lines, plus the base lines around them,
    // which that side left as they were (the skew correction of diff3).
    const span = (which: 'a' | 'b'): [number, number] | null => {
      const own = group.filter((h) => h.side === which);
      if (own.length === 0) return null;
      const start = minOf(own, (h) => h.abStart) + (regionStart - minOf(own, (h) => h.oStart));
      const end = maxOf(own, (h) => h.abEnd) + (regionEnd - maxOf(own, (h) => h.oEnd));
      return [start, end];
    };
    const sa = span('a');
    const sb = span('b');
    if (sa && sb) {
      regions.push({
        stable: false,
        oStart: regionStart,
        oEnd: regionEnd,
        aStart: sa[0],
        aEnd: sa[1],
        bStart: sb[0],
        bEnd: sb[1],
      });
    } else {
      const [start, end] = (sa ?? sb)!;
      regions.push({ stable: true, side: sa ? 'a' : 'b', start, end, oStart: regionStart, oEnd: regionEnd });
    }
    current = regionEnd;
  }
  advanceTo(b.length);
  return regions;
}

function mergeLines(
  base: string,
  ours: string,
  theirs: string,
  prefer: Prefer,
  exactBase: boolean,
  ending: Ending,
  allowance: Allowance,
): MergeDetail {
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  // Lines are compared without their line breaks (a last line may lack one), so that which
  // lines are kept for certain is judged over every copy of a line; a kept line whose line
  // break alone changed is then a change of its own.
  const keys = new StringIds();
  const kb = keys.of(baseLines.map(withoutBreak));
  const ko = keys.of(oursLines.map(withoutBreak));
  const kt = keys.of(theirsLines.map(withoutBreak));
  // How many times the base, ours and theirs each hold each line, for the fences of both sides'
  // line diffs (Fence), counted when a fence is first asked about: a merge with one change a side
  // never asks.
  let held: Int32Array[] | null = null;
  const fenceFor =
    (side: 1 | 2): Fence =>
    (line) => {
      if (held === null) {
        spend(allowance, kb.length + ko.length + kt.length + 3 * keys.count);
        held = [kb, ko, kt].map((k) => {
          const count = new Int32Array(keys.count);
          for (let i = 0; i < k.length; i++) count[k[i]!]!++;
          return count;
        });
      }
      const id = keys.idOf(withoutBreak(line))!;
      return held[0]![id] === 1 && held[side]![id] === 1 && NOT_SPACE.test(line);
    };
  const fences: readonly [Fence, Fence] = [fenceFor(1), fenceFor(2)];
  const withBreaks = (hunks: LineHunk[], sideLines: string[]): LineHunk[] => {
    const out: LineHunk[] = [];
    let i = 0;
    let j = 0;
    const paired = (to: number) => {
      for (; i < to; i++, j++)
        if (baseLines[i] !== sideLines[j]) out.push({ a1: i, a2: i + 1, b1: j, b2: j + 1, loose: false });
    };
    for (const h of hunks) {
      paired(h.a1);
      out.push(h);
      i = h.a2;
      j = h.b2;
    }
    paired(baseLines.length);
    return out;
  };
  const regions = diff3Regions(
    withBreaks(lineDiff(kb, ko, keys.count, baseLines, oursLines, fences[0], allowance), oursLines),
    withBreaks(lineDiff(kb, kt, keys.count, baseLines, theirsLines, fences[1], allowance), theirsLines),
    kb,
    ko,
    kt,
  );

  const out = new Output();
  const join = (lines: string[], from: number, to: number) => lines.slice(from, to).join('');
  for (const r of regions) {
    const baseText = join(baseLines, r.oStart, r.oEnd);
    if (r.stable) {
      if (r.side === 'o') out.same(baseText, baseText);
      else if (r.side === 'a') out.changed(0, baseText, join(oursLines, r.start, r.end));
      else out.changed(1, baseText, join(theirsLines, r.start, r.end));
      continue;
    }
    const oursText = join(oursLines, r.aStart, r.aEnd);
    const theirsText = join(theirsLines, r.bStart, r.bEnd);
    if (oursText === theirsText) out.same(baseText, oursText);
    else mergeTokens(baseText, oursText, theirsText, exactBase, fences, out, allowance);
  }
  return out.result(prefer, ending, allowance);
}

/**
 * A stretch of the merge, in order: what the base and each side hold there, and how it is
 * resolved. 'same': both sides give the same text; 'ours', 'theirs': only that side changed
 * it, and its text is taken; 'kept': lines both sides inserted, kept together (keepBoth);
 * 'conflict': the preferred side's text is taken.
 */
interface Piece {
  kind: 'same' | 'ours' | 'theirs' | 'kept' | 'conflict';
  base: string;
  ours: string;
  theirs: string;
  /** For 'kept', the lines kept together. */
  kept: string;
  /** For a conflict: it starts where the previous one ended, in the base; report them as one. */
  join: boolean;
}

/** Collects the stretches of the merge, then makes the merged text, the conflicts and the lines kept together. */
class Output {
  private pieces: Piece[] = [];

  private push(piece: Piece): void {
    if (piece.base !== '' || piece.ours !== '' || piece.theirs !== '') this.pieces.push(piece);
  }

  same(base: string, text: string): void {
    this.push({ kind: 'same', base, ours: text, theirs: text, kept: '', join: false });
  }

  /** Only `side` changed `base`, into `text`. */
  changed(side: 0 | 1, base: string, text: string): void {
    this.push(
      side === 0
        ? { kind: 'ours', base, ours: text, theirs: base, kept: '', join: false }
        : { kind: 'theirs', base, ours: base, theirs: text, kept: '', join: false },
    );
  }

  /** `kept`: the lines `ours` and `theirs` inserted at one place, together. */
  keptBoth(kept: string, ours: string, theirs: string): void {
    this.push({ kind: 'kept', base: '', ours, theirs, kept, join: false });
  }

  conflict(ours: string, theirs: string, base: string, join: boolean): void {
    this.push({ kind: 'conflict', base, ours, theirs, kept: '', join });
  }

  /**
   * The merge, with the preferred side's text where the sides conflict. A base with no final line
   * break was merged with one put on (`ending.open`); a conflict reports the base as it was.
   */
  result(prefer: Prefer, ending: Ending, allowance: Allowance): MergeDetail {
    // Lines both sides insert at the end, where a side's text ends otherwise than the other's or
    // the base's, are a conflict (as in keptBoth: text that ends without a line break is not whole
    // lines); made so before the halves of a split change are weighed, which looks only where
    // there is a conflict.
    if (ending.endConflicts) this.endConflictsFirst();
    keepHalvesTogether(this.pieces, allowance);
    if (ending.cut[0] || ending.cut[1]) this.takeBreaksOff(ending);
    if (ending.open) {
      let k = this.pieces.length - 1;
      while (k >= 0 && this.pieces[k]!.base === '') k--;
      if (k >= 0) this.pieces[k]!.base = this.pieces[k]!.base.slice(0, -1);
    }
    const parts: string[] = [];
    let length = 0;
    const conflicts: MergeConflict[] = [];
    const bothInserted: BothInserted[] = [];
    const brought: Brought = { ours: [], theirs: [] };
    // Each piece holds the next stretch of ours and of theirs, so these are where it starts in each.
    let inOurs = 0;
    let inTheirs = 0;
    for (const p of this.pieces) {
      const from = length;
      const taken = p.kind === 'conflict' ? prefer : p.kind;
      const text = taken === 'kept' ? p.kept : taken === 'theirs' ? p.theirs : p.ours;
      if (text !== '') parts.push(text);
      length += text.length;
      if (taken === 'ours' || taken === 'kept') brought.ours.push({ text: p.ours, at: inOurs });
      if (taken === 'theirs' || taken === 'kept') brought.theirs.push({ text: p.theirs, at: inTheirs });
      inOurs += p.ours.length;
      inTheirs += p.theirs.length;
      if (p.kind === 'kept') {
        bothInserted.push({ from, to: length, ours: p.ours, theirs: p.theirs });
      } else if (p.kind === 'conflict') {
        const last = conflicts[conflicts.length - 1];
        if (p.join && last && last.to === from) {
          last.to = length;
          last.ours += p.ours;
          last.theirs += p.theirs;
          last.base += p.base;
        } else {
          conflicts.push({ from, to: length, ours: p.ours, theirs: p.theirs, base: p.base });
        }
      }
    }
    return { text: parts.join(''), conflicts, bothInserted, brought };
  }

  /** Makes lines both sides insert at the end of the text, kept together, a conflict. */
  private endConflictsFirst(): void {
    let end = this.pieces.length - 1;
    while (end >= 0 && this.pieces[end]!.ours === '' && this.pieces[end]!.theirs === '') end--;
    const p = this.pieces[end];
    if (p && p.kind === 'kept') {
      p.kind = 'conflict';
      p.join = false;
    }
  }

  /**
   * Takes the final line break merge3Detailed put on a side (`cut`) back off where that side's lines
   * end the merged text: no later piece adds the other side's text, and that piece gives this side's.
   * A line break a conflict beside it decides moves into that conflict. It runs last, so no conflict
   * made after it gives the other side's text after a line whose line break it took off.
   */
  private takeBreaksOff({ cut, grew }: Ending): void {
    const pieces = this.pieces;
    const stripped = new Set<Piece>();
    for (const side of [0, 1] as const) {
      if (!cut[side]) continue;
      const own = side === 0 ? 'ours' : 'theirs';
      const other = side === 0 ? 'theirs' : 'ours';
      let k = pieces.length - 1;
      while (k >= 0 && pieces[k]![own] === '') k--;
      if (k < 0) continue;
      const p = pieces[k]!;
      // Text the other side adds after it: its change, in every preference, or a conflict, in the
      // other side's. (Lines this side deleted there add nothing.)
      const adds = pieces.slice(k + 1).filter((q) => q[other] !== '' && q.kind !== own);
      if (adds.some((q) => q.kind !== 'conflict')) continue;
      // Both sides' text alike is taken off once.
      if (p.kind === other || (p.kind === 'same' && stripped.has(p)) || !p[own].endsWith('\n')) continue;
      // The other side put on the final line break the base lacked: where both sides' text alike
      // or this side's own change ends the merged text, that line break stays.
      if (adds.length === 0 && grew[side === 0 ? 1 : 0] && p.kind !== 'conflict') continue;
      if (adds.length > 0 && p.kind !== 'conflict') {
        // The other side's text follows in a conflict: the line break goes into that conflict, as
        // the other side's and the base's, so each preference ends as its side does. Only when
        // that conflict comes next; otherwise the line break stays.
        const q = pieces[k + 1]!;
        if (q.kind !== 'conflict' || !p[other].endsWith('\n') || !p.base.endsWith('\n')) continue;
        q[other] = `\n${q[other]}`;
        q.base = `\n${q.base}`;
        p[other] = p[other].slice(0, -1);
        p.base = p.base.slice(0, -1);
      } else if (p.kind === 'same' && p[own] === '\n' && k > 0 && pieces[k - 1]!.kind === 'conflict') {
        // A lone line break both sides give right after a conflict: the one ending the conflict's
        // last line, or a blank line after it, which this side's text lacks and the other side's
        // has. It goes into that conflict, as the other side's text and the base's.
        const q = pieces[k - 1]!;
        q[other] += p[other];
        q.base += p.base;
        p.ours = '';
        p.theirs = '';
        p.base = '';
        stripped.add(p);
        continue;
      }
      stripped.add(p);
      p[own] = p[own].slice(0, -1);
      // Lines both sides inserted at the end, kept together (after a base with no final line break,
      // the sides ending alike): each side's own lines lose it, and the lines kept together lose
      // it once, ours's coming first.
      if (p.kind === 'kept' && side === 1) p.kept = p.kept.slice(0, -1);
      if (p.kind === 'same') p[other] = p[own];
    }
  }
}

// ---------------------------------------------------------------------------
// Level 2

/**
 * One token at lastIndex: a line break, a run of other spaces, one CJK character, a run of word
 * characters, or one other character.
 */
const TOKEN_AT = new RegExp(`\\n|[^\\S\\n]+|[${CJK}]|(?:(?![${CJK}])[${WORD_CHARACTER}])+|[\\s\\S]`, 'uy');

/** Character codes below this are ASCII. */
const NON_ASCII = 0x80;
const isAsciiWord = (c: number) => isAsciiDigit(c) || isAsciiLetter(c) || c === CODE_UNDERSCORE;
const isAsciiSpace = (c: number) => c === CODE_SPACE || (c >= CODE_TAB && c <= CODE_CR && c !== CODE_LF);

/**
 * The tokens of a text. Plain ASCII runs are scanned by character code; a run that touches any
 * other character is read by TOKEN_AT, so the result is exactly what TOKEN_AT alone would give.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    let j = i + 1;
    if (c < NON_ASCII && c !== CODE_LF) {
      if (isAsciiWord(c)) while (j < n && isAsciiWord(text.charCodeAt(j))) j++;
      else if (isAsciiSpace(c)) while (j < n && isAsciiSpace(text.charCodeAt(j))) j++;
      if ((isAsciiWord(c) || isAsciiSpace(c)) && j < n && text.charCodeAt(j) >= NON_ASCII) j = -1;
    } else if (c !== CODE_LF) {
      j = -1;
    }
    if (j < 0) {
      TOKEN_AT.lastIndex = i;
      const m = TOKEN_AT.exec(text)!;
      j = i + m[0].length;
    }
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

const NOT_SPACE = /\S/;

/** A text's tokens other than spaces and line breaks: what two insertions are compared by. */
function wordsOf(text: string): string[] {
  return tokenize(text).filter((t) => NOT_SPACE.test(t));
}

/** Whether all of `small` appears, in order and together, within `big`. */
function wordsWithin(small: readonly string[], big: readonly string[]): boolean {
  if (small.length === 0 || small.length > big.length) return false;
  for (let k = 0; k + small.length <= big.length; k++) if (small.every((t, j) => big[k + j] === t)) return true;
  return false;
}

/** One side's change before its interval is worked out. */
interface RawHunk {
  /** Base token range [start, end) it replaces, and the tokens it puts there. */
  start: number;
  end: number;
  tokens: string[];
  /**
   * The tokens this change really removes or inserts; tokens folded in between two changes were
   * matched, and are not.
   */
  involved: Set<string>;
  /** Of those, the ones it inserts. */
  inserted: Set<string>;
  /** The tokens of the lines this side changed around it: a widening by tokens stays inside them. */
  within: [number, number];
  /**
   * When those lines have equal neighbors (blank lines, a repeated line), the tokens of
   * every line the change could equally be in (spanOfPlaces over lines); otherwise null.
   */
  lineSpan: [number, number] | null;
  /**
   * It holds only lines the side's line diff inserted or deleted whole, and the line break a
   * last line gained or lost: no part of it comes from a token diff of a changed line.
   */
  fromLines: boolean;
  /**
   * Its first (last) part inserts text at its start (end) and removes nothing there: a pure
   * insertion, alone or folded or joined with changes after (before) it.
   */
  startsInserting: boolean;
  endsInserting: boolean;
}

interface SideHunk {
  side: 0 | 1; // 0 ours, 1 theirs
  /** Base token range [start, end). */
  start: number;
  end: number;
  content: string;
  /** See RawHunk.fromLines. */
  fromLines: boolean;
  /** See RawHunk.startsInserting. */
  startsInserting: boolean;
  endsInserting: boolean;
  /**
   * Closed intervals on a line where token boundary p is 4p, over every reading of the change
   * (changePlaces): an insertion that could sit from p1 to p2 is [4p1-1, 4p2+1]; the new text of a
   * replacement anywhere in [s, e) (newSpan) is [4s+2, 4e-2]; a deletion, or a replacement's old
   * text, that could involve [hs, he) is [4hs+2, 4he-2]. Two changes of different sides interact
   * when any of their intervals meet: deletions sharing a base token (meeting end to end is fine),
   * an insertion strictly inside a change, or two insertions that can sit at one point. An insertion
   * that only touches a replacement conflicts after the sweep (joinSameWords).
   */
  intervals: [number, number][];
  /** A replacement's newSpan (above); null for a pure insertion or deletion. */
  newSpan: [number, number] | null;
  /** For a pure insertion, the points it could sit at. */
  points: [number, number] | null;
  /** The tokens it inserts. */
  inserted: Set<string>;
  /** It inserts or deletes whole lines only. */
  wholeLines: boolean;
  /**
   * The tokens of the whole lines the change could occupy, read as whole lines: a deletion of whole
   * lines, or a change inside a run of lines with equal neighbors (RawHunk.lineSpan). Else null.
   */
  lines: [number, number] | null;
}

/** Index of the line starting at token `pos`, or -1 when no line starts there. */
function lineStartingAt(lts: number[], pos: number): number {
  let lo = 0;
  let hi = lts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lts[mid]! < pos) lo = mid + 1;
    else if (lts[mid]! > pos) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/**
 * Whether a change inserts or deletes whole lines only, or replaces whole lines with whole lines:
 * mostly two changes joined across the lines between (sideHunks), which read by tokens would lose
 * the lines their whole-line parts could slide over.
 */
function isWholeLines(h: RawHunk, lts: number[]): boolean {
  const l1 = lineStartingAt(lts, h.start);
  const l2 = h.start === h.end ? l1 : lineStartingAt(lts, h.end);
  return l1 >= 0 && l2 >= 0 && (h.tokens.length === 0 ? h.start < h.end : h.tokens[h.tokens.length - 1] === '\n');
}

/** Index of the line holding token `pos` (the last line for the end). */
function lineHolding(lts: number[], pos: number): number {
  let lo = 0;
  let hi = lts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The lines a change touches in the base, or (`inserted`) only those it writes, without their line breaks. */
function linesOf(h: RawHunk, base: BaseTokens, kind: 'involved' | 'inserted' = 'involved'): Set<string> {
  const written = splitLines(h.tokens.join(''));
  if (kind === 'inserted') return new Set(written.map(withoutBreak));
  const lts = base.lineTokenStart;
  const from = lineHolding(lts, h.start);
  const to = h.end > h.start ? lineHolding(lts, h.end - 1) + 1 : from;
  return new Set([...base.lines.slice(from, to), ...written].map(withoutBreak));
}

/**
 * The span of every reading of a change, widened over neighbors equal to a token of the change
 * (`kind`: every token it removes or inserts, or only those it inserts), or of a neighboring change
 * of its side when the stretch to it can be passed (spanOfPlaces). A change of whole lines is
 * widened by whole lines ("line12\n" deleted is not "\nline12" deleted); any other by tokens, but
 * only within the lines its side changed, and over equal neighboring lines by its lineSpan.
 */
function changePlaces(
  h: RawHunk,
  kind: 'involved' | 'inserted',
  prev: RawHunk | null,
  next: RawHunk | null,
  base: BaseTokens,
): [number, number] {
  const bt = base.tokens;
  const lts = base.lineTokenStart;
  const prevEnd = prev ? prev.end : 0;
  const nextStart = next ? next.start : bt.length;
  const l1 = lineStartingAt(lts, h.start);
  const l2 = h.start === h.end ? l1 : lineStartingAt(lts, h.end);
  if (!isWholeLines(h, lts)) {
    const own = h[kind];
    const lo = Math.max(prevEnd, h.within[0]);
    const hi = Math.min(nextStart, h.within[1]);
    // A neighbor's tokens count only if the whole stretch to it can be passed: then the
    // stretch can shift as a block between the two changes.
    const passable = (from: number, to: number, other: Set<string>) => {
      for (let i = from; i < to; i++) if (!own.has(bt[i]!) && !other.has(bt[i]!)) return false;
      return true;
    };
    // Either neighbor's tokens count each way (as in diff3Regions).
    const withPrev = prev !== null && passable(prev.end, h.start, prev[kind]);
    const withNext = next !== null && passable(h.end, next.start, next[kind]);
    const passes = (bi: number) =>
      own.has(bt[bi]!) || (withPrev && prev![kind].has(bt[bi]!)) || (withNext && next![kind].has(bt[bi]!));
    let [a, b] = spanOfPlaces(h.start, h.end, Math.min(lo, h.start), Math.max(hi, h.end), passes);
    if (h.lineSpan) {
      a = Math.min(a, h.lineSpan[0]);
      b = Math.max(b, h.lineSpan[1]);
    }
    return [Math.max(a, prevEnd), Math.min(b, nextStart)];
  }
  const own = linesOf(h, base, kind);
  const key = (li: number) => withoutBreak(base.lines[li]!);
  const passableLines = (from: number, to: number, other: Set<string>) => {
    for (let li = from; li < to; li++) if (!own.has(key(li)) && !other.has(key(li))) return false;
    return true;
  };
  const prevLines = prev ? linesOf(prev, base, kind) : null;
  const nextLines = next ? linesOf(next, base, kind) : null;
  const before = prev && prevLines && passableLines(lineHolding(lts, prev.end), l1, prevLines) ? prevLines : null;
  const after = next && nextLines && passableLines(l2, lineHolding(lts, next.start), nextLines) ? nextLines : null;
  // The lines that still lie wholly between this side's neighboring changes.
  let prevLine = l1;
  while (prevLine > 0 && lts[prevLine - 1]! >= prevEnd) prevLine--;
  let nextLine = l2;
  while (nextLine < base.lines.length && lts[nextLine + 1]! <= nextStart) nextLine++;
  const [a, b] = spanOfPlaces(
    l1,
    l2,
    prevLine,
    nextLine,
    (li) => own.has(key(li)) || (before !== null && before.has(key(li))) || (after !== null && after.has(key(li))),
  );
  let [ta, tb] = [lts[a]!, lts[b]!];
  if (h.lineSpan) {
    ta = Math.min(ta, h.lineSpan[0]);
    tb = Math.max(tb, h.lineSpan[1]);
  }
  return [Math.max(ta, prevEnd), Math.min(tb, nextStart)];
}

/** The base tokens a change could reach over all its readings: from its intervals, back in tokens. */
function reach(h: SideHunk): [number, number] {
  let lo = h.start;
  let hi = h.end;
  for (const [a, b] of h.intervals) {
    lo = Math.min(lo, Math.floor((a + 1) / 4));
    hi = Math.max(hi, Math.ceil((b - 1) / 4));
  }
  return [lo, hi];
}

function finishHunk(h: RawHunk, side: 0 | 1, prev: RawHunk | null, next: RawHunk | null, base: BaseTokens): SideHunk {
  const intervals: [number, number][] = [];
  let newSpan: [number, number] | null = null;
  let points: [number, number] | null = null;
  const wholeLines = isWholeLines(h, base.lineTokenStart);
  let lines: [number, number] | null = h.lineSpan;
  if (h.start === h.end) {
    points = changePlaces(h, 'involved', prev, next, base);
    intervals.push([4 * points[0] - 1, 4 * points[1] + 1]);
  } else {
    // What it deletes: widened over every token it removes or inserts.
    const [hs, he] = changePlaces(h, 'involved', prev, next, base);
    intervals.push([4 * hs + 2, 4 * he - 2]);
    if (wholeLines && h.tokens.length === 0) lines = [hs, he];
    // A replacement from a line's start takes the whole lines it covers, and the last too when it
    // empties it: text the other side inserts at the start or end of such a line is in a line this
    // side replaced, and applied beside the deletion would lose the text it was written against.
    const lts = base.lineTokenStart;
    if (lineStartingAt(lts, h.start) >= 0) {
      const lastStart = lts[lineHolding(lts, h.end)]!;
      const toBreak = h.tokens.length === 0 && base.tokens[h.end] === '\n';
      const coveredEnd = lastStart === h.end || h.end === base.tokens.length ? h.end : toBreak ? h.end + 1 : lastStart;
      if (coveredEnd > h.start)
        lines = lines ? [Math.min(lines[0], h.start), Math.max(lines[1], coveredEnd)] : [h.start, coveredEnd];
    }
    if (h.tokens.length > 0) {
      // Where its new text sits: widened only over tokens equal to what it inserts,
      // since only those can be read as the new text standing elsewhere.
      newSpan = changePlaces(h, 'inserted', prev, next, base);
      intervals.push([4 * newSpan[0] + 2, 4 * newSpan[1] - 2]);
    }
  }
  return {
    side,
    start: h.start,
    end: h.end,
    content: h.tokens.join(''),
    fromLines: h.fromLines,
    startsInserting: h.startsInserting,
    endsInserting: h.endsInserting,
    intervals,
    newSpan,
    points,
    inserted: h.inserted,
    wholeLines,
    lines,
  };
}

/** The base stretch of a level-2 merge, tokenized once for both sides. */
interface BaseTokens {
  lines: string[];
  lineKeys: Int32Array;
  /** Token index where each line starts, plus the total at the end. */
  lineTokenStart: number[];
  tokens: string[];
  keyIds: StringIds;
}

/**
 * A run of lines one side changed as one change (not whole lines inserted or deleted), in tokens,
 * with its inner line starts and the lines the side wrote for it. Which new line stands for which
 * old one is a matter of reading, so the other side's insertion at an inner line start has no
 * certain place, and a whole line it inserts beside the run, equal to one the run holds, may be the
 * same line written twice.
 */
interface LineRun {
  side: 0 | 1;
  /** The run, in tokens. */
  start: number;
  end: number;
  /** The lines it could equally be (widened over equal neighboring lines), in tokens. */
  wideStart: number;
  wideEnd: number;
  /** The line starts inside the widened span. */
  inner: number[];
  /** The lines the side wrote for the run. */
  newLines: Set<string>;
  /**
   * The lines whose new lines pair with old ones only by reading: where its token diff deletes or
   * inserts line breaks, or the whole run when it joins two changes or is loose. Null when every new
   * line has a certain old one.
   */
  doubt: [number, number] | null;
  /**
   * It starts (ends) at a line the reading that pairs equal lines keeps, with lines the side wrote
   * before (after) it.
   */
  openStart: boolean;
  openEnd: boolean;
}

/**
 * One side's changes to the base stretch, as token hunks in base token positions.
 *
 * Lines first: a token diff across lines lines up spaces and line breaks rather than lines, and can
 * move an edit onto the wrong line. So the side is diffed by lines, without their line breaks, and
 * only what it changed is diffed by tokens; a line it left alone is never touched. When both sides
 * of a changed run end in a line break, the two are matched, so its edits stay inside its lines.
 * Hunks with only spaces and punctuation between them are folded into one (a rewritten sentence
 * matches its old commas, which would let a word the other side edited land inside it), hunks that
 * meet are joined, and each is widened to every place it could sit (finishHunk). Each run of lines
 * is recorded in `runs`.
 */
function sideHunks(
  base: BaseTokens,
  side: string,
  which: 0 | 1,
  isFence: Fence,
  allowance: Allowance,
  runs: LineRun[],
): SideHunk[] {
  const input: SideInput = { base, lines: splitLines(side), which, allowance };
  const raw: RawHunk[] = [];
  const changes = lineChanges(input, isFence);
  changes.forEach((c, i) => {
    if (c.a1 === c.a2 || c.b1 === c.b2) {
      raw.push(wholeLinesHunk(input, changes, i));
    } else {
      const { hunks, run } = changedRun(input, changes, i);
      raw.push(...hunks);
      runs.push(run);
    }
  });
  return joinedHunks(input, raw);
}

/** One side of a level-2 merge as sideHunks reads it: the base stretch, the side's lines, which side, the allowance. */
interface SideInput {
  base: BaseTokens;
  lines: string[];
  which: 0 | 1;
  allowance: Allowance;
}

/** The side's changes by lines, in order: runs of changed lines, and paired lines whose line break alone changed. */
function lineChanges(input: SideInput, isFence: Fence): LineHunk[] {
  const { base, lines: sideLines, allowance } = input;
  const sideKeys = base.keyIds.of(sideLines.map(withoutBreak));
  const changes: LineHunk[] = [];
  let b = 0;
  let s = 0;
  const pairedUpTo = (bEnd: number) => {
    for (; b < bEnd; b++, s++)
      if (base.lines[b] !== sideLines[s]) changes.push({ a1: b, a2: b + 1, b1: s, b2: s + 1, loose: false });
  };
  for (const lh of lineDiff(base.lineKeys, sideKeys, base.keyIds.count, base.lines, sideLines, isFence, allowance)) {
    pairedUpTo(lh.a1);
    changes.push(lh);
    b = lh.a2;
    s = lh.b2;
  }
  pairedUpTo(base.lines.length);
  return changes;
}

/**
 * Change `i` of `changes`, with the base line where the change before it ends and where the one
 * after it starts (the text's ends where there is none), and the side's lines it puts in.
 */
function changeAt(
  input: SideInput,
  changes: readonly LineHunk[],
  i: number,
): { c: LineHunk; prevEnd: number; nextStart: number; insertedLines: string[] } {
  const c = changes[i]!;
  return {
    c,
    prevEnd: i > 0 ? changes[i - 1]!.a2 : 0,
    nextStart: i + 1 < changes.length ? changes[i + 1]!.a1 : input.base.lines.length,
    insertedLines: input.lines.slice(c.b1, c.b2),
  };
}

/**
 * Change `i`, whole lines inserted or deleted: one hunk, as they are. The lines it could equally be
 * are its lineSpan too, so a change it is joined into still reaches them.
 */
function wholeLinesHunk(input: SideInput, changes: readonly LineHunk[], i: number): RawHunk {
  const { base, allowance } = input;
  const bt = base.tokens;
  const lts = base.lineTokenStart;
  const { c, prevEnd, nextStart, insertedLines } = changeAt(input, changes, i);
  const tokens = tokenize(insertedLines.join(''));
  spend(allowance, WORK_PER_ELEMENT * (tokens.length + lts[c.a2]! - lts[c.a1]!));
  const start = lts[c.a1]!;
  const end = lts[c.a2]!;
  const ownLines = new Set([...base.lines.slice(c.a1, c.a2), ...insertedLines].map(withoutBreak));
  const [la, lb] = spanOfPlaces(c.a1, c.a2, prevEnd, nextStart, (li) => ownLines.has(withoutBreak(base.lines[li]!)));
  return {
    start,
    end,
    tokens,
    involved: new Set([...bt.slice(start, end), ...tokens]),
    inserted: new Set(tokens),
    within: [start, end],
    lineSpan: la < c.a1 || lb > c.a2 ? [lts[la]!, lts[lb]!] : null,
    fromLines: true,
    startsInserting: start === end,
    endsInserting: start === end,
  };
}

/** Change `i` of `changes`, a run of changed lines: its hunks, read by tokens (tokenHunks), and the run (LineRun). */
function changedRun(input: SideInput, changes: readonly LineHunk[], i: number): { hunks: RawHunk[]; run: LineRun } {
  const { base, lines: sideLines, which, allowance } = input;
  const lts = base.lineTokenStart;
  const { c, prevEnd, nextStart, insertedLines } = changeAt(input, changes, i);
  // The lines this run could equally be: as far as neighbors equal one it changes run
  // (compared without line breaks).
  const keysOf = (h: SequenceHunk) => {
    spend(allowance, WORK_PER_ELEMENT * (h.a2 - h.a1 + h.b2 - h.b1));
    return new Set([...base.lines.slice(h.a1, h.a2), ...sideLines.slice(h.b1, h.b2)].map(withoutBreak));
  };
  const involvedLines = keysOf(c);
  // As in changePlaces, a neighboring change's lines count too when every kept line
  // between can be passed: a kept line equal to one the neighbor writes may be that copy.
  const passable = (from: number, to: number, other: Set<string>) => {
    spend(allowance, WORK_PER_ELEMENT * (to - from));
    for (let li = from; li < to; li++) {
      const k = withoutBreak(base.lines[li]!);
      if (!involvedLines.has(k) && !other.has(k)) return false;
    }
    return true;
  };
  const near = new Set<string>();
  if (i > 0) {
    const p = keysOf(changes[i - 1]!);
    if (passable(prevEnd, c.a1, p)) for (const k of p) near.add(k);
  }
  if (i + 1 < changes.length) {
    const n = keysOf(changes[i + 1]!);
    if (passable(c.a2, nextStart, n)) for (const k of n) near.add(k);
  }
  const [la, lb] = spanOfPlaces(c.a1, c.a2, prevEnd, nextStart, (li) => {
    const k = withoutBreak(base.lines[li]!);
    return involvedLines.has(k) || near.has(k);
  });
  const breakOnly =
    c.a2 - c.a1 === 1 && c.b2 - c.b1 === 1 && withoutBreak(base.lines[c.a1]!) === withoutBreak(sideLines[c.b1]!);
  const { hunks, moved } = tokenHunks(
    input,
    c,
    insertedLines.join(''),
    la < c.a1 || lb > c.a2 ? [lts[la]!, lts[lb]!] : null,
    breakOnly,
  );
  // When the widening crosses every kept line up to the side's neighboring change, the
  // kept lines can be read as written by either change ("G", "", "same" made "a b", "",
  // "", "" keeps the base "" as any of the three): the two changes and the lines between
  // are one run, with every line start inside it a boundary of uncertain place.
  const withPrev = i > 0 && la < c.a1 && la === prevEnd ? changes[i - 1]! : null;
  const withNext = i + 1 < changes.length && lb > c.a2 && lb === nextStart ? changes[i + 1]! : null;
  const from = withPrev ? withPrev.a1 : la;
  const to = withNext ? withNext.a2 : lb;
  const newLines = new Set(insertedLines);
  for (const n of [withPrev, withNext]) if (n) for (const l of sideLines.slice(n.b1, n.b2)) newLines.add(l);
  const start = lts[withPrev ? from : c.a1]!;
  const end = lts[withNext ? to : c.a2]!;
  return {
    hunks,
    run: {
      side: which,
      start,
      end,
      wideStart: lts[from]!,
      wideEnd: lts[to]!,
      inner: lts.slice(from + 1, to),
      newLines,
      doubt: withPrev !== null || withNext !== null || c.loose ? [start, end] : moved,
      openStart: withPrev === null && c.joined?.before === true,
      openEnd: withNext === null && c.joined?.after === true,
    },
  };
}

/**
 * The changed run of lines `c`, written as `sideText`, diffed by tokens: its hunks, and the lines
 * (in tokens) where that diff moves line breaks, or null. `breakOnly`: the run is one line whose
 * line break alone changed.
 */
function tokenHunks(
  input: SideInput,
  c: LineHunk,
  sideText: string,
  lineSpan: [number, number] | null,
  breakOnly: boolean,
): { hunks: RawHunk[]; moved: [number, number] | null } {
  const { base, allowance } = input;
  const bt = base.tokens;
  const lts = base.lineTokenStart;
  const hunks: RawHunk[] = [];
  const tokenFrom = lts[c.a1]!;
  let tokenTo = lts[c.a2]!;
  let sideTokens = tokenize(sideText);
  spend(allowance, WORK_PER_ELEMENT * (tokenTo - tokenFrom + sideTokens.length));
  const anchored = tokenTo > tokenFrom && bt[tokenTo - 1] === '\n' && sideTokens[sideTokens.length - 1] === '\n';
  if (anchored) {
    tokenTo--;
    sideTokens = sideTokens.slice(0, -1);
  }
  // A widening by tokens stays inside the run, short of a last line break matched to the
  // side's: that line break is the run's own, kept. When the run ends in a blank line, that line
  // break is the whole line, and a change that removes or inserts a line break next to it can be
  // read as removing or inserting the blank line ("b a", "" made "a" deletes either line break).
  const endsBlank = anchored && lineStartingAt(lts, tokenTo) >= 0;
  const within: [number, number] = [tokenFrom, endsBlank ? tokenTo + 1 : tokenTo];
  // Ids local to this stretch: the diff's counting arrays are as long as the id space.
  const ids = new StringIds();
  const baseIds = ids.of(bt.slice(tokenFrom, tokenTo));
  const sideIds = ids.of(sideTokens);
  const diff = tokenReading(bt.slice(tokenFrom, tokenTo), sideTokens, baseIds, sideIds, ids.count, allowance);
  let movedFrom = Infinity;
  let movedTo = -Infinity;
  let pending: RawHunk | null = null;
  for (const d of diff) {
    const tokens = sideTokens.slice(d.b1, d.b2);
    const start = tokenFrom + d.a1;
    const end = tokenFrom + d.a2;
    // A change that deletes more or fewer line breaks than it inserts moves lines about,
    // unless it deletes or inserts whole lines. The run's last line break, when it has
    // no match on the other side (a last line that lost or gained it), does not count.
    const atLines = lineStartingAt(lts, start) >= 0 && lineStartingAt(lts, end) >= 0;
    const whole = atLines && (start < end ? tokens.length === 0 : tokens[tokens.length - 1] === '\n');
    if (!whole) {
      let out = 0;
      for (let p = start; p < end; p++) if (bt[p] === '\n' && (anchored || p < tokenTo - 1)) out++;
      let put = 0;
      for (let q = d.b1; q < d.b2; q++) if (sideTokens[q] === '\n' && (anchored || q < sideTokens.length - 1)) put++;
      if (out !== put) {
        movedFrom = Math.min(movedFrom, start);
        movedTo = Math.max(movedTo, end);
      }
    }
    const next: RawHunk = {
      start,
      end,
      tokens,
      involved: new Set([...bt.slice(start, end), ...tokens]),
      inserted: new Set(tokens),
      within,
      lineSpan,
      fromLines: breakOnly,
      startsInserting: start === end,
      endsInserting: start === end,
    };
    if (pending) {
      const between = bt.slice(pending.end, next.start);
      if (!between.some((t) => hasLetterOrDigit(t))) {
        pending = {
          start: pending.start,
          end: next.end,
          tokens: [...pending.tokens, ...between, ...next.tokens],
          involved: new Set([...pending.involved, ...next.involved]),
          inserted: new Set([...pending.inserted, ...next.inserted]),
          within,
          lineSpan,
          fromLines: breakOnly,
          startsInserting: pending.startsInserting,
          endsInserting: next.endsInserting,
        };
        continue;
      }
      hunks.push(pending);
    }
    pending = next;
  }
  if (pending) hunks.push(pending);
  // From the start of the first line it touches to the end of the line holding the token
  // after it (a line break deleted joins that line on).
  if (movedFrom > movedTo) return { hunks, moved: null };
  return {
    hunks,
    moved: [lts[lineHolding(lts, movedFrom)]!, lts[Math.min(lineHolding(lts, movedTo) + 1, lts.length - 1)]!],
  };
}

/** The side's hunks with those that meet joined, then those whose readings reach each other. */
function joinedHunks(input: SideInput, raw: readonly RawHunk[]): SideHunk[] {
  const { base, which, allowance } = input;
  const bt = base.tokens;
  const span = (x: [number, number] | null, y: [number, number] | null): [number, number] | null =>
    x && y ? [Math.min(x[0], y[0]), Math.max(x[1], y[1])] : (x ?? y);
  /** Two of this side's changes as one: the base between them is kept and becomes part of it. */
  const unite = (a: RawHunk, b: RawHunk): RawHunk => ({
    start: a.start,
    end: b.end,
    tokens: [...a.tokens, ...bt.slice(a.end, b.start), ...b.tokens],
    involved: new Set([...a.involved, ...b.involved]),
    inserted: new Set([...a.inserted, ...b.inserted]),
    within: span(a.within, b.within)!,
    lineSpan: span(a.lineSpan, b.lineSpan),
    fromLines: a.fromLines && b.fromLines,
    startsInserting: a.startsInserting,
    endsInserting: b.endsInserting,
  });
  let joined: RawHunk[] = [];
  for (const h of raw) {
    const prev = joined[joined.length - 1];
    if (prev && h.start <= prev.end) joined[joined.length - 1] = unite(prev, h);
    else joined.push(h);
  }
  // Changes whose readings reach each other are one change read two ways ("" deleted with
  // "same" kept and "same" inserted after it is also "" made into "same"): they are joined
  // and read again, until no change reaches its neighbor.
  const finish = (list: RawHunk[]) =>
    list.map((h, i) =>
      finishHunk(h, which, i > 0 ? list[i - 1]! : null, i + 1 < list.length ? list[i + 1]! : null, base),
    );
  for (;;) {
    // Each reading goes over the tokens of every change and the lines around it.
    let cost = 0;
    for (const h of joined) cost += h.end - h.start + h.tokens.length + 1;
    spend(allowance, WORK_PER_ELEMENT * cost);
    const done = finish(joined);
    const next: RawHunk[] = [];
    let changed = false;
    for (let i = 0; i < joined.length; i++) {
      const prev = next[next.length - 1];
      if (prev && i > 0 && (reach(done[i - 1]!)[1] >= joined[i]!.start || reach(done[i]!)[0] <= joined[i - 1]!.end)) {
        next[next.length - 1] = unite(prev, joined[i]!);
        changed = true;
      } else {
        next.push(joined[i]!);
      }
    }
    if (!changed) return done;
    joined = next;
  }
}

/**
 * Most cells (lines one side inserted times lines the other inserted at the same place) the
 * pairing in keepBoth may fill. Larger insertions at one place stay a conflict.
 */
const KEPT_CELLS = 1_000_000;

/** A line of text with the number of blank lines directly before it. */
interface Unit {
  blanks: number;
  text: string;
}

/** Lines (without their line breaks) as units, and the number of blank lines after the last. */
function unitsOf(lines: readonly string[]): { units: Unit[]; tail: number } {
  const units: Unit[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks++;
    } else {
      units.push({ blanks, text: line });
      blanks = 0;
    }
  }
  return { units, tail: blanks };
}

/**
 * The lines both sides inserted at one place, as one list. A line travels with the blank lines
 * before it; blank lines at the end are kept as many as the side with more has. Lines common to
 * both, in order, appear once (a longest common subsequence pairing ours's lines as late as it can);
 * between them ours's lines first, then theirs's not held by ours elsewhere. So every line of each
 * side is there, none more often than the side with more.
 *
 * Null when a line only one side has holds the words of a line only the other has, in order: it may
 * be that line edited, which kept with it would stand twice.
 */
function keepBoth(ours: readonly string[], theirs: readonly string[], allowance: Allowance): string[] | null {
  const o = unitsOf(ours);
  const t = unitsOf(theirs);
  const a = o.units;
  const b = t.units;
  const oursTexts = new Set(a.map((u) => u.text));
  const theirTexts = new Set(b.map((u) => u.text));
  const onlyOurs = [...oursTexts].filter((x) => !theirTexts.has(x)).map(wordsOf);
  const onlyTheirs = [...theirTexts].filter((y) => !oursTexts.has(y)).map(wordsOf);
  spend(allowance, RULE_WORK * onlyOurs.length * onlyTheirs.length);
  for (const x of onlyOurs) for (const y of onlyTheirs) if (wordsWithin(x, y) || wordsWithin(y, x)) return null;
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  spend(allowance, (n + 1) * width);
  // Cell i * width + j: the longest common subsequence of a[i..] and b[j..].
  const longest = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      longest[i * width + j] =
        a[i]!.text === b[j]!.text
          ? longest[(i + 1) * width + j + 1]! + 1
          : Math.max(longest[(i + 1) * width + j]!, longest[i * width + j + 1]!);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (longest[(i + 1) * width + j] === longest[i * width + j]) i++;
    else if (a[i]!.text === b[j]!.text) pairs.push([i++, j++]);
    else j++;
  }
  // Per text, how many of theirs's unpaired copies ours's unpaired copies already stand for.
  const unpaired = (units: Unit[], paired: Set<number>) => {
    const count = new Map<string, number>();
    units.forEach((u, k) => {
      if (!paired.has(k)) count.set(u.text, (count.get(u.text) ?? 0) + 1);
    });
    return count;
  };
  const oursUnpaired = unpaired(a, new Set(pairs.map((p) => p[0])));
  const held = unpaired(b, new Set(pairs.map((p) => p[1])));
  for (const [text, k] of held) held.set(text, Math.min(k, oursUnpaired.get(text) ?? 0));

  const out: string[] = [];
  const put = (blanks: number, text: string) => {
    for (let k = 0; k < blanks; k++) out.push('');
    out.push(text);
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [n, m] as const]) {
    for (; i < pi; i++) put(a[i]!.blanks, a[i]!.text);
    for (; j < pj; j++) {
      const k = held.get(b[j]!.text) ?? 0;
      if (k > 0) held.set(b[j]!.text, k - 1);
      else put(b[j]!.blanks, b[j]!.text);
    }
    if (pi < n) {
      put(Math.max(a[pi]!.blanks, b[pj]!.blanks), a[pi]!.text);
      i++;
      j++;
    }
  }
  for (let k = Math.max(o.tail, t.tail); k > 0; k--) out.push('');
  return out;
}

/**
 * The lines a pure insertion writes, when they are whole lines: text ending in a line break
 * inserted at a line start, or text starting with one inserted after a last line that has
 * none. The text is `lead`, then the lines joined by line breaks, then a line break if `closed`.
 */
function insertedWholeLines(h: SideHunk, base: BaseTokens): { lead: string; lines: string[]; closed: boolean } | null {
  const bt = base.tokens;
  const c = h.content;
  const afterLastLine = h.start === bt.length && bt.length > 0 && bt[bt.length - 1] !== '\n';
  if (!afterLastLine) {
    if (lineStartingAt(base.lineTokenStart, h.start) < 0 || !c.endsWith('\n')) return null;
    return { lead: '', lines: c.slice(0, -1).split('\n'), closed: true };
  }
  if (c.length < 2 || !c.startsWith('\n')) return null;
  const closed = c.endsWith('\n');
  return { lead: '\n', lines: c.slice(1, closed ? -1 : c.length).split('\n'), closed };
}

function mergeTokens(
  baseText: string,
  ours: string,
  theirs: string,
  exactBase: boolean,
  fences: readonly [Fence, Fence],
  out: Output,
  allowance: Allowance,
): void {
  const base = baseTokensOf(baseText, allowance);
  const runs: LineRun[] = [];
  const bySide = [
    sideHunks(base, ours, 0, fences[0], allowance, runs),
    sideHunks(base, theirs, 1, fences[1], allowance, runs),
  ] as const;
  const hunks = [...bySide[0], ...bySide[1]];
  const joins = new GroupJoins(interactionGroups(hunks, allowance));
  joinAcrossRuns(base, bySide, runs, joins, allowance);
  joinWithinLines(base, bySide, hunks, joins, allowance);
  joinRunsSharingLines(bySide, runs, joins, allowance);
  joinSameWords(bySide, hunks, joins, allowance);
  writeGroups(joins.joined(), base, exactBase, out, allowance);
}

/** The base's lines, its tokens and where each line's tokens start. */
function baseTokensOf(baseText: string, allowance: Allowance): BaseTokens {
  const lines = splitLines(baseText);
  const tokens: string[] = [];
  const lineTokenStart: number[] = [];
  for (const line of lines) {
    lineTokenStart.push(tokens.length);
    for (const t of tokenize(line)) tokens.push(t);
  }
  lineTokenStart.push(tokens.length);
  spend(allowance, WORK_PER_ELEMENT * (lines.length + tokens.length));
  const keyIds = new StringIds();
  const base: BaseTokens = { lines, lineKeys: keyIds.of(lines.map(withoutBreak)), lineTokenStart, tokens, keyIds };
  return base;
}

/** A run of the base's tokens that the hunks of both sides meeting it are merged over as one. */
type Group = { members: SideHunk[]; from: number; to: number };

/** One side's hunks (in order, apart) that meet [s, e]: they end at or after s and start at or before e. */
function near(bySide: readonly [SideHunk[], SideHunk[]], side: 0 | 1, s: number, e: number): SideHunk[] {
  const list = bySide[side];
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.end < s) lo = mid + 1;
    else hi = mid;
  }
  const out: SideHunk[] = [];
  for (let k = lo; k < list.length && list[k]!.start <= e; k++) out.push(list[k]!);
  return out;
}

/**
 * The sweep: every hunk with an interval that meets the group's joins it (the interaction rule).
 * Groups come out in order and apart in the base.
 */
function interactionGroups(hunks: readonly SideHunk[], allowance: Allowance): Group[] {
  // Every interval of every hunk, in order along the line.
  const items = hunks.flatMap((h) => h.intervals.map(([lo, hi]) => ({ lo, hi, h })));
  spend(allowance, RULE_WORK * items.length * Math.max(1, Math.ceil(Math.log2(items.length + 1))));
  items.sort((x, y) => x.lo - y.lo || x.h.side - y.h.side);

  const groups: Group[] = [];
  for (let i = 0; i < items.length;) {
    const members = new Set<SideHunk>([items[i]!.h]);
    let hi = items[i]!.hi;
    i++;
    while (i < items.length && items[i]!.lo <= hi) {
      members.add(items[i]!.h);
      hi = Math.max(hi, items[i]!.hi);
      i++;
    }
    const list = [...members];
    groups.push({ members: list, from: minOf(list, (h) => h.start), to: maxOf(list, (h) => h.end) });
  }
  return groups;
}

/**
 * Stretches that must be merged as one, clean only if both sides made it the same: a change of one
 * side in the doubtful lines of the other's run, or at an inner line start; whole lines one side
 * inserts beside such a run, equal to a line it holds; text inserted within a line the other's
 * change could occupy whole; two runs that wrote a common line; an insertion at either end of the
 * other's replacement, and changes whose readings meet writing the same words or a common line. Each
 * is joined as the groups from the first to the last holding the hunks concerned.
 */
class GroupJoins {
  private readonly groupOf = new Map<SideHunk, number>();
  private readonly ranges: [number, number][] = [];

  constructor(private readonly groups: Group[]) {
    groups.forEach((g, gi) => g.members.forEach((h) => this.groupOf.set(h, gi)));
  }

  /** The run of groups from the first to the last holding `members` is merged as one. */
  join(members: SideHunk[]): void {
    const at = members.map((h) => this.groupOf.get(h)!);
    const first = minOf(at, (x) => x);
    const last = maxOf(at, (x) => x);
    if (last > first) this.ranges.push([first, last]);
  }

  /** The groups, with ranges that share a group joined into one. */
  joined(): Group[] {
    const { ranges } = this;
    let groups = this.groups;
    if (ranges.length > 0) {
      ranges.sort((x, y) => x[0] - y[0]);
      const joined: Group[] = [];
      let next = 0;
      for (let r = 0; r < ranges.length;) {
        let [first, last] = ranges[r++]!;
        while (r < ranges.length && ranges[r]![0] <= last) last = Math.max(last, ranges[r++]![1]);
        while (next < first) joined.push(groups[next++]!);
        const run = groups.slice(first, last + 1);
        joined.push({ members: run.flatMap((g) => g.members), from: run[0]!.from, to: maxOf(run, (g) => g.to) });
        next = last + 1;
      }
      while (next < groups.length) joined.push(groups[next++]!);
      groups = joined;
    }
    return groups;
  }
}

/**
 * A run's own changes: those of its side that overlap it (a change joined with a neighbor can
 * reach beyond the run it came from).
 */
function ownHunks(bySide: readonly [SideHunk[], SideHunk[]], run: LineRun): SideHunk[] {
  return near(bySide, run.side, run.start, run.end).filter(
    (h) =>
      (h.start < run.end && h.end > run.start) || (h.start === h.end && h.start >= run.start && h.start <= run.end),
  );
}

/** The base text has no last line without a line break (or no text). */
function endsWithBreak(base: BaseTokens): boolean {
  const bt = base.tokens;
  return bt.length === 0 || bt[bt.length - 1] === '\n';
}

/**
 * The whole lines a change writes, compared without line breaks: every line it ends with a
 * line break, but the first only when the change starts at a line start, and the last also
 * when it ends the text and the text has no final line break.
 */
function fullLines(base: BaseTokens, h: SideHunk): string[] {
  const bt = base.tokens;
  const lastHasBreak = endsWithBreak(base);
  const parts = splitLines(h.content);
  const startsLine = lineStartingAt(base.lineTokenStart, h.start) >= 0 && !(h.start === bt.length && !lastHasBreak);
  const endsText = h.end === bt.length && !lastHasBreak;
  return parts
    .filter((l, k) => (k > 0 || startsLine) && (l.endsWith('\n') || (k === parts.length - 1 && endsText)))
    .map(withoutBreak);
}

/** Changes in or next to a run of lines the other side changed as one, read only one way (see GroupJoins). */
function joinAcrossRuns(
  base: BaseTokens,
  bySide: readonly [SideHunk[], SideHunk[]],
  runs: readonly LineRun[],
  joins: GroupJoins,
  allowance: Allowance,
): void {
  const bt = base.tokens;
  const lineTokenStart = base.lineTokenStart;
  const lastHasBreak = endsWithBreak(base);
  for (const run of runs) {
    const inner = new Set(run.inner);
    const own = ownHunks(bySide, run);
    const newKeys = new Set([...run.newLines].map(withoutBreak));
    // Where a run pairs new lines with old ones only by reading (LineRun.doubt), any change of the
    // other side in those lines means a different thing for each reading.
    const others = near(bySide, run.side === 0 ? 1 : 0, run.wideStart, run.wideEnd);
    spend(allowance, RULE_WORK * (others.length + own.length + run.inner.length + 1));
    for (const h of others) {
      if (run.doubt) {
        // Text inserted at the start of those lines goes into the first unless it is whole lines, as
        // does the end of a replacement just before them that stops inside a line; text at the end
        // of the last goes into it. The last line's own break is the same in every reading, so a
        // change that only deletes or restores it is outside; one that inserts other text there is
        // inside. At an open edge (openStart, openEnd), a change right at it is inside too.
        const [ds, de] = run.doubt;
        const lastBreak = de > ds && bt[de - 1] === '\n' && !run.openEnd ? de - 1 : de;
        const endsInLine = h.content !== '' && !h.content.endsWith('\n');
        const joinsLast = h.start === lastBreak && h.content !== '' && !h.content.startsWith('\n');
        const inside =
          h.start === h.end
            ? (ds < h.start || (ds === h.start && (!h.wholeLines || run.openStart))) &&
              (h.start <= lastBreak || (h.start === bt.length && !lastHasBreak))
            : (h.start < lastBreak && h.end > ds) || joinsLast || (h.end === ds && (endsInLine || run.openStart));
        if (inside) {
          joins.join([...own, h]);
          continue;
        }
      }
      // A change at or across an inner line start, or whole lines deleted or replaced from or up to
      // one: which of the run's lines it meets is a matter of reading.
      const whole =
        h.start < h.end && lineStartingAt(lineTokenStart, h.start) >= 0 && lineStartingAt(lineTokenStart, h.end) >= 0;
      const atInner =
        h.start === h.end
          ? inner.has(h.start)
          : run.inner.some((p) => h.start < p && p < h.end) || (whole && (inner.has(h.start) || inner.has(h.end)));
      // Whole lines inserted next to the run (alone, or as part of a change ending or starting
      // there), one of them equal to a line the run now holds: the same line, written twice?
      const touches =
        h.start === h.end
          ? h.start === run.wideStart || h.start === run.wideEnd
          : h.end === run.wideStart || h.start === run.wideEnd;
      const sameLine = touches && fullLines(base, h).some((l) => newKeys.has(l));
      if (atInner || sameLine) joins.join([...own, h]);
    }
  }
}

/**
 * Text one side inserts within a line (at its start included) that the other side's change could
 * occupy whole belongs to that line: read as just outside the change, it would be glued to the next
 * line. So does the end of a replacement whose new text stops inside a line.
 */
function joinWithinLines(
  base: BaseTokens,
  bySide: readonly [SideHunk[], SideHunk[]],
  hunks: readonly SideHunk[],
  joins: GroupJoins,
  allowance: Allowance,
): void {
  const bt = base.tokens;
  const lastHasBreak = endsWithBreak(base);
  const reachLines = maxOf(hunks, (h) => (h.lines ? h.lines[1] - h.lines[0] : 0), 0);
  const inLines = (p: number, ls: number, le: number) =>
    (p >= ls && p < le) || (p === le && le === bt.length && !lastHasBreak);
  for (const occ of hunks) {
    if (!occ.lines) continue;
    const [ls, le] = occ.lines;
    const candidates = near(bySide, occ.side === 0 ? 1 : 0, ls - reachLines, le + reachLines);
    spend(allowance, RULE_WORK * (candidates.length + 1));
    for (const ins of candidates) {
      const inside =
        ins.start === ins.end
          ? !ins.wholeLines && inLines(ins.start, ls, le)
          : ins.content !== '' && !ins.content.endsWith('\n') && inLines(ins.end, ls, le);
      if (inside) joins.join([occ, ins]);
    }
  }
}

/**
 * Two runs of the two sides that meet or overlap and wrote a common line: it may be
 * the same line written twice.
 */
function joinRunsSharingLines(
  bySide: readonly [SideHunk[], SideHunk[]],
  runs: readonly LineRun[],
  joins: GroupJoins,
  allowance: Allowance,
): void {
  const theirRuns = runs.filter((r) => r.side === 1).sort((x, y) => x.wideStart - y.wideStart);
  const longestRun = maxOf(theirRuns, (r) => r.wideEnd - r.wideStart, 0);
  for (const run of runs) {
    if (run.side !== 0) continue;
    // The first of theirs that can reach this run: none starting before it by more than the longest.
    let lo = 0;
    let hi = theirRuns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (theirRuns[mid]!.wideStart < run.wideStart - longestRun) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < theirRuns.length; k++) {
      const other = theirRuns[k]!;
      if (other.wideStart > run.wideEnd) break;
      spend(allowance, RULE_WORK);
      if (other.wideEnd < run.wideStart) continue;
      if ([...run.newLines].some((l) => other.newLines.has(l)))
        joins.join([...ownHunks(bySide, run), ...ownHunks(bySide, other)]);
    }
  }
}

/**
 * Two changes of the two sides whose readings meet, where the words one inserts appear in order
 * within what the other inserts, or both insert a common whole line: the same text, maybe, written
 * twice (not for one common word). And an insertion at either end of the other side's replacement,
 * whose new text can be read at either end of what it deletes.
 */
function joinSameWords(
  bySide: readonly [SideHunk[], SideHunk[]],
  hunks: readonly SideHunk[],
  joins: GroupJoins,
  allowance: Allowance,
): void {
  const reaches = new Map(hunks.map((h) => [h, reach(h)] as const));
  const writtenLines = new Map(
    hunks.map((h) => [h, new Set(splitLines(h.content).filter((l) => l.endsWith('\n')))] as const),
  );
  const words = new Map(hunks.map((h) => [h, wordsOf(h.content)] as const));
  const widest = maxOf(hunks, (h) => reaches.get(h)![1] - reaches.get(h)![0] - (h.end - h.start), 0);
  for (const a of bySide[0]) {
    if (a.content === '') continue;
    const [alo, ahi] = reaches.get(a)!;
    const candidates = near(bySide, 1, alo - widest, ahi + widest);
    spend(allowance, RULE_WORK * (candidates.length + 1));
    for (const b of candidates) {
      if (b.content === '') continue;
      // Text inserted at either end of the other's replacement: a pure insertion, or the first or
      // last part of a change folded or joined with others (RawHunk.startsInserting).
      const touches = (ins: SideHunk, rep: SideHunk) =>
        rep.start < rep.end &&
        ((ins.startsInserting && (ins.start === rep.start || ins.start === rep.end)) ||
          (ins.endsInserting && (ins.end === rep.start || ins.end === rep.end)));
      if (touches(a, b) || touches(b, a)) {
        joins.join([a, b]);
        continue;
      }
      const [blo, bhi] = reaches.get(b)!;
      if (alo > bhi || blo > ahi) continue;
      const wa = words.get(a)!;
      const wb = words.get(b)!;
      const sameWords = wordsWithin(wa, wb) || wordsWithin(wb, wa);
      const sharedLine = [...writtenLines.get(a)!].some((l) => writtenLines.get(b)!.has(l));
      if (sameWords || sharedLine) joins.join([a, b]);
    }
  }
}

/**
 * With an exact base, a group of one insertion of whole lines from each side, certainly at the same
 * point and of the same form: the two kept together (keepBoth). Null for any other group.
 */
function keptBoth(group: SideHunk[], base: BaseTokens, exactBase: boolean, allowance: Allowance): string | null {
  if (!exactBase || group.length !== 2 || group[0]!.side === group[1]!.side) return null;
  const [ourHunk, theirHunk] = group[0]!.side === 0 ? [group[0]!, group[1]!] : [group[1]!, group[0]!];
  const p = ourHunk.start;
  const a = insertedWholeLines(ourHunk, base);
  const b = insertedWholeLines(theirHunk, base);
  if (!a || !b || a.lead !== b.lead || a.closed !== b.closed) return null;
  for (const h of [ourHunk, theirHunk]) {
    if (!h.fromLines || h.start !== p || h.end !== p || !h.points) return null;
    // After a last line with no line break the insertion is read by tokens, which can slide
    // it back over the last line's own tokens. Its lines were inserted whole, and the same
    // lines with their line break read one token over are no other place for them (as in
    // changePlaces); only other lines are.
    const certain = a.lead === '' ? h.points[0] === p && h.points[1] === p : h.lines === null;
    if (!certain) return null;
  }
  if (a.lines.length * b.lines.length > KEPT_CELLS) return null;
  const lines = keepBoth(a.lines, b.lines, allowance);
  return lines === null ? null : a.lead + lines.join('\n') + (a.closed ? '\n' : '');
}

/** Each group goes out: the same on both sides, one side's change, both kept, or a conflict. */
function writeGroups(
  groups: readonly Group[],
  base: BaseTokens,
  exactBase: boolean,
  out: Output,
  allowance: Allowance,
): void {
  const bt = base.tokens;
  const joinBase = (from: number, to: number) => (from < to ? bt.slice(from, to).join('') : '');
  // The text one side gives the base stretch [from, to), applying its hunks in the group.
  const sideText = (group: SideHunk[], side: 0 | 1, from: number, to: number) => {
    let s = '';
    let pos = from;
    for (const h of group.filter((g) => g.side === side).sort((x, y) => x.start - y.start)) {
      s += joinBase(pos, h.start) + h.content;
      pos = h.end;
    }
    return s + joinBase(pos, to);
  };

  let cursor = 0;
  let lastConflictEnd = -1; // base token where the previous group ended, if it was a conflict
  for (const { members: group, from, to } of groups) {
    let sides = 0;
    for (const h of group) sides |= h.side === 0 ? 1 : 2;
    const between = joinBase(cursor, from);
    out.same(between, between);
    cursor = to;
    const o = sides & 1 ? sideText(group, 0, from, to) : null;
    const t = sides & 2 ? sideText(group, 1, from, to) : null;
    if (o === null || t === null || o === t) {
      if (t === null) out.changed(0, joinBase(from, to), o!);
      else if (o === null) out.changed(1, joinBase(from, to), t);
      else out.same(joinBase(from, to), o);
      lastConflictEnd = -1;
      continue;
    }
    const kept = keptBoth(group, base, exactBase, allowance);
    if (kept !== null) {
      out.keptBoth(kept, o, t);
      lastConflictEnd = -1;
      continue;
    }
    out.conflict(o, t, joinBase(from, to), lastConflictEnd === from);
    lastConflictEnd = to;
  }
  const rest = joinBase(cursor, bt.length);
  out.same(rest, rest);
}

// ---------------------------------------------------------------------------
// A change split in two

/**
 * Resolves both halves of a change split in two alike: a side's diff can read one change as text
 * deleted at one place and written at another, and resolved apart, a conflict can give the
 * preferred side's text at one half while the other is applied, losing or doubling the text. The
 * halves are found by a word or whole line each of the three texts holds once; a stretch applying
 * one half while the other is in a conflict becomes a conflict too (docs/ARCHITECTURE.md, "A change
 * split in two").
 */
function keepHalvesTogether(pieces: Piece[], allowance: Allowance): void {
  if (!pieces.some((p) => p.kind === 'conflict')) return;
  const { once, quiet } = readChanges(pieces, allowance);
  // A pair: the stretches holding the base's copy and those holding a side's. Where they differ,
  // the side removed the text at the first and wrote it at the second.
  const pairs: { key: string; base: Span; side: Span; kind: 'ours' | 'theirs' }[] = [];
  for (const [key, [base, ours, theirs]] of once) {
    if (ours[0] !== base[0] || ours[1] !== base[1]) pairs.push({ key, base, side: ours, kind: 'ours' });
    if (theirs[0] !== base[0] || theirs[1] !== base[1]) pairs.push({ key, base, side: theirs, kind: 'theirs' });
  }
  // Text that an unchanged stretch holds as well is no one text. Unchanged stretches are searched
  // only where a pair would make a conflict, which is rare.
  const unchanged = new Map<string, boolean>();
  const heldUnchanged = (key: string) => {
    let held = unchanged.get(key);
    if (held === undefined) {
      held =
        (key[0] === 'l' && quiet.has(key.slice(1))) ||
        pieces.some((p) => p.kind === 'same' && unchangedHolds(p, key, allowance));
      unchanged.set(key, held);
    }
    return held;
  };
  const holdsConflict = ([from, to]: Span) => {
    for (let i = from; i <= to; i++) if (pieces[i]!.kind === 'conflict') return true;
    return false;
  };
  for (let changed = true; changed;) {
    changed = false;
    spend(allowance, RULE_WORK * (pairs.length + 1));
    for (const { key, base, side, kind } of pairs) {
      for (const [half, other] of [
        [side, base],
        [base, side],
      ] as const) {
        if (!holdsConflict(other)) continue;
        for (let i = half[0]; i <= half[1]; i++) {
          const p = pieces[i]!;
          if ((p.kind !== kind && p.kind !== 'kept') || heldUnchanged(key)) continue;
          p.kind = 'conflict';
          p.join = false;
          changed = true;
        }
      }
    }
  }
}

/** The first and last of the pieces a copy of a word or line runs over. */
type Span = [number, number];

/**
 * The words and whole lines of the changed stretches that each of the three texts holds there once,
 * keyed 'w' or 'l' and their text, with the pieces each copy runs over; and the whole lines read
 * that meet no change (`quiet`), the edge lines of unchanged stretches.
 */
function readChanges(
  pieces: readonly Piece[],
  allowance: Allowance,
): { once: Map<string, [Span, Span, Span]>; quiet: Set<string> } {
  const count = new Map<string, number[]>();
  const spans = new Map<string, Span[]>();
  const quiet = new Set<string>();
  const note = (key: string, k: number, span: Span) => {
    let n = count.get(key);
    if (!n) {
      count.set(key, (n = [0, 0, 0]));
      spans.set(key, []);
    }
    n[k]!++;
    spans.get(key)![k] = span;
  };
  (['base', 'ours', 'theirs'] as const).forEach((field, k) => {
    // The line being read, the piece it starts in, and whether it meets a change.
    let line = '';
    let from = 0;
    let meets = false;
    const end = (to: number) => {
      if (line !== '') {
        if (meets) note(`l${line}`, k, [from, to]);
        else quiet.add(line);
      }
      line = '';
      from = to;
      meets = false;
    };
    pieces.forEach((p, i) => {
      const text = p[field];
      if (p.kind === 'same') {
        const first = text.indexOf('\n');
        if (first < 0) {
          line += text;
        } else {
          line += text.slice(0, first);
          end(i);
          line = text.slice(text.lastIndexOf('\n') + 1);
        }
        return;
      }
      meets = true;
      const words = wordsOf(text);
      spend(allowance, WORK_PER_ELEMENT * (words.length + 1));
      for (const w of words) note(`w${w}`, k, [i, i]);
      text.split('\n').forEach((part, j) => {
        if (j > 0) {
          end(i);
          meets = true;
        }
        line += part;
      });
    });
    end(pieces.length - 1);
  });
  const once = new Map<string, [Span, Span, Span]>();
  for (const [key, n] of count)
    if (n[0] === 1 && n[1] === 1 && n[2] === 1) once.set(key, spans.get(key) as [Span, Span, Span]);
  return { once, quiet };
}

/**
 * Characters a search for a word or a line reads per MERGE_WORK unit: a native search costs that
 * much less than a diff.
 */
const SCAN_CHARS_PER_UNIT = 32;
const WORD_CHAR = new RegExp(`(?![${CJK}])[${WORD_CHARACTER}]`, 'u');

/** Whether an unchanged stretch holds the word (key 'w…') or, between two of its line breaks, the line (key 'l…'). */
function unchangedHolds(p: Piece, key: string, allowance: Allowance): boolean {
  const u = key.slice(1);
  const wordRun = WORD_CHAR.test(u);
  // `ours` differs from `base` where both sides made the same change.
  for (const text of p.ours === p.base ? [p.base] : [p.base, p.ours]) {
    spend(allowance, text.length / SCAN_CHARS_PER_UNIT);
    if (key[0] === 'l') {
      if (text.includes(`\n${u}\n`)) return true;
      continue;
    }
    for (let i = text.indexOf(u); i >= 0; i = text.indexOf(u, i + 1)) {
      // A run of word characters is the word only from the start of the run to its end.
      if (wordRun && (wordCharEndsAt(text, i) || (i + u.length < text.length && wordCharAt(text, i + u.length))))
        continue;
      return true;
    }
  }
  return false;
}

function wordCharAt(text: string, i: number): boolean {
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(i)!));
}

/** Whether the character just before `i` is a word character (a surrogate pair read whole). */
function wordCharEndsAt(text: string, i: number): boolean {
  if (i === 0) return false;
  const low = text.charCodeAt(i - 1);
  return wordCharAt(text, i > 1 && low >= 0xdc00 && low <= 0xdfff ? i - 2 : i - 1);
}
