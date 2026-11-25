// DocumentGate: the one lock on a document. Pushes, merge edits, the save step, undo and redo all
// run under it, one holder at a time, first come first served; nothing else edits the document.
// It also decides which change event is which: VS Code delivers an applied edit's change event
// before `applyEdit` resolves, so while a holder waits on `applyEdit` the events are held and
// decided when it resolves (applyFor). docs/ARCHITECTURE.md, "The gate".

import type { Text } from '@codemirror/state';
import type { TextChange } from './diff';
import { toLf } from './eol';
import { type EventChange, positionOf } from './positions';
import type { LogLevel } from './protocol';

/** VS Code's TextDocument, as the core sees it. Implemented by the host, faked in tests. */
export interface DocumentPort {
  /** The document's text as VS Code holds it (may contain "\r\n"). */
  getText(): string;
  isDirty(): boolean;
  /** VS Code's encoding id for the document (`document.encoding`), such as 'utf8'. Absent means 'utf8'. */
  encoding?(): string;
  /**
   * Applies the changes as one WorkspaceEdit and resolves as `workspace.applyEdit` does.
   * Must never reject (resolve false instead). See DocumentEdit for how to build the edit.
   */
  applyEdit(edit: DocumentEdit): Promise<boolean>;
}

export interface DocumentEdit {
  /** Ascending, non-overlapping, in LF offsets of `before`. Inserted text uses "\n". */
  changes: readonly TextChange[];
  /**
   * The LF text the offsets refer to, equal to toLf(getText()) at the call. Turn each offset into a
   * VS Code position with `positionOf(before, offset)`, never by counting in the CRLF text.
   */
  before: Text;
}

/** One VS Code change event, as the host passes it to the coordinator. */
export interface DocumentChange {
  /** `document.getText()` read inside the event handler (it may contain "\r\n"). */
  text: string;
  /** `event.contentChanges`, unchanged. Empty when only the dirty flag changed. */
  changes: readonly EventChange[];
  /**
   * From `event.reason`; 'outside' is the host's hint, carried on the update for the panels' mark
   * and acted on by nothing in the core.
   */
  reason?: 'undo' | 'redo' | 'outside';
  /** `document.isDirty` read inside the event handler. */
  dirty: boolean;
}

/** A content change event after the coordinator has read it. */
export interface DocEvent {
  lf: string;
  changes: readonly EventChange[];
  reason?: 'undo' | 'redo' | 'outside';
  dirty: boolean;
}

export type ApplyOutcome =
  | { kind: 'applied'; /** the LF text right after the edit landed */ landedText: string }
  | { kind: 'stale' }
  | { kind: 'failed' }
  | { kind: 'mismatch' };

export interface GateHolder {
  /**
   * Applies `changes` (LF offsets of the session text). The document's text is compared with the
   * session's first; on a difference nothing is applied (`mismatch`). `commit` runs once, when the
   * edit is known to have landed and before any later change is handed on.
   */
  apply(changes: readonly TextChange[], expectedText: string, commit: () => void): Promise<ApplyOutcome>;
}

export interface GateDeps {
  document: DocumentPort;
  /** The session's current LF text and its Text. */
  sessionText(): string;
  sessionDoc(): Text;
  /** A change event that is not the holder's edit. */
  foreign(event: DocEvent): void;
  /** The text after the holder's edit landed differs from what it expected; log the difference. */
  extra(landed: DocEvent): void;
  /** The document and the session disagree before an edit. */
  mismatch(documentLf: string): void;
  log(level: LogLevel, message: string, detail?: unknown): void;
}

export class DocumentGate {
  private waiting: (() => void)[] = [];
  private _busy = false;
  private held: DocEvent[] | null = null;
  private disposed = false;

  constructor(private readonly deps: GateDeps) {}

  /** True while some holder has the gate. */
  get busy(): boolean {
    return this._busy;
  }

  /** True while a holder waits on applyEdit (change events are being held). */
  get holding(): boolean {
    return this.held !== null;
  }

  /**
   * Runs `fn` once every earlier holder has finished. The gate is held until `fn` settles and so has
   * every apply made under its holder: an edit `fn` stopped waiting for is still on its way, and
   * the next holder's apply must not start before it lands or is refused.
   */
  run<T>(fn: (holder: GateHolder) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        const holder = new Holder(this);
        let work: Promise<T>;
        try {
          work = fn(holder);
        } catch (error) {
          work = Promise.reject(error);
        }
        // holder.settled() never rejects (it waits on allSettled), so the chain ends handled.
        void work
          .then(resolve, reject)
          .then(() => holder.settled())
          .finally(() => {
            holder.expired = true;
            this._busy = false;
            this.next();
          });
      });
      this.next();
    });
  }

  /** Every content change event of the document comes here. */
  documentChanged(event: DocEvent): void {
    if (this.disposed) return;
    if (this.held) this.held.push(event);
    else this.deps.foreign(event);
  }

  dispose(): void {
    this.disposed = true;
  }

  private next(): void {
    if (this._busy) return;
    const start = this.waiting.shift();
    if (!start) return;
    this._busy = true;
    start();
  }

  /**
   * The work of GateHolder.apply. When `applyEdit` resolves, the events held while it waited are
   * decided (docs/ARCHITECTURE.md, "The gate"): true with events, the first is the edit landing
   * (VS Code would have refused it after a foreign one), and any difference from the expected text
   * is logged as a small foreign update; true with none, it commits only if the document holds the
   * expected text; false, every held event is foreign.
   */
  async applyFor(
    holder: Holder,
    changes: readonly TextChange[],
    expectedText: string,
    commit: () => void,
  ): Promise<ApplyOutcome> {
    if (holder.expired) throw new Error('DocumentGate: apply called after the holder released the gate');
    if (this.held) throw new Error('DocumentGate: one apply at a time');
    if (this.disposed) return { kind: 'failed' };
    const before = this.deps.sessionDoc();
    const beforeText = this.deps.sessionText();
    const live = toLf(this.deps.document.getText());
    if (live !== beforeText) {
      this.deps.mismatch(live);
      return { kind: 'mismatch' };
    }
    // From here until applyEdit settles, every change event is held.
    this.held = [];
    let ok: boolean;
    try {
      ok = (await this.deps.document.applyEdit({ changes, before })) === true;
    } catch (error) {
      this.deps.log('error', 'applyEdit threw; treated as refused', error);
      ok = false;
    }
    const held = this.held;
    this.held = null;
    if (this.disposed) return { kind: 'failed' };

    if (ok && held.length > 0) {
      const landing = held[0]!;
      commit();
      if (landing.lf !== expectedText) this.deps.extra(landing);
      for (let i = 1; i < held.length; i++) this.deps.foreign(held[i]!);
      return { kind: 'applied', landedText: landing.lf };
    }
    if (ok) {
      const now = toLf(this.deps.document.getText());
      if (now === expectedText) {
        commit();
        return { kind: 'applied', landedText: now };
      }
      this.deps.log('warn', 'applyEdit reported success but no change arrived and the text is not the expected one');
      return { kind: 'failed' };
    }
    for (const e of held) this.deps.foreign(e);
    return held.length > 0 ? { kind: 'stale' } : { kind: 'failed' };
  }
}

class Holder implements GateHolder {
  expired = false;
  /** Applies made under this holder that have not settled. */
  private readonly inFlight = new Set<Promise<ApplyOutcome>>();
  constructor(private readonly gate: DocumentGate) {}
  apply(changes: readonly TextChange[], expectedText: string, commit: () => void): Promise<ApplyOutcome> {
    const applying = this.gate.applyFor(this, changes, expectedText, commit);
    this.inFlight.add(applying);
    const done = () => void this.inFlight.delete(applying);
    applying.then(done, done);
    return applying;
  }
  /** Resolves once every apply made under this holder has settled. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

/**
 * The edit as VS Code ranges: zero-based line and character in the document as it is now,
 * plus the inserted text with "\n" line breaks (VS Code turns them into the document's own).
 * The host applies them together, as one WorkspaceEdit.
 */
export function documentEditRanges(edit: DocumentEdit): {
  start: { line: number; character: number };
  end: { line: number; character: number };
  text: string;
}[] {
  return edit.changes.map((c) => ({
    start: positionOf(edit.before, c.from),
    end: positionOf(edit.before, c.to),
    text: c.insert,
  }));
}
