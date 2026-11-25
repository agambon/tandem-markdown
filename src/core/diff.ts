// Exact text changes between two LF texts. diffChanges runs a line diff, then refines each changed
// stretch character by character, so an outside edit to two places in one long line comes out as
// two changes. The promise: applyChanges(a, diffChanges(a, b)) === b, for every a and b.

import { CODE_LF } from './markdownText';
import { type SequenceHunk, StringIds, commonSubsequenceLength, diffSequences } from './sequenceDiff';
import { lineStartAt } from './textLines';
import { LETTER_OR_DIGIT } from './wordChars';

export interface TextChange {
  /** Start offset in the OLD text. */
  from: number;
  /** End offset (exclusive) in the OLD text. */
  to: number;
  insert: string;
}

/** A changed stretch is refined character by character only when both sides are shorter than this. */
const CHAR_DIFF_LIMIT = 4000;

/**
 * Search work allowed for one stretch's character diff, per character of the stretch. A stretch
 * rewritten end to end would otherwise cost its length times its edit count; once this runs out,
 * the rest of it is one replacement, as folding would have made it.
 */
const CHAR_DIFF_WORK_PER_CHAR = 16;

/**
 * Work allowed for one whole diffChanges call, shared by the line diff and every stretch's
 * character diff (one unit per diagonal visited and per element a snake steps over, and
 * WORK_PER_REFINED_CHAR per character refined). It runs on the extension host's thread and in the
 * save step, so a text rewritten end to end must stay well under 150 ms at a megabyte. Once spent,
 * the line search stops and each stretch not yet refined is one trimmed replacement: still exact,
 * only coarser. At this size about 200 KB of changed paragraphs are refined.
 */
const CALL_WORK = 4_000_000;

/** What handing one character to a character diff costs, in CALL_WORK units (measured against a diagonal visit). */
const WORK_PER_REFINED_CHAR = 10;

/**
 * The changes that turn oldText into newText: ascending by `from`, never empty, separated by at
 * least one unchanged character (`to < next.from`), and never cutting a surrogate pair.
 *
 * `fold: false`: a short unchanged run between two changes is not folded into them
 * (mergeShortEqualities), for carrying places, where an unchanged piece must keep its place.
 *
 * `lines: true`: lines are compared first (refineLines), so a line inserted never takes characters
 * from a line beside it; for judging what a version did to text the user saved.
 */
export function diffChanges(
  oldText: string,
  newText: string,
  options: { fold?: boolean; lines?: boolean } = {},
): TextChange[] {
  const refine = options.lines === true ? refineLines : refineStretch;
  return diffByLines(oldText, newText, refine, options.fold !== false, true);
}

/** Refines one stretch of changed lines into `out` (refineStretch, refineLines). */
type Refine = (
  oldText: string,
  oldFrom: number,
  oldTo: number,
  newText: string,
  newFrom: number,
  newTo: number,
  out: TextChange[],
  work: { left: number },
  fold: boolean,
) => void;

/**
 * diffChanges' comparison: whole lines matched first, each stretch of changed lines then refined.
 * With `repeatsMatch` false, a line either text holds more than once among the changed lines is
 * matched with nothing, so only lines each text holds once pair the texts' lines.
 */
function diffByLines(
  oldText: string,
  newText: string,
  refine: Refine,
  fold: boolean,
  repeatsMatch: boolean,
): TextChange[] {
  if (oldText === newText) return [];
  const out: TextChange[] = [];
  const work = { left: CALL_WORK };

  // Only the lines between the whole lines the texts start and end with in common are split
  // and searched: diffSequences would set those same lines aside, after interning them all.
  const common = commonLines(oldText, newText);
  const oldStarts = lineStarts(oldText, common.start, common.oldEnd);
  const newStarts = lineStarts(newText, common.start, common.newEnd);

  // Give each distinct line a small integer id, shared by both texts.
  const ids = new StringIds();
  const a = lineIds(ids, oldText, oldStarts);
  const b = lineIds(ids, newText, newStarts);
  const idCount = repeatsMatch ? ids.count : unmatchRepeats(a, b, ids.count);

  const hunks = diffSequences(a, b, idCount, work);
  for (const h of hunks) {
    let oldFrom = oldStarts[h.a1]!;
    let oldTo = oldStarts[h.a2]!;
    let newFrom = newStarts[h.b1]!;
    let newTo = newStarts[h.b2]!;
    if (oldTo > oldText.length) {
      // The stretch runs to the end of both texts, through the line break their last lines are
      // counted as ending with (lineStarts), which neither holds: it ends one character sooner. If
      // that empties one side, a last line gained or lost its break, and both start one earlier, on
      // the break before (that line is not empty, so a character still separates the stretches).
      oldTo--;
      newTo--;
      if (oldFrom > oldTo || newFrom > newTo) {
        oldFrom--;
        newFrom--;
      }
    }
    refine(oldText, oldFrom, oldTo, newText, newFrom, newTo, out, work, fold);
  }
  return out;
}

/** Applies changes in offsets of `text`, ascending and not overlapping; anything else throws. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  if (changes.length === 0) return text;
  const parts: string[] = [];
  let pos = 0;
  for (const c of changes) {
    if (!(c.from >= pos && c.to >= c.from && c.to <= text.length)) {
      throw new RangeError(
        `applyChanges: change {from: ${c.from}, to: ${c.to}} is out of order, overlapping or outside a text of length ${text.length}`,
      );
    }
    parts.push(text.slice(pos, c.from), c.insert);
    pos = c.to;
  }
  parts.push(text.slice(pos));
  return parts.join('');
}

/**
 * diffChanges, or the same comparison with no repeated line matched and lines refined first
 * (diffByLines), whichever changes less text. A line the note repeats ("- [ ] item", a rule) can
 * pair with a copy of itself far from where it stood: a block edited line by line in place then
 * reads as the edited block inserted at one place and the old block deleted at another. Asked
 * only of changes that read so.
 */
export function diffInPlace(oldText: string, newText: string): TextChange[] {
  const matched = diffChanges(oldText, newText);
  if (!movesLines(oldText, matched)) return matched;
  const inPlace = diffByLines(oldText, newText, refineLines, true, false);
  return changedLength(inPlace) < changedLength(matched) ? inPlace : matched;
}

/** Whether one of `changes` inserts whole lines and another deletes whole lines. */
function movesLines(oldText: string, changes: readonly TextChange[]): boolean {
  let deletes = false;
  let inserts = false;
  for (const c of changes) {
    // Whole lines: from a line's start to a line's start, putting in lines that each end in a break.
    const whole =
      startsLine(oldText, c.from) && startsLine(oldText, c.to) && (c.insert === '' || c.insert.endsWith('\n'));
    if (!whole) continue;
    const deletesLines = c.to > c.from;
    const insertsLines = c.insert !== '';
    if ((deletesLines && inserts) || (insertsLines && deletes)) return true;
    deletes ||= deletesLines;
    inserts ||= insertsLines;
  }
  return false;
}

/** How many characters `changes` delete and insert. */
function changedLength(changes: readonly TextChange[]): number {
  return changes.reduce((n, c) => n + (c.to - c.from) + c.insert.length, 0);
}

// ---------------------------------------------------------------------------
// Lines

/**
 * Where each line of text[from, to) starts, then where the next would; a line keeps its "\n". When
 * `to` is the text's end, the last line is counted as ending with a break the text lacks, so the
 * last offset is `to + 1`.
 */
function lineStarts(text: string, from: number, to: number): number[] {
  const starts = [from];
  let i = text.indexOf('\n', from);
  while (i >= 0 && i < to) {
    starts.push(i + 1);
    i = text.indexOf('\n', i + 1);
  }
  if (to === text.length) starts.push(to + 1);
  return starts;
}

/** Characters compared at once while looking for the common start and end of two texts. */
const COMPARE_CHUNK = 1024;

/**
 * The whole lines two different texts start and end with in common, as diffSequences would
 * count them over their lines: the differing lines are a[start, oldEnd) and b[start, newEnd).
 */
function commonLines(a: string, b: string): { start: number; oldEnd: number; newEnd: number } {
  const shorter = Math.min(a.length, b.length);
  let p = 0;
  while (p + COMPARE_CHUNK <= shorter && a.slice(p, p + COMPARE_CHUNK) === b.slice(p, p + COMPARE_CHUNK)) {
    p += COMPARE_CHUNK;
  }
  while (p < shorter && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  // Back to the start of the line the first difference is on.
  const start = lineStartAt(a, p);

  // The common end, in characters, within what is left of the shorter text.
  const room = shorter - start;
  let s = 0;
  while (
    s + COMPARE_CHUNK <= room &&
    a.slice(a.length - s - COMPARE_CHUNK, a.length - s) === b.slice(b.length - s - COMPARE_CHUNK, b.length - s)
  ) {
    s += COMPARE_CHUNK;
  }
  while (s < room && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  // Forward to the first position of that end that starts a line in both texts. Inside it
  // the texts agree, so a line break there is one in both.
  const delta = b.length - a.length;
  let oldEnd = a.length - s;
  if (!startsLine(a, oldEnd) || !startsLine(b, oldEnd + delta)) {
    const lineBreak = a.indexOf('\n', oldEnd);
    oldEnd = lineBreak < 0 ? a.length : lineBreak + 1;
  }
  return { start, oldEnd, newEnd: oldEnd + delta };
}

function startsLine(text: string, pos: number): boolean {
  return pos === 0 || text.charCodeAt(pos - 1) === CODE_LF;
}

/**
 * The key of the empty line after a text's final line break. It holds nothing, so it matches
 * only the other text's: no other line's key holds a line break.
 */
const EMPTY_LAST_LINE = '\n';

/**
 * The ids of the lines that start at `starts` (see lineStarts). A line is compared without its
 * line break, so a last line that has none equals the same line followed by one.
 */
function lineIds(ids: StringIds, text: string, starts: readonly number[]): Int32Array {
  const out = new Int32Array(starts.length - 1);
  for (let i = 0; i < out.length; i++) {
    const from = starts[i]!;
    out[i] = ids.idFor(from === text.length ? EMPTY_LAST_LINE : text.slice(from, starts[i + 1]! - 1));
  }
  return out;
}

/**
 * Gives every line of `a` or `b` whose id that text holds more than once an id of its own, which
 * matches no other line; returns the new count of ids.
 */
function unmatchRepeats(a: Int32Array, b: Int32Array, idCount: number): number {
  let next = idCount;
  for (const ids of [a, b]) {
    const seen = new Int32Array(idCount);
    for (const id of ids) seen[id]!++;
    for (let i = 0; i < ids.length; i++) if (ids[i]! < idCount && seen[ids[i]!]! > 1) ids[i] = next++;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Refining one changed stretch

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function refineStretch(
  oldText: string,
  oldFrom: number,
  oldTo: number,
  newText: string,
  newFrom: number,
  newTo: number,
  out: TextChange[],
  work: { left: number },
  fold = true,
): void {
  // Common prefix, never ending between the halves of a surrogate pair.
  let p = 0;
  const maxP = Math.min(oldTo - oldFrom, newTo - newFrom);
  while (p < maxP && oldText.charCodeAt(oldFrom + p) === newText.charCodeAt(newFrom + p)) p++;
  if (p > 0 && isHighSurrogate(oldText.charCodeAt(oldFrom + p - 1))) p--;
  // Common suffix of what is left, never starting on the low half of a pair.
  let s = 0;
  const maxS = maxP - p;
  while (s < maxS && oldText.charCodeAt(oldTo - 1 - s) === newText.charCodeAt(newTo - 1 - s)) s++;
  if (s > 0 && isLowSurrogate(oldText.charCodeAt(oldTo - s))) s--;

  const o1 = oldFrom + p;
  const o2 = oldTo - s;
  const n1 = newFrom + p;
  const n2 = newTo - s;
  if (o1 === o2 && n1 === n2) return;
  if (o1 === o2 || n1 === n2 || o2 - o1 >= CHAR_DIFF_LIMIT || n2 - n1 >= CHAR_DIFF_LIMIT || work.left <= 0) {
    out.push({ from: o1, to: o2, insert: newText.slice(n1, n2) });
    return;
  }

  // Character diff over code points, so no boundary can split a pair.
  work.left -= WORK_PER_REFINED_CHAR * (o2 - o1 + (n2 - n1));
  const ids = new CharIds();
  const oldPoints = ids.points(oldText, o1, o2);
  const newPoints = ids.points(newText, n1, n2);
  const a = oldPoints.ids;
  const b = newPoints.ids;
  const allowed = Math.max(0, Math.min(CHAR_DIFF_WORK_PER_CHAR * (a.length + b.length), work.left));
  const budget = { left: allowed };
  const found = diffSequences(a, b, ids.count, budget);
  const hunks = fold ? mergeShortEqualities(found) : found;
  work.left -= allowed - budget.left; // budget.left ends below zero when the last search step overran
  const oldAt = (k: number) => o1 + (oldPoints.offsets ? oldPoints.offsets[k]! : k);
  const newAt = (k: number) => n1 + (newPoints.offsets ? newPoints.offsets[k]! : k);
  for (const h of hunks) {
    out.push({ from: oldAt(h.a1), to: oldAt(h.a2), insert: newText.slice(newAt(h.b1), newAt(h.b2)) });
  }
}

/**
 * refineStretch, lines first. A character comparison of several lines can match one line's
 * characters with two lines' ("notes" made "note" with a line "what it adds" inserted below comes
 * out as "what it add" inserted before the "s"); here an inserted line never takes characters from
 * a line beside it. The lines are matched first, in groups (lineGroups). Where the character
 * comparison keeps characters unchanged only within a group, it stands; otherwise the stretch is
 * compared again within each group, and a line in no group is deleted or inserted whole. A stretch
 * that only breaks the same words into lines differently stands as compared.
 */
function refineLines(
  oldText: string,
  oldFrom: number,
  oldTo: number,
  newText: string,
  newFrom: number,
  newTo: number,
  out: TextChange[],
  work: { left: number },
  fold: boolean,
): void {
  const found: TextChange[] = [];
  refineStretch(oldText, oldFrom, oldTo, newText, newFrom, newTo, found, work, fold);
  const breaksLine = (c: TextChange) => {
    const i = oldText.indexOf('\n', c.from);
    return c.insert.includes('\n') || (i >= 0 && i < c.to);
  };
  if (!found.some(breaksLine) || sameWords(oldText.slice(oldFrom, oldTo), newText.slice(newFrom, newTo))) {
    for (const c of found) out.push(c);
    return;
  }
  const oldLines = stretchLines(oldText, oldFrom, oldTo);
  const newLines = stretchLines(newText, newFrom, newTo);
  const pairs = sharedByLines(oldText, oldFrom, oldTo, newFrom, found, oldLines, newLines);
  const blocks =
    lineGroups(oldText, oldLines, newText, newLines, work) ??
    groupsByCharacters(oldText, oldLines, newText, newLines, pairs);
  const oldGroup = new Int32Array(oldLines.length).fill(-1);
  const newGroup = new Int32Array(newLines.length).fill(-1);
  blocks.forEach((b, k) => {
    oldGroup.fill(k, b.o1, b.o2 + 1);
    newGroup.fill(k, b.n1, b.n2 + 1);
  });
  if (pairs.every((p) => oldGroup[p.o] !== -1 && oldGroup[p.o] === newGroup[p.n])) {
    for (const c of found) out.push(c);
    return;
  }

  const rebuilt: TextChange[] = [];
  const add = (c: TextChange) => {
    const last = rebuilt[rebuilt.length - 1];
    if (last !== undefined && last.to === c.from)
      rebuilt[rebuilt.length - 1] = { from: last.from, to: c.to, insert: last.insert + c.insert };
    else rebuilt.push(c);
  };
  const line = (text: string, starts: readonly number[], k: number) => text.slice(starts[k]!, starts[k + 1]!);
  // The lines between two groups, in none: deleted and inserted whole, but for the same whole
  // lines at either end.
  const between = (o1: number, o2: number, n1: number, n2: number) => {
    while (o1 < o2 && n1 < n2 && line(oldText, oldLines, o1) === line(newText, newLines, n1)) {
      o1++;
      n1++;
    }
    while (o1 < o2 && n1 < n2 && line(oldText, oldLines, o2 - 1) === line(newText, newLines, n2 - 1)) {
      o2--;
      n2--;
    }
    if (o1 < o2 || n1 < n2)
      add({ from: oldLines[o1]!, to: oldLines[o2]!, insert: newText.slice(newLines[n1]!, newLines[n2]!) });
  };
  let o = 0;
  let n = 0;
  for (const b of blocks) {
    between(o, b.o1, n, b.n1);
    const within: TextChange[] = [];
    const [of, ot, nf, nt] = [oldLines[b.o1]!, oldLines[b.o2 + 1]!, newLines[b.n1]!, newLines[b.n2 + 1]!];
    refineStretch(oldText, of, ot, newText, nf, nt, within, work, fold);
    for (const c of within) add(c);
    o = b.o2 + 1;
    n = b.n2 + 1;
  }
  between(o, oldLines.length - 1, n, newLines.length - 1);
  for (const c of rebuilt) out.push(c);
}

/** Where each line of text[from, to) starts, then `to`: line k is [starts[k], starts[k + 1]). */
function stretchLines(text: string, from: number, to: number): number[] {
  const starts = [from];
  for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  if (starts[starts.length - 1] !== to) starts.push(to);
  return starts;
}

/** Lines o1 to o2 of the old text matched with lines n1 to n2 of the new (indexes into stretchLines' starts). */
interface LineGroup {
  o1: number;
  o2: number;
  n1: number;
  n2: number;
}

/** The most pairs of lines whose words lineGroups compares, for one stretch. */
const LINE_PAIRS = 2500;

/** Words, and the characters that are neither words nor white space: what lineWords counts. */
const LINE_TOKEN = new RegExp(`[${LETTER_OR_DIGIT}]+|[^\\s${LETTER_OR_DIGIT}]`, 'gu');

/** The markup at a line's start: quote marks, then a list item's or a task's marker, or a heading's marks. */
const LINE_MARKUP = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/;

/** A line that starts an item of its own, by its marker: a list item, a task or a heading (quoted or not). */
const ITEM_START = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]|#{1,6}[ \t])/;

/**
 * The marker a line starts an item with (ITEM_START), without its white space and quote marks and
 * with any number as "#" ("-", "1." as "#.", "##"), or null for a line that starts none.
 */
function itemMark(line: string): string | null {
  const m = ITEM_START.exec(line);
  return m === null ? null : m[0].replace(/[\s>]+/g, '').replace(/\d+/, '#');
}

/**
 * A line's words, without the markup neighboring lines share whatever their words (LINE_MARKUP at
 * its start, emphasis marks); a line of markup alone keeps its marks. Used by lineGroups and by
 * safeMerge's runs.
 */
export function lineWords(line: string): string[] {
  const words = (line.replace(LINE_MARKUP, '').match(LINE_TOKEN) ?? []).filter((t) => !/^[*_~`]$/.test(t));
  return words.length > 0 ? words : (line.match(LINE_TOKEN) ?? []);
}

/**
 * The lines of a stretch matched by their words (lineWords), in order: the pairs that together
 * share the most, each sharing one at least; then, to each pair, the lines beside it in no pair that
 * share more than half their own with the other side's lines (a line broken in two, or lines
 * joined). A line that starts a list item, task or heading joins only as the first piece of the
 * line beside it with the same marker. Then two groups side by side holding the same words are one.
 * Null past LINE_PAIRS pairs of lines, or past the work left.
 */
function lineGroups(
  oldText: string,
  oldLines: readonly number[],
  newText: string,
  newLines: readonly number[],
  work: { left: number },
): LineGroup[] | null {
  const n = oldLines.length - 1;
  const m = newLines.length - 1;
  if (n === 0 || m === 0) return [];
  if (n * m > LINE_PAIRS) return null;
  const lineAt = (text: string, starts: readonly number[], k: number) => text.slice(starts[k]!, starts[k + 1]!);
  const words = (text: string, starts: readonly number[]) =>
    Array.from({ length: starts.length - 1 }, (_, k) => lineWords(lineAt(text, starts, k)));
  const a = words(oldText, oldLines);
  const b = words(newText, newLines);
  const cost = a.reduce((s, x) => s + x.length, 0) * b.reduce((s, x) => s + x.length, 0);
  if (cost > work.left) return null;
  work.left -= cost;
  const shared = a.map((x) => b.map((y) => commonSubsequenceLength(x, y)));

  // The pairs that share the most together, in order.
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const s = shared[i]![j]!;
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, s > 0 ? s + best[i + 1]![j + 1]! : 0);
    }
  const groups: LineGroup[] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    const s = shared[i]![j]!;
    if (s > 0 && best[i]![j] === s + best[i + 1]![j + 1]!) {
      groups.push({ o1: i, o2: i, n1: j, n2: j });
      i++;
      j++;
    } else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }

  // Lines beside a group made mostly of the other side's words there. One that starts an item
  // joins only as the group's first piece, with the marker the other side's first line starts with.
  const piece = (line: string, first: boolean, other: string) => {
    const mark = itemMark(line);
    return mark === null || (first && mark === itemMark(other));
  };
  const newLine = (k: number, first: boolean, g: LineGroup) =>
    piece(lineAt(newText, newLines, k), first, lineAt(oldText, oldLines, g.o1)) &&
    mostly(b[k]!, a.slice(g.o1, g.o2 + 1));
  const oldLine = (k: number, first: boolean, g: LineGroup) =>
    piece(lineAt(oldText, oldLines, k), first, lineAt(newText, newLines, g.n1)) &&
    mostly(a[k]!, b.slice(g.n1, g.n2 + 1));
  groups.forEach((g, k) => {
    const prev = groups[k - 1];
    const next = groups[k + 1];
    while (g.n1 > (prev?.n2 ?? -1) + 1 && newLine(g.n1 - 1, true, g)) g.n1--;
    while (g.n2 < (next?.n1 ?? m) - 1 && newLine(g.n2 + 1, false, g)) g.n2++;
    while (g.o1 > (prev?.o2 ?? -1) + 1 && oldLine(g.o1 - 1, true, g)) g.o1--;
    while (g.o2 < (next?.o1 ?? n) - 1 && oldLine(g.o2 + 1, false, g)) g.o2++;
  });
  const merged: LineGroup[] = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      last.o2 + 1 === g.o1 &&
      last.n2 + 1 === g.n1 &&
      sameWords(
        oldText.slice(oldLines[last.o1]!, oldLines[g.o2 + 1]!),
        newText.slice(newLines[last.n1]!, newLines[g.n2 + 1]!),
      )
    ) {
      last.o2 = g.o2;
      last.n2 = g.n2;
    } else merged.push(g);
  }
  return merged;
}

/** Whether more than half of `line`'s words stand, in order, among the words of the lines `of`. */
function mostly(line: readonly string[], of: readonly (readonly string[])[]): boolean {
  return line.length > 0 && 2 * commonSubsequenceLength(line, of.flat()) > line.length;
}

/** Whether two texts hold the same words in the same order, whatever white space parts them. */
export function sameWords(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * The groups of lines for a stretch too large for lineGroups, from the character comparison: a line
 * spread over several is matched with the one sharing the most of it, and each other holding more
 * of its characters than not. A group is each run of pairs linked by a line in common.
 */
function groupsByCharacters(
  oldText: string,
  oldLines: readonly number[],
  newText: string,
  newLines: readonly number[],
  pairs: readonly LinePair[],
): LineGroup[] {
  const oldSide = sideOf(oldText, oldLines, pairs, (p) => p.o);
  const newSide = sideOf(newText, newLines, pairs, (p) => p.n);
  const matched = pairs.filter(
    (p, k) =>
      (oldSide.pairs[p.o] === 1 || oldSide.top[p.o] === k || newSide.own(p.n)) &&
      (newSide.pairs[p.n] === 1 || newSide.top[p.n] === k || oldSide.own(p.o)),
  );
  const groups: LineGroup[] = [];
  for (const p of matched) {
    const last = groups[groups.length - 1];
    if (last !== undefined && (last.o2 === p.o || last.n2 === p.n)) {
      last.o2 = p.o;
      last.n2 = p.n;
    } else groups.push({ o1: p.o, o2: p.o, n1: p.n, n2: p.n });
  }
  return groups;
}

interface LinePair {
  /** The line in the old text and in the new (indexes into stretchLines' starts). */
  o: number;
  n: number;
  /** How many characters, white space aside, the comparison leaves unchanged between them. */
  w: number;
}

/**
 * For the characters `changes` (a character comparison of the stretch from oldFrom and newFrom
 * to oldTo) leave unchanged, white space aside, the pairs of lines they stand in, in order.
 */
function sharedByLines(
  oldText: string,
  oldFrom: number,
  oldTo: number,
  newFrom: number,
  changes: readonly TextChange[],
  oldLines: readonly number[],
  newLines: readonly number[],
): LinePair[] {
  const pairs: LinePair[] = [];
  let ol = 0;
  let nl = 0;
  const kept = (x: number, y: number, length: number) => {
    for (let k = 0; k < length; k++) {
      while (x + k >= oldLines[ol + 1]!) ol++;
      while (y + k >= newLines[nl + 1]!) nl++;
      if (/\s/.test(oldText[x + k]!)) continue;
      const last = pairs[pairs.length - 1];
      if (last !== undefined && last.o === ol && last.n === nl) last.w++;
      else pairs.push({ o: ol, n: nl, w: 1 });
    }
  };
  let o = oldFrom;
  let n = newFrom;
  for (const c of changes) {
    kept(o, n, c.from - o);
    n += c.from - o + c.insert.length;
    o = c.to;
  }
  kept(o, n, oldTo - o);
  return pairs;
}

/**
 * For each line of one side: how many pairs it stands in, the pair sharing the most of it (the
 * first, on a tie), and whether more of its characters stand in pairs than not (`own`), white
 * space aside.
 */
function sideOf(
  text: string,
  starts: readonly number[],
  pairs: readonly LinePair[],
  lineOf: (p: LinePair) => number,
): { pairs: Int32Array; top: Int32Array; own: (k: number) => boolean } {
  const count = starts.length - 1;
  const inPairs = new Int32Array(count);
  const top = new Int32Array(count).fill(-1);
  const shared = new Int32Array(count);
  pairs.forEach((p, k) => {
    const l = lineOf(p);
    inPairs[l]!++;
    shared[l]! += p.w;
    if (top[l] === -1 || p.w > pairs[top[l]!]!.w) top[l] = k;
  });
  const own = (k: number) => {
    let solid = 0;
    for (let i = starts[k]!; i < starts[k + 1]!; i++) if (!/\s/.test(text[i]!)) solid++;
    return 2 * shared[k]! > solid;
  };
  return { pairs: inPairs, top, own };
}

// Small integer ids for the code points of one stretch. Code points in planes 0 and 1
// (which hold nearly all text, emoji included) go through a table shared by all calls,
// stamped per stretch so it never needs clearing; the rest go through a map.
const TABLE_SIZE = 0x20000;
const tableId = new Int32Array(TABLE_SIZE);
const tableStamp = new Int32Array(TABLE_SIZE);
let currentStamp = 0;

class CharIds {
  count = 0;
  private readonly stamp: number;
  private readonly astral = new Map<number, number>();

  constructor() {
    if (currentStamp === 0x7fffffff) {
      tableStamp.fill(0);
      currentStamp = 0;
    }
    this.stamp = ++currentStamp;
  }

  private id(cp: number): number {
    if (cp < TABLE_SIZE) {
      if (tableStamp[cp] !== this.stamp) {
        tableStamp[cp] = this.stamp;
        tableId[cp] = this.count++;
      }
      return tableId[cp]!;
    }
    let id = this.astral.get(cp);
    if (id === undefined) {
      id = this.count++;
      this.astral.set(cp, id);
    }
    return id;
  }

  /**
   * The code points of text[from, to) as ids. `offsets[k]` is where code point k starts,
   * counted from `from` (with the end offset last); null when every code point is one
   * code unit, so that k is its own offset.
   */
  points(text: string, from: number, to: number): { ids: Int32Array; offsets: Int32Array | null } {
    const length = to - from;
    const ids = new Int32Array(length);
    let offsets: Int32Array | null = null;
    let k = 0;
    for (let i = from; i < to; k++) {
      const c = text.charCodeAt(i);
      if (isHighSurrogate(c) && i + 1 < to && isLowSurrogate(text.charCodeAt(i + 1))) {
        if (!offsets) {
          offsets = new Int32Array(length + 1);
          for (let j = 0; j < k; j++) offsets[j] = j;
        }
        offsets[k] = i - from;
        ids[k] = this.id(((c - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00) + 0x10000);
        i += 2;
      } else {
        if (offsets) offsets[k] = i - from;
        ids[k] = this.id(c);
        i += 1;
      }
    }
    if (offsets) {
      offsets[k] = length;
      return { ids: ids.subarray(0, k), offsets: offsets.subarray(0, k + 1) };
    }
    return { ids, offsets: null };
  }
}

/**
 * A character diff of two rewritten sentences matches stray letters and spaces and comes out as
 * dozens of one-letter changes: a short unchanged run no longer than the changes on both sides of
 * it is folded into them, so a rewrite reads as one change while two edits far apart stay two.
 */
function mergeShortEqualities(hunks: SequenceHunk[]): SequenceHunk[] {
  const out: SequenceHunk[] = [];
  const size = (h: SequenceHunk) => Math.max(h.a2 - h.a1, h.b2 - h.b1);
  for (const h of hunks) {
    let cur = h;
    while (out.length > 0) {
      const prev = out[out.length - 1]!;
      const gap = cur.a1 - prev.a2;
      if (gap > size(prev) || gap > size(cur)) break;
      out.pop();
      cur = { a1: prev.a1, a2: cur.a2, b1: prev.b1, b2: cur.b2 };
    }
    out.push(cur);
  }
  return out;
}
