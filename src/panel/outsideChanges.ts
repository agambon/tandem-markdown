// The updates a transaction applies from the host, as the panel reads them: whether each came
// from outside, the host's log version it brings the panel to, and where a position in the host's
// text just after it now stands in the panel's text, which shows the host's text with its own
// unsent changes on top. An update counts as from outside when its reason is 'outside', 'merge'
// or 'press' (the user's press of a notice's button, which brings the file's text in or puts the
// user's back). The outside-change mark (render/outsideMark.ts) and what a screen reader is told
// (announce/) read them, and mark lines by `changedLineStarts`.

import type { ChangeSet, Text, Transaction } from '@codemirror/state';
import type { UpdateReason } from '../core/protocol';
import { syncedVersion, unsent } from './hostRanges';
import type { Span } from './render/lines';
import { receivedUpdates } from './sync';

/** Reasons that mean the text came from outside this panel and every text editor of the file. */
const OUTSIDE: ReadonlySet<UpdateReason> = new Set<UpdateReason>(['outside', 'merge', 'press']);

export interface ReceivedChange {
  /** The reason says another program made it, or the user's press of a notice's button. */
  outside: boolean;
  /** The user's press of a notice's button made it: the person knows of it (announce/). */
  pressed: boolean;
  /** The host's log version once this update is applied. */
  version: number;
  /** On the host's text just before it. */
  changes: ChangeSet;
  /** A position in the host's text just after this update, carried to the panel's text after the transaction. */
  toPanel(pos: number, assoc: -1 | 1): number;
}

/** Every update `tr` applies from the host, in the host's order, this panel's own confirmed ones included. */
export function receivedChanges(tr: Transaction): ReceivedChange[] {
  const updates = tr.annotation(receivedUpdates);
  if (!updates || updates.length === 0) return [];
  const start = syncedVersion(tr.startState);
  const local = unsent(tr.state);
  return updates.map((u, i) => ({
    outside: u.reason !== undefined && OUTSIDE.has(u.reason),
    pressed: u.reason === 'press',
    version: start + i + 1,
    changes: u.changes,
    toPanel(pos: number, assoc: -1 | 1): number {
      for (let j = i + 1; j < updates.length; j++) pos = updates[j]!.changes.mapPos(pos, assoc);
      for (const l of local) pos = l.changes.mapPos(pos, assoc);
      return pos;
    },
  }));
}

/** The text `u` put in, as ranges of the panel's text after the transaction; text later deleted is left out. */
export function insertedSpans(u: ReceivedChange): Span[] {
  const out: Span[] = [];
  u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB <= fromB) return;
    const from = u.toPanel(fromB, 1);
    const to = u.toPanel(toB, -1);
    if (to > from) out.push({ from, to });
  });
  return out;
}

/**
 * The start of every line holding text in `ranges` (offsets in `doc`), in order. Text that
 * begins by ending a line that has text (a new line inserted after it) leaves that line out, and
 * text that ends with a line break leaves out the line after it: neither line changed.
 */
export function changedLineStarts(doc: Text, ranges: readonly Span[]): number[] {
  const starts = new Set<number>();
  for (const r of ranges) {
    const from = Math.max(0, Math.min(r.from, doc.length));
    const to = Math.max(from, Math.min(r.to, doc.length));
    let first = doc.lineAt(from);
    if (to > from && from === first.to && first.from < first.to && first.number < doc.lines)
      first = doc.line(first.number + 1);
    let last = doc.lineAt(to);
    if (to > from && to === last.from && last.number > first.number) last = doc.line(last.number - 1);
    for (let n = first.number; n <= last.number; n++) starts.add(doc.line(n).from);
  }
  return [...starts].sort((a, b) => a - b);
}
