// Typing that reached the core and not the document: each panel's last push not yet in the
// document and, once VS Code has closed the document with nothing unsaved, the note's last text
// with that typing in it, the copy the message about it keeps, and how many lines the typing
// changed. docs/ARCHITECTURE.md, "Closing".

import { rebaseUpdates, type Update } from '@codemirror/collab';
import type { ChangeSet, Text } from '@codemirror/state';
import { alignedDiff } from './alignDiff';
import { isStamp, sameStamp, stampOf, type TextStamp } from './hash';
import { changeSetOf, decodeChangeSet, textOf } from './positions';
import { diffStrings } from './sequenceDiff';
import { HOST_CLIENT_ID, type LogEntry } from './session';

/** Search work allowed for counting the lines typing changed, in diffSequences' units; past it the rest counts as changed. */
const LINES_WORK = 2_000_000;

/** A push that reached the core, as the panel sent it. */
export interface ReceivedPush {
  clientId: string;
  baseVersion: number;
  updates: readonly unknown[];
  /** The stamp of the panel's own text once the push is applied. */
  expect: TextStamp;
}

/**
 * Each panel's last push that has not gone into the document, in the order the pushes reached the
 * core. A push holds every update its panel has not had confirmed, so the panel's next push
 * replaces it.
 */
export class UnappliedPushes {
  private readonly byPanel = new Map<string, ReceivedPush>();

  /** Panel `panelId`'s push reached the core. */
  add(panelId: string, push: ReceivedPush): void {
    // Deleted first, so the panel's entry moves to the end of the order.
    this.byPanel.delete(panelId);
    this.byPanel.set(panelId, push);
  }

  /**
   * `push` went into the document, or was refused in a way that drops its panel's unconfirmed
   * typing; without `push`, whatever the panel's last push was (the panel was sent a new init).
   * A newer push of the panel stays.
   */
  settle(panelId: string, push?: ReceivedPush): void {
    if (push === undefined || this.byPanel.get(panelId) === push) this.byPanel.delete(panelId);
  }

  /** The pushes, in the order they reached the core. */
  all(): ReceivedPush[] {
    return [...this.byPanel.values()];
  }
}

/** A push message as it arrived, kept for the copy; null when its fields are not those of a push. */
export function receivedPush(msg: {
  clientId: unknown;
  baseVersion: unknown;
  updates: unknown;
  expect: unknown;
}): ReceivedPush | null {
  const { clientId, baseVersion, updates, expect } = msg;
  if (typeof clientId !== 'string' || !Number.isInteger(baseVersion) || !Array.isArray(updates) || !isStamp(expect))
    return null;
  return { clientId, baseVersion: baseVersion as number, updates, expect };
}

/** The log as the copy needs it: its text at its last version, and its entries after an earlier version. */
export interface LogAtClose {
  doc: Text;
  /** The entries after `version`, or null when the log no longer reaches back that far. */
  since(version: number): readonly LogEntry[] | null;
}

/**
 * The document's last text (`closedLf`) with `pushes` applied, in order, each moved first over
 * what the log took in after the version it was made on, then over the change from the log's text
 * to `closedLf` (VS Code's changes the gate still held), then over the pushes before it, as
 * @codemirror/collab rebases a client's updates over the authority's. A push the log no longer
 * reaches back to, one whose updates do not fit, and one made on the last version that does not
 * give its panel's own text are left out. Null when the result is `closedLf`.
 */
export function copyAtClose(pushes: readonly ReceivedPush[], log: LogAtClose, closedLf: string): string | null {
  const logText = log.doc.toString();
  let doc = logText === closedLf ? log.doc : textOf(closedLf);
  // What came after the log's last version, in order: VS Code's held changes, then the pushes applied here.
  const after: Update[] =
    logText === closedLf
      ? []
      : [{ clientID: HOST_CLIENT_ID, changes: changeSetOf(alignedDiff(logText, closedLf), log.doc.length) }];
  for (const push of pushes) {
    const logged = log.since(push.baseVersion);
    if (logged === null) continue;
    const over = [...logged.map((e) => ({ clientID: e.clientId, changes: e.changes })), ...after];
    const updates = fitted(push.updates, over.length > 0 ? over[0]!.changes.length : doc.length);
    if (updates === null) continue;
    const rebased = rebaseUpdates(
      updates.map((changes) => ({ clientID: push.clientId, changes })),
      over,
    );
    let next = doc;
    for (const u of rebased) next = u.changes.apply(next);
    if (over.length === 0 && !sameStamp(stampOf(next), push.expect)) continue;
    doc = next;
    after.push(...rebased);
  }
  const copy = doc.toString();
  return copy === closedLf ? null : copy;
}

/** The push's updates as change sets, each fitting the text the one before it leaves, the first a text of `length`; null when any does not. */
function fitted(updates: readonly unknown[], length: number): ChangeSet[] | null {
  const out: ChangeSet[] = [];
  for (const json of updates) {
    const cs = decodeChangeSet(json);
    if (cs === null || cs.length !== length) return null;
    out.push(cs);
    length = cs.newLength;
  }
  return out.length > 0 ? out : null;
}

/**
 * How many lines `after` changes of `before` (LF texts), as a comparison of the two marks them: in
 * each run of changed lines, the larger of the two sides' counts. At least 1 when they differ.
 */
export function linesChanged(before: string, after: string): number {
  if (before === after) return 0;
  const hunks = diffStrings(before.split('\n'), after.split('\n'), { left: LINES_WORK });
  return hunks.reduce((n, h) => n + Math.max(h.a2 - h.a1, h.b2 - h.b1), 0);
}
