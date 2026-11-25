// SyncSession: the host's record of one document's LF text and the ordered log of updates
// that produced it. It is the authority of @codemirror/collab: panels are its clients, and
// each log entry is one update under the id of whoever made it.
//
// Nothing here touches the document. The gate decides when an entry may be logged; this
// class only keeps the text and the log consistent with each other.

import { ChangeSet, type Text } from '@codemirror/state';
import { alignToWords, alignedDiff } from './alignDiff';
import { type TextChange, diffChanges } from './diff';
import { errorMessage } from './errors';
import { type TextStamp, isStamp, sameStamp, stampOf } from './hash';
import { changeSetOf, decodeChangeSet, textOf } from './positions';
import type { UpdateReason, WireUpdate } from './protocol';

/** The client id of every update the host logs itself (outside edits, merges). No panel ever gets it. */
export const HOST_CLIENT_ID = '@host';

/** How many entries the log keeps. A panel further behind than this is resynced. */
export const LOG_LIMIT = 500;

export interface LogEntry {
  clientId: string;
  changes: ChangeSet;
  reason?: UpdateReason;
}

type PushRefusal = 'stale' | 'invalid' | 'diverged';

export type PreparedPush =
  | { ok: false; reason: PushRefusal; detail: string }
  | {
      ok: true;
      clientId: string;
      baseVersion: number;
      /** The client's updates, decoded, in order. */
      updates: ChangeSet[];
      /** The composed change as LF offsets of the session text: ascending, non-overlapping. */
      changes: TextChange[];
      /** The session text once the push is applied. */
      expectedText: string;
      expectedDoc: Text;
      /** True when the push leaves the text as it is (an insert and its delete). */
      noop: boolean;
    };

export interface ForeignResult {
  entry: LogEntry;
  /** Set when the event's changes did not reproduce the new text and a whole-text diff was used. */
  anomaly?: string;
}

export class SyncSession {
  private _doc: Text;
  private _text: string;
  private log: LogEntry[] = [];
  /** The log version of log[0]. */
  private logStart: number;
  private _version: number;

  constructor(initialLf: string, version = 0) {
    this._text = initialLf;
    this._doc = textOf(initialLf);
    this._version = version;
    this.logStart = version;
  }

  /** The LF text. */
  get text(): string {
    return this._text;
  }

  /** The LF text as a CodeMirror Text (its line table gives VS Code positions). */
  get doc(): Text {
    return this._doc;
  }

  /** The log version: how many updates have ever been logged. */
  get version(): number {
    return this._version;
  }

  stamp(): TextStamp {
    return stampOf(this._doc);
  }

  /**
   * A change that did not come through a push: typing in Source, undo, a reload, another
   * extension. Logs nothing when the text did not change (a line-ending flip looks like
   * that). Otherwise every event change is refined to the small changes it really holds,
   * so a reload VS Code reports as one replacement from the first changed line to the last
   * reaches the panels as the edits it contains and unsent typing between them stays put.
   * The session text always ends equal to `newLf`.
   */
  acceptForeign(newLf: string, changes: readonly TextChange[] | null, reason?: UpdateReason): ForeignResult | null {
    if (newLf === this._text) return null;
    let anomaly: string | undefined;
    let cs: ChangeSet | null = null;
    if (changes && changes.length > 0) {
      try {
        const specs: TextChange[] = [];
        for (const c of changes) {
          const replaced = this._text.slice(c.from, c.to);
          for (const r of diffChanges(replaced, c.insert)) {
            specs.push({ from: c.from + r.from, to: c.from + r.to, insert: r.insert });
          }
        }
        // VS Code lists an event's changes from the last to the first, each against the text
        // before the event; alignToWords needs them ascending.
        specs.sort((x, y) => x.from - y.from);
        cs = ChangeSet.of(alignToWords(this._text, specs), this._doc.length);
        if (cs.apply(this._doc).toString() !== newLf) {
          anomaly = 'the change event did not reproduce the document text';
          cs = null;
        }
      } catch (error) {
        anomaly = `the change event did not fit the session text (${errorMessage(error)})`;
        cs = null;
      }
    } else if (changes) {
      anomaly = 'a change event with no changes altered the text';
    }
    if (!cs) cs = changeSetOf(alignedDiff(this._text, newLf), this._doc.length);
    const entry: LogEntry = { clientId: HOST_CLIENT_ID, changes: cs };
    if (reason) entry.reason = reason;
    this.append(entry, newLf);
    return anomaly ? { entry, anomaly } : { entry };
  }

  /**
   * Logs a change the host made itself and has seen land (a merge of an outside version, or with
   * no reason the user's own typing put back). `changes` are LF offsets of the current session
   * text, as given to the document.
   */
  logOwn(changes: readonly TextChange[], reason?: UpdateReason): LogEntry {
    const cs = changeSetOf(changes, this._doc.length);
    const entry: LogEntry = { clientId: HOST_CLIENT_ID, changes: cs };
    if (reason) entry.reason = reason;
    this.append(entry, cs.apply(this._doc).toString());
    return entry;
  }

  /**
   * Checks a push before anything touches the document. Refused as `stale` unless it was
   * made on the current log version, as `invalid` if an update does not fit the text, and
   * as `diverged` unless the text it produces is the panel's own text (`expect`).
   */
  preparePush(clientId: string, baseVersion: number, updates: readonly unknown[], expect: TextStamp): PreparedPush {
    if (!Number.isInteger(baseVersion) || baseVersion > this._version || baseVersion < 0) {
      return {
        ok: false,
        reason: 'invalid',
        detail: `base version ${baseVersion} is not a version of this log (now ${this._version})`,
      };
    }
    if (baseVersion !== this._version) {
      return { ok: false, reason: 'stale', detail: `made on version ${baseVersion}, the log is at ${this._version}` };
    }
    if (!Array.isArray(updates) || updates.length === 0) {
      return { ok: false, reason: 'invalid', detail: 'a push with no updates' };
    }
    const decoded: ChangeSet[] = [];
    let length = this._doc.length;
    for (let i = 0; i < updates.length; i++) {
      const cs = decodeChangeSet(updates[i]);
      if (!cs) return { ok: false, reason: 'invalid', detail: `update ${i} is not a change set` };
      if (cs.length !== length) {
        return {
          ok: false,
          reason: 'invalid',
          detail: `update ${i} is for a text of length ${cs.length}, not ${length}`,
        };
      }
      length = cs.newLength;
      decoded.push(cs);
    }
    let composed = decoded[0]!;
    for (let i = 1; i < decoded.length; i++) composed = composed.compose(decoded[i]!);
    const expectedDoc = composed.apply(this._doc);
    const expectedStamp = stampOf(expectedDoc);
    if (!isStamp(expect) || !sameStamp(expectedStamp, expect)) {
      return {
        ok: false,
        reason: 'diverged',
        detail: "the push does not produce the panel's text from the host's text",
      };
    }
    const changes: TextChange[] = [];
    composed.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    // The string is built only when it is first read: a stamp check needs only the tree.
    let expectedText: string | null = null;
    return {
      ok: true,
      clientId,
      baseVersion,
      updates: decoded,
      changes,
      get expectedText() {
        return (expectedText ??= expectedDoc.toString());
      },
      expectedDoc,
      noop: sameStamp(expectedStamp, this.stamp()) && expectedDoc.eq(this._doc),
    };
  }

  /** Logs an accepted push: one entry per client update, in order, under the client's id. */
  commitPush(push: Extract<PreparedPush, { ok: true }>): LogEntry[] {
    if (push.baseVersion !== this._version) {
      throw new Error(
        `commitPush: the push was prepared on version ${push.baseVersion}, the log is at ${this._version}`,
      );
    }
    const entries = push.updates.map((changes) => ({ clientId: push.clientId, changes }));
    for (const e of entries) this.log.push(e);
    this._version += entries.length;
    this._doc = push.expectedDoc;
    this._text = push.expectedText;
    this.trim();
    return entries;
  }

  /** The entries after `version`, or null when the log no longer reaches back that far. */
  updatesSince(version: number): LogEntry[] | null {
    if (!Number.isInteger(version) || version < this.logStart || version > this._version) return null;
    return this.log.slice(version - this.logStart);
  }

  /** Starts over from the document's text: the log is emptied and every panel must be resynced. */
  reseed(newLf: string): void {
    this._text = newLf;
    this._doc = textOf(newLf);
    this.log = [];
    this.logStart = this._version;
  }

  private append(entry: LogEntry, newText: string): void {
    this.log.push(entry);
    this._version++;
    this._doc = entry.changes.apply(this._doc);
    this._text = newText;
    this.trim();
  }

  private trim(): void {
    const extra = this.log.length - LOG_LIMIT;
    if (extra > 0) {
      this.log.splice(0, extra);
      this.logStart += extra;
    }
  }
}

export function toWire(entries: readonly LogEntry[]): WireUpdate[] {
  return entries.map((e) => {
    const w: WireUpdate = { clientId: e.clientId, changes: e.changes.toJSON() };
    if (e.reason) w.reason = e.reason;
    return w;
  });
}
