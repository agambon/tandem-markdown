// Pure decision engine for outside disk changes. Given the document, disk text, and possible
// starting bases, it returns one of four outcomes: follow, merge, conflict (keepMine / keepTheirs),
// or safe handoff. Enforces both the uncertain-origin rule and the unsaved-typing exit guard here.

import { type TextChange, diffChanges } from '../diff';
import { type MergeResult, type Prefer, merge3Detailed } from '../merge3';
import { repeatsText } from '../safeMerge';
import { type Run, carryOffset } from '../textLines';
import { clashPassages } from './conflictPlaces';
import { asWritten } from './disk';
import type { ClashPassage, ConflictReason } from './types';

export interface ReconcileInput {
  /** Current document LF text. */
  doc: string;
  /** Document encoding (used to normalize lone surrogates when comparing with disk). */
  encoding: string;
  /** Last known synced LF disk text, or null when unknown (e.g. restored dirty note). */
  base: string | null;
  /** Candidate texts the disk write could have started from (base plus any in-flight save texts). */
  possibleBases: readonly string[];
  /** Settled LF text read from disk. */
  disk: string;
  /** True when the disk read remained unmistakably truncated after its retry. */
  truncated: boolean;
  /** User preference for overlapping edits (`keepMine` -> 'ours', `keepTheirs` -> 'theirs'). */
  prefer: Prefer;
  /** True when no undo/redo/reload jumped between `base` and `doc` (enables both-sides-insert). */
  exactBase: boolean;
  /** True right after `didSave`, where disk equal to pre-save `base` means an external revert. */
  afterSave?: boolean;
}

export type ReconcileDecision =
  | { action: 'noop' }
  | { action: 'advanceBase'; nextBase: string }
  | { action: 'follow'; nextText: string; nextBase: string; quietBackupOf: string; truncated: boolean }
  | { action: 'merge'; nextText: string; nextBase: string; quietBackupOf?: string }
  | {
      action: 'conflictKeepOurs';
      nextText: string;
      nextBase: string;
      passages: ClashPassage[];
      restMerged: boolean;
      quietBackupOf?: string;
    }
  | {
      action: 'conflictKeepTheirs';
      nextText: string;
      nextBase: string;
      undoTarget: string;
    }
  | {
      action: 'handoff';
      reason: Exclude<ConflictReason, 'clash' | 'encoding'>;
      nextBase: string;
    };

/** Pure reconciliation decision. Never mutates state or performs I/O. */
export function decideReconcile(input: ReconcileInput): ReconcileDecision {
  const { doc, encoding, base, disk, truncated, prefer, exactBase, afterSave = false } = input;
  const docWritten = asWritten(doc, encoding);
  const candidates = uniqueBases(base, input.possibleBases);

  // 1. Already in sync: disk equals doc, an in-flight save text, or (outside post-save) base.
  if (disk === docWritten) return { action: 'advanceBase', nextBase: disk };
  if (candidates.some((c) => c !== base && c === disk)) return { action: 'advanceBase', nextBase: disk };
  if (!afterSave && base !== null && disk === base) return { action: 'noop' };

  // Post-save external revert back to pre-save base: treat saved candidates as the starting bases.
  const effectiveCandidates =
    afterSave && base !== null && disk === base ? candidates.filter((c) => c !== base) : candidates;

  // 2. Clean note (judged strictly by content vs the sole starting base, never VS Code's dirty flag): follow disk.
  if (effectiveCandidates.length === 1 && effectiveCandidates[0] === docWritten) {
    return { action: 'follow', nextText: disk, nextBase: disk, quietBackupOf: doc, truncated };
  }

  // 3. Dirty note with no base or truncated disk file: keep user's note intact and hand off.
  if (base === null || effectiveCandidates.length === 0) {
    return { action: 'handoff', reason: 'noBase', nextBase: disk };
  }
  if (truncated) return { action: 'handoff', reason: 'truncated', nextBase: disk };

  // 4. Uncertain-origin rule: merge against every candidate base; all must agree cleanly or hand off.
  const primaryBase = effectiveCandidates[0]!;
  const primary = checkedMerge(primaryBase, doc, disk, prefer, exactBase);
  if (primary.refused) return { action: 'handoff', reason: 'handoff', nextBase: disk };
  for (let i = 1; i < effectiveCandidates.length; i++) {
    const alt = checkedMerge(effectiveCandidates[i]!, doc, disk, prefer, exactBase);
    if (alt.refused || alt.result.text !== primary.result.text) {
      return { action: 'handoff', reason: 'handoff', nextBase: disk };
    }
    if (alt.result.conflicts.length > 0 && primary.result.conflicts.length === 0) {
      return { action: 'handoff', reason: 'handoff', nextBase: disk };
    }
  }

  // 5. Exit-gate invariant: never silently delete or split unsaved user typing outside clash spans.
  const merged = primary.result;
  const changes = merged.text === doc ? [] : diffChanges(doc, merged.text);
  const allowed =
    merged.conflicts.length > 0 && prefer === 'theirs' ? clashRegions(primaryBase, doc, disk, exactBase) : [];
  if (changes.length > 0 && takesUnsaved(primaryBase, doc, changes, allowed)) {
    return { action: 'handoff', reason: 'handoff', nextBase: disk };
  }

  const destructive = changes.some((c) => c.to > c.from);

  // 6. Clean merge (no conflicts).
  if (merged.conflicts.length === 0) {
    return destructive
      ? { action: 'merge', nextText: merged.text, nextBase: disk, quietBackupOf: doc }
      : { action: 'merge', nextText: merged.text, nextBase: disk };
  }

  // 7. Overlapping clash under keepMine: keep user's conflicting spans, merge disjoint edits.
  if (prefer === 'ours') {
    const passages = clashPassages(merged.text, merged.conflicts, disk);
    const restMerged = merged.text !== doc;
    return destructive
      ? { action: 'conflictKeepOurs', nextText: merged.text, nextBase: disk, passages, restMerged, quietBackupOf: doc }
      : { action: 'conflictKeepOurs', nextText: merged.text, nextBase: disk, passages, restMerged };
  }

  // 8. Overlapping clash under keepTheirs: take disk at clash spans, compute Undo target.
  const ifKept = checkedMerge(primaryBase, doc, disk, 'ours', exactBase);
  const undoTarget = ifKept.refused ? doc : ifKept.result.text;
  return { action: 'conflictKeepTheirs', nextText: merged.text, nextBase: disk, undoTarget };
}

/**
 * Single exit guard: true when `changes` against `ours` delete, replace, or insert inside a word
 * of any stretch that `ours` added beyond `file`, outside `allowed` clash regions.
 */
export function takesUnsaved(
  file: string,
  ours: string,
  changes: readonly TextChange[],
  allowed: readonly Run[] = [],
): boolean {
  if (changes.length === 0) return false;
  const unsaved = unsavedStretches(file, ours);
  if (unsaved.length === 0) return false;
  return changes.some(
    (c) =>
      !allowed.some(([a, b]) => a <= c.from && c.to <= b) &&
      unsaved.some(([a, b]) =>
        c.to > c.from ? c.from < b && a < c.to : a < c.from && c.from < b && !betweenWords(ours, c.from),
      ),
  );
}

function checkedMerge(
  base: string,
  ours: string,
  theirs: string,
  prefer: Prefer,
  exactBase: boolean,
): { result: MergeResult; refused: boolean } {
  const m = merge3Detailed(base, ours, theirs, { prefer, exactBase });
  if (m.text !== ours && m.text !== theirs && repeatsText(base, ours, theirs, m, exactBase)) {
    return { result: m, refused: true };
  }
  return { result: { text: m.text, conflicts: m.conflicts }, refused: false };
}

function unsavedStretches(file: string, ours: string): Run[] {
  const out: Run[] = [];
  let shift = 0;
  for (const c of diffChanges(file, ours, { fold: false })) {
    const from = c.from + shift;
    if (c.insert !== '') out.push([from, from + c.insert.length]);
    shift += c.insert.length - (c.to - c.from);
  }
  return out;
}

function betweenWords(text: string, at: number): boolean {
  return /\s/.test(text[at - 1] ?? ' ') || /\s/.test(text[at] ?? ' ');
}

function clashRegions(base: string, ours: string, theirs: string, exactBase: boolean): Run[] {
  const kept = merge3Detailed(base, ours, theirs, { prefer: 'ours', exactBase });
  const back = kept.text === ours ? [] : diffChanges(kept.text, ours);
  return kept.conflicts.map((c) => [carryOffset(c.from, back, 'start'), carryOffset(c.to, back, 'end')]);
}

function uniqueBases(base: string | null, extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (base !== null) {
    seen.add(base);
    out.push(base);
  }
  for (const t of extra) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
