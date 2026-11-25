// merge3, with a check on its result: a merge that repeats text neither side repeats is
// not used.

import { lineWords } from './diff';
import { type BothInserted, type MergeDetail, type MergeResult, type Prefer, merge3Detailed } from './merge3';
import type { LogLevel } from './protocol';

/**
 * merge3, checked. A merge only takes text from one side or the other, so text can occur more
 * often in the result than in either side only where both sides' changes brought it in: the same
 * text added by each, or one text both sides held that a base older than both lacks, written once
 * from each. A result that repeats text in the second way is not trusted: the preferred side is
 * kept whole, as one conflict.
 */
export function safeMerge(
  base: string,
  ours: string,
  theirs: string,
  prefer: Prefer,
  d?: { log(level: LogLevel, message: string): void },
  options?: { exactBase?: boolean },
): MergeResult {
  const exactBase = options?.exactBase === true;
  const m = merge3Detailed(base, ours, theirs, { prefer, exactBase });
  const { text, conflicts } = m;
  if (text === ours || text === theirs || !repeatsText(base, ours, theirs, m, exactBase)) return { text, conflicts };
  d?.log(
    'warn',
    'A merge repeated text that neither side repeats; it was not used, and the whole change is treated as a conflict',
  );
  const kept = prefer === 'ours' ? ours : theirs;
  return { text: kept, conflicts: [{ from: 0, to: kept.length, ours, theirs, base }] };
}

/**
 * True when the merge `m` of `ours` and `theirs` against `base` repeats text: a stretch of lines
 * kept together (`bothInserted`) holding a line more often than both sides' lines there; a line a
 * side holds that `m` holds more often than each side and than both sides' changes give it
 * together (ours's count, plus theirs's, less the base's). Unless the base is exact (`exactBase`:
 * what both sides' changes brought in is then two additions): a line both sides' changes brought
 * in (MergeDetail.brought) that `m` holds more often than each side, a copy of each standing at
 * one place (standsAtOnePlace); or a run of three tokens within a line (runTokens), one of them
 * rare (RARE_TOKEN), that both sides' changes brought in and `m` holds more often than each side,
 * beyond the copies keeping lines together adds (keptTogether). Text only one side's changes
 * brought in, or text where the two sides' changes meet, is no repeat.
 */
export function repeatsText(
  base: string,
  ours: string,
  theirs: string,
  m: Pick<MergeDetail, 'text' | 'bothInserted' | 'brought'>,
  exactBase = false,
): boolean {
  const { text: merged, bothInserted, brought } = m;
  if (bothInserted.some((b) => holdsLineAgain(merged.slice(b.from, b.to), b.ours, b.theirs))) return true;
  const inBase = lineCounts(base);
  const inOurs = lineCounts(ours);
  const inTheirs = lineCounts(theirs);
  const inMerged = lineCounts(merged);
  for (const [line, n] of inMerged) {
    const no = inOurs.get(line) ?? 0;
    const nt = inTheirs.get(line) ?? 0;
    if ((no > 0 || nt > 0) && n > Math.max(no, nt) && n > no + nt - (inBase.get(line) ?? 0)) return true;
  }
  if (exactBase || brought.ours.length === 0 || brought.theirs.length === 0) return false;
  const fromOurs = new Set(brought.ours.flatMap((s) => [...lineCounts(s.text).keys()]));
  for (const line of new Set(brought.theirs.flatMap((s) => [...lineCounts(s.text).keys()]))) {
    const n = inMerged.get(line) ?? 0;
    if (fromOurs.has(line) && n > (inOurs.get(line) ?? 0) && n > (inTheirs.get(line) ?? 0))
      if (standsAtOnePlace(ours, theirs, brought, line)) return true;
  }
  const runsFromOurs = new Set(brought.ours.flatMap((s) => [...runCounts(s.text).keys()]));
  const shared = new Set<string>();
  for (const s of brought.theirs)
    for (const run of runCounts(s.text).keys()) if (runsFromOurs.has(run)) shared.add(run);
  if (shared.size === 0) return false;
  // Rare tokens are counted over both whole texts, so only once a run both brought in is found.
  const rare = rareTokens(ours, theirs);
  for (const run of shared) if (!run.split(RUN_SEPARATOR).some((token) => rare.has(token))) shared.delete(run);
  if (shared.size === 0) return false;
  const together = keptTogether(merged, bothInserted, shared);
  const runsInMerged = runCounts(merged, shared);
  const runsInOurs = runCounts(ours, shared);
  const runsInTheirs = runCounts(theirs, shared);
  for (const run of shared) {
    const n = (runsInMerged.get(run) ?? 0) - (together.get(run) ?? 0);
    if (n > (runsInOurs.get(run) ?? 0) && n > (runsInTheirs.get(run) ?? 0)) return true;
  }
  return false;
}

/**
 * How often `text` holds each line that is not blank. A blank line, empty or of spaces only, holds
 * no text, so it is never counted as text repeated.
 */
function lineCounts(text: string): Map<string, number> {
  const count = new Map<string, number>();
  for (const line of text.split('\n')) if (line.trim() !== '') count.set(line, (count.get(line) ?? 0) + 1);
  return count;
}

/** True when `kept` holds a line that is not blank more often than both `ours` and `theirs` do. */
function holdsLineAgain(kept: string, ours: string, theirs: string): boolean {
  const o = lineCounts(ours);
  const t = lineCounts(theirs);
  for (const [line, n] of lineCounts(kept)) if (n > (o.get(line) ?? 0) && n > (t.get(line) ?? 0)) return true;
  return false;
}

/** A token is rare in a text that holds it at most this many times. */
const RARE_TOKEN = 2;

/** The tokens (runTokens) that each of `ours` and `theirs` holds at most RARE_TOKEN times. */
function rareTokens(ours: string, theirs: string): Set<string> {
  const counts = (s: string) => {
    const c = new Map<string, number>();
    for (const token of runTokens(s)) c.set(token, (c.get(token) ?? 0) + 1);
    return c;
  };
  const o = counts(ours);
  const t = counts(theirs);
  const rare = new Set<string>();
  for (const token of new Set([...o.keys(), ...t.keys()]))
    if ((o.get(token) ?? 0) <= RARE_TOKEN && (t.get(token) ?? 0) <= RARE_TOKEN) rare.add(token);
  return rare;
}

/**
 * For each of the runs `only`, the copies keeping both sides' lines adds: for each stretch of
 * `bothInserted`, how many more `merged` holds there than that stretch as one side's alone,
 * whichever holds more. The stretch is whole lines, and a run lies within a line.
 */
function keptTogether(
  merged: string,
  bothInserted: readonly BothInserted[],
  only: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bothInserted) {
    const ours = runCounts(b.ours, only);
    const theirs = runCounts(b.theirs, only);
    for (const [run, n] of runCounts(merged.slice(b.from, b.to), only)) {
      const added = n - Math.max(ours.get(run) ?? 0, theirs.get(run) ?? 0);
      if (added > 0) out.set(run, (out.get(run) ?? 0) + added);
    }
  }
  return out;
}

const RUN_SEPARATOR = '\u0000';

/**
 * The tokens of `text` that runs are made of: each line's words and other marks, without the
 * markup lines share whatever their words (lineWords): two task lines both sides added are not
 * one text repeated for their "- [ ]".
 */
function runTokens(text: string): string[] {
  return text.split('\n').flatMap(lineWords);
}

/**
 * How often each run of three tokens occurs in `text`; with `only`, just those runs. A run lies
 * within one line: the end of one line and the start of the next are no phrase.
 */
function runCounts(text: string, only?: ReadonlySet<string>): Map<string, number> {
  const firsts = only ? new Set([...only].map((run) => run.slice(0, run.indexOf(RUN_SEPARATOR)))) : null;
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const tokens = lineWords(line);
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (firsts && !firsts.has(tokens[i]!)) continue;
      const run = tokens[i] + RUN_SEPARATOR + tokens[i + 1] + RUN_SEPARATOR + tokens[i + 2];
      if (only && !only.has(run)) continue;
      out.set(run, (out.get(run) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Whether a copy of `line` that ours's changes brought in and one that theirs's brought in stand
 * at one place: the nearest line before them that is not blank, or after them, is the same line
 * in both texts. Then both are one text both sides held, which a base older than both lacks;
 * the same line added at two places stands between different lines.
 */
function standsAtOnePlace(ours: string, theirs: string, brought: MergeDetail['brought'], line: string): boolean {
  const around = (text: string, stretches: readonly { text: string; at: number }[]) =>
    copiesOf(text, line, stretches).map((at) => neighbors(text, at, at + line.length));
  const inTheirs = around(theirs, brought.theirs);
  return around(ours, brought.ours).some((o) =>
    inTheirs.some((t) => (o.before !== null && o.before === t.before) || (o.after !== null && o.after === t.after)),
  );
}

/** Where `line` stands as a whole line of `text` within one of `stretches`. */
function copiesOf(text: string, line: string, stretches: readonly { text: string; at: number }[]): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(line); at >= 0; at = text.indexOf(line, at + 1)) {
    const whole =
      (at === 0 || text[at - 1] === '\n') && (at + line.length === text.length || text[at + line.length] === '\n');
    if (whole && stretches.some((s) => at < s.at + s.text.length && at + line.length > s.at)) out.push(at);
  }
  return out;
}

/**
 * The nearest lines of `text` that are not blank before the whole line [from, to) and after it,
 * or null where there is none.
 */
function neighbors(text: string, from: number, to: number): { before: string | null; after: string | null } {
  let before: string | null = null;
  for (let end = from - 1; end >= 0;) {
    const start = end === 0 ? 0 : text.lastIndexOf('\n', end - 1) + 1;
    const l = text.slice(start, end);
    if (l.trim() !== '') {
      before = l;
      break;
    }
    end = start - 1;
  }
  let after: string | null = null;
  for (let start = to + 1; start <= text.length && to < text.length;) {
    const end = text.indexOf('\n', start);
    const l = text.slice(start, end < 0 ? text.length : end);
    if (l.trim() !== '') {
      after = l;
      break;
    }
    if (end < 0) break;
    start = end + 1;
  }
  return { before, after };
}
