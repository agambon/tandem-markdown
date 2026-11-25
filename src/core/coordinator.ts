// DocumentCoordinator: one per open markdown document. It owns the session (the log), the
// gate (the one lock) and the reconciler (outside edits), and the list of panels showing the
// document. The host creates it, forwards VS Code's events to it, and implements three
// ports; it makes no decision of its own. Everything this class does to the world goes
// through those ports. At a close with nothing unsaved it keeps the typing that reached it and
// not the document (typingAtClose.ts).
//
// How the host drives it: docs/ARCHITECTURE.md, "The document core" and "Closing".

import { alignedDiff } from './alignDiff';
import type { TextChange } from './diff';
import {
  type ApplyOutcome,
  type DocEvent,
  type DocumentChange,
  DocumentGate,
  type DocumentPort,
  type GateHolder,
} from './documentGate';
import { textCopyBytes } from './encoding';
import { toLf } from './eol';
import { isStamp, sameStamp } from './hash';
import { eventChangesToLf } from './positions';
import {
  type CheckMessage,
  FLUSH_WAIT_MS,
  type FlushedMessage,
  type HostToPanel,
  type InitMessage,
  type LogLevel,
  PROTOCOL,
  type PanelToHost,
  type PushMessage,
  type PushRejection,
  type Schedule,
  type UpdatesMessage,
} from './protocol';
import { Reconciler } from './reconcile/reconciler';
import {
  type BackupLabel,
  type CoreEditReason,
  type CoreNotice,
  type DiskPort,
  MERGE_TRIES,
  type SaveStepCount,
} from './reconcile/types';
import { type LogEntry, SyncSession, toWire } from './session';
import { copyAtClose, linesChanged, receivedPush, UnappliedPushes } from './typingAtClose';

export type { DocumentPort } from './documentGate';
export { documentEditRanges } from './documentGate';
export type { BackupLabel, CoreNotice, DiskPort };

/** The parts of an init the host decides. */
export type InitFields = Pick<InitMessage, 'mode' | 'settings' | 'viewState' | 'docInfo' | 'testMode'>;

export interface FaultRecord {
  panelId: string;
  kind: string;
  detail: string;
  panelText?: string;
  hostText: string;
}

/** The host's side of the world: panels, notices, the log, and memory across restarts. */
export interface UiPort {
  /**
   * Posts to the panel's webview. When the post turns out to have failed
   * (`webview.postMessage` resolved false), call `coordinator.panelPostFailed(panelId)`.
   */
  postToPanel(panelId: string, message: HostToPanel): void;
  /** Mode, settings, saved view state, document info and test mode for an init. */
  initFields(panelId: string, reason: 'open' | 'resync'): InitFields;
  notify(notice: CoreNotice): void;
  log(level: LogLevel, message: string, detail?: unknown): void;
  /** Both texts of a panel fault, for the log folder. */
  dumpFault(record: FaultRecord): void;
  /** The panel's bundle speaks another protocol: rebuild its webview. */
  reloadPanel(panelId: string): void;
  /** workspaceState: survives a restart. `undefined` forgets the key. */
  remember(key: string, value: unknown): void;
  recall(key: string): unknown;
}

/** A value of `tandemMarkdown.outsideChanges.whenBothChanged`: whose words stay where both sides changed them. */
export type WhenBothChanged = 'keepMine' | 'keepTheirs';

export interface CoordinatorOptions {
  document: DocumentPort;
  /** The file. Null for a document that is not a file (no reconciler runs). */
  disk: DiskPort | null;
  ui: UiPort;
  schedule: Schedule;
  /** The document's uri as a string: the key for remember and recall. */
  key: string;
  /** The file's name, for notices. */
  fileName: string;
  /** A read-only document: pushes are refused. */
  readOnly?: boolean;
  /** `tandemMarkdown.outsideChanges.whenBothChanged`, read each time it is needed. */
  whenBothChanged?: () => WhenBothChanged;
  /** Ids for panels' inits and notices. Every call must return a new one. */
  newId?: () => string;
  /** The reconciler's every decision, for tests and for working out a fault. */
  debug?: ((message: string) => void) | undefined;
  /** True while an outside change may be merged only by the save step (ReconcilerDeps.holdOutside). */
  holdOutside?: (() => boolean) | undefined;
  /** ReconcilerDeps.saveSteps. */
  saveSteps?: SaveStepCount | undefined;
}

/** A panel that closed is still heard for this long, so a push on its way is applied. */
const CLOSE_LINGER_MS = 2000;
/** After a failed post, the panel is resynced this long later if it has not reported in. */
const POST_RETRY_MS = 1000;

interface PanelRecord {
  id: string;
  clientId: string | null;
  /** Its init has been posted: it receives broadcasts. */
  live: boolean;
  /**
   * A post to it failed: it gets nothing more until it is resynced, which happens when it
   * next reports in or when the retry timer fires, whichever is first.
   */
  postFailed: boolean;
  postFailures: number;
  retryTimer: unknown;
  resyncQueued: boolean;
  closing: boolean;
  closeTimer: unknown;
}

interface FlushWait {
  waiting: Set<string>;
  clean: boolean;
  finish(clean: boolean): void;
}

export type HistoryResult = 'done' | 'notClean' | 'failed' | 'disposed';

/** What "Put my typing back" did (DocumentCoordinator.putBack). */
export type PutBackResult = 'done' | 'changed' | 'refused';

/** What DocumentCoordinator.inspect reads of a coordinator. */
export interface CoordinatorState {
  version: number;
  text: string;
  base: string | null;
  gateBusy: boolean;
  holding: boolean;
  pendings: number;
  /** The outside versions waiting to be merged, and the one left for VS Code to reload. */
  pendingTexts: string[];
  deferred: string | null;
  panels: { id: string; clientId: string | null; live: boolean }[];
  /** How many panels have a push that reached the core and not the document (UnappliedPushes). */
  unapplied: number;
  /** The document closed (and this coordinator with it). */
  closed: boolean;
}

export class DocumentCoordinator {
  private readonly session: SyncSession;
  private readonly gate: DocumentGate;
  private readonly reconciler: Reconciler | null;
  private readonly panels = new Map<string, PanelRecord>();
  private readonly flushes = new Map<string, FlushWait>();
  private history: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private documentIsClosed = false;
  private readonly newId: () => string;
  /** Each panel's last push not yet in the document: what a close with nothing unsaved would lose. */
  private readonly unapplied = new UnappliedPushes();
  /**
   * The document has been dirty since it last held its saved text: by a did-save, an undo or redo
   * back to it, or a revert (or since this coordinator began). Dirty since then, a close is one VS
   * Code asked about.
   */
  private dirtySinceSave: boolean;
  /** VS Code's dirty flag as its latest change event reported it. */
  private lastDirty: boolean;
  /** The reason of the last change to the document's text: an undo or redo that turns it clean takes it back to its saved text. */
  private lastChangeReason: DocumentChange['reason'];

  constructor(private readonly o: CoordinatorOptions) {
    const prefix = Math.floor(Math.random() * 0x7fffffff).toString(36);
    let n = 0;
    this.newId = o.newId ?? (() => `${prefix}.${++n}`);
    this.session = new SyncSession(toLf(o.document.getText()));
    this.dirtySinceSave = o.document.isDirty();
    this.lastDirty = this.dirtySinceSave;
    const encoding = () => o.document.encoding?.() ?? 'utf8';
    this.gate = new DocumentGate({
      document: o.document,
      sessionText: () => this.session.text,
      sessionDoc: () => this.session.doc,
      foreign: (e) => this.acceptForeign(e),
      extra: (landed) => this.acceptExtra(landed),
      mismatch: (lf) => this.reseed(lf),
      log: (level, message, detail) => o.ui.log(level, message, detail),
    });
    this.reconciler = o.disk
      ? new Reconciler({
          disk: o.disk,
          schedule: o.schedule,
          documentLf: () => toLf(o.document.getText()),
          isDirty: () => o.document.isDirty(),
          encoding,
          withGate: (holder, fn) => (holder ? fn(holder) : this.gate.run(fn)),
          applyMerge: (h, changes, expected, reason) => this.applyMerge(h, changes, expected, reason),
          prefer: () => (o.whenBothChanged?.() === 'keepTheirs' ? 'theirs' : 'ours'),
          fileName: o.fileName,
          key: o.key,
          notify: (n) => o.ui.notify(n),
          log: (level, message, detail) => o.ui.log(level, message, detail),
          remember: (k, v) => o.ui.remember(k, v),
          recall: (k) => o.ui.recall(k),
          newId: () => this.newId(),
          debug: o.debug,
          holdOutside: o.holdOutside,
          saveSteps: o.saveSteps,
        })
      : null;
  }

  // ---------------------------------------------------------------------------
  // Panels

  /** A webview for this document was created. Its init is posted when it sends `ready`. */
  panelAttached(panelId: string): void {
    if (this.disposed) return;
    const old = this.panels.get(panelId);
    if (old?.closeTimer) this.o.schedule.clearTimeout(old.closeTimer);
    if (old?.retryTimer) this.o.schedule.clearTimeout(old.retryTimer);
    this.panels.set(panelId, {
      id: panelId,
      clientId: null,
      live: false,
      postFailed: false,
      postFailures: 0,
      retryTimer: null,
      resyncQueued: false,
      closing: false,
      closeTimer: null,
    });
  }

  /** The webview was disposed. A push already on its way is still applied for CLOSE_LINGER_MS. */
  panelDetached(panelId: string): void {
    const p = this.panels.get(panelId);
    if (!p || p.closing) return;
    p.closing = true;
    p.live = false;
    if (p.retryTimer !== null) this.o.schedule.clearTimeout(p.retryTimer);
    p.retryTimer = null;
    for (const w of this.flushes.values()) {
      if (w.waiting.delete(panelId)) {
        w.clean = false;
        if (w.waiting.size === 0) w.finish(w.clean);
      }
    }
    p.closeTimer = this.o.schedule.setTimeout(() => {
      if (this.panels.get(panelId) === p) this.panels.delete(panelId);
    }, CLOSE_LINGER_MS);
  }

  /**
   * `webview.postMessage` resolved false for this panel. It gets nothing more until it is
   * resynced: when it next reports in, or after POST_RETRY_MS, doubled with each further
   * failure up to 16 times that, so a panel that sits idle is not left behind for good.
   */
  panelPostFailed(panelId: string): void {
    const p = this.panels.get(panelId);
    if (!p || p.closing || this.disposed) return;
    p.postFailed = true;
    p.postFailures++;
    if (p.retryTimer !== null) return;
    const delay = POST_RETRY_MS * 2 ** Math.min(p.postFailures - 1, 4);
    p.retryTimer = this.o.schedule.setTimeout(() => {
      p.retryTimer = null;
      if (p.postFailed && !p.closing && this.panels.get(p.id) === p) this.queueResync(p);
    }, delay);
  }

  /**
   * Every message from a panel. Returns true when the core handled it; false for messages
   * the host handles itself (viewState, focus, feature messages).
   */
  panelMessage(panelId: string, message: PanelToHost): boolean {
    const p = this.panels.get(panelId);
    if (!p || this.disposed || typeof message !== 'object' || message === null) return false;
    if (p.postFailed && !p.closing && message.type !== 'ready') this.queueResync(p);
    else if (!p.postFailed) p.postFailures = 0;
    switch (message.type) {
      case 'ready':
        if ((message as { protocol?: unknown }).protocol !== PROTOCOL) {
          this.o.ui.log(
            'warn',
            `A panel speaks protocol ${String((message as { protocol?: unknown }).protocol)}, not ${PROTOCOL}; reloading it`,
          );
          this.o.ui.reloadPanel(panelId);
          return true;
        }
        if (!p.closing) this.initPanel(p, 'open');
        return true;
      case 'push':
        this.handlePush(p, message as PushMessage);
        return true;
      case 'resyncRequest':
        this.o.ui.log('info', `A panel asked for a resync: ${String((message as { reason?: unknown }).reason)}`);
        this.queueResync(p);
        return true;
      case 'fault': {
        const m = message as { kind?: unknown; detail?: unknown; panelText?: unknown };
        const record: FaultRecord = {
          panelId,
          kind: String(m.kind),
          detail: String(m.detail),
          hostText: this.session.text,
        };
        if (typeof m.panelText === 'string') record.panelText = m.panelText;
        this.o.ui.log('error', `A panel reported a fault: ${record.kind}: ${record.detail}`);
        this.o.ui.dumpFault(record);
        return true;
      }
      case 'flushed':
        this.handleFlushed(panelId, message as FlushedMessage);
        return true;
      case 'check':
        this.handleCheck(p, message as CheckMessage);
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Document and disk events

  /** Every `workspace.onDidChangeTextDocument` for this document, including dirty-only events. */
  documentChanged(change: DocumentChange): void {
    if (this.disposed) return;
    // VS Code's dirty flag can turn in an event of its own, after the change that turned it.
    if (change.changes.length > 0) this.lastChangeReason = change.reason;
    const history = this.lastChangeReason === 'undo' || this.lastChangeReason === 'redo';
    // A change of the text that turns the document clean, other than an undo or a redo, is VS
    // Code's revert (Revert File, or "Don't Save" as it closes): the document holds its saved text
    // again. Typing still on its way then stays with its push: its panel shows it, and pushes it again.
    const reverted = change.changes.length > 0 && !change.dirty && this.lastDirty && !history;
    this.lastDirty = change.dirty;
    if (change.dirty) this.dirtySinceSave = true;
    else if (history || reverted) this.dirtySinceSave = false;
    if (change.changes.length === 0) {
      this.reconciler?.noteDirtyOnly(change.dirty);
      return;
    }
    const event: DocEvent = { lf: toLf(change.text), changes: change.changes, dirty: change.dirty };
    if (change.reason) event.reason = change.reason;
    // Record every text seen (for in-flight saves), then let the gate separate our own edits from foreign changes.
    this.reconciler?.noteTextSeen(event.lf);
    this.gate.documentChanged(event);
  }

  /** A file watcher event for the file (create, change or delete). */
  diskChanged(): void {
    if (!this.disposed) this.reconciler?.diskChanged();
  }

  windowFocused(): void {
    if (!this.disposed) this.reconciler?.windowFocused();
  }

  /** From `onWillSaveTextDocument`: `event.waitUntil(coordinator.willSave().then(() => []))`. Never rejects. */
  willSave(): Promise<void> {
    if (this.disposed || !this.reconciler) return Promise.resolve();
    return this.reconciler.willSave();
  }

  /** From `onDidSaveTextDocument`. */
  didSave(): void {
    if (this.disposed) return;
    this.dirtySinceSave = false;
    this.reconciler?.didSave();
  }

  // ---------------------------------------------------------------------------
  // Sequencing for host commands

  /**
   * Asks every panel (or the given ones) to send what it has not sent and waits for each to
   * answer. True only when every one reported nothing unconfirmed within FLUSH_WAIT_MS.
   */
  flushPanels(panelIds?: readonly string[]): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const targets = [...this.panels.values()].filter(
      (p) => p.live && !p.closing && (!panelIds || panelIds.includes(p.id)),
    );
    if (targets.length === 0) return Promise.resolve(true);
    const id = this.newId();
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = this.o.schedule.setTimeout(() => w.finish(false), FLUSH_WAIT_MS);
      const w: FlushWait = {
        waiting: new Set(targets.map((p) => p.id)),
        clean: true,
        finish: (clean) => {
          if (done) return;
          done = true;
          this.o.schedule.clearTimeout(timer);
          this.flushes.delete(id);
          resolve(clean);
        },
      };
      this.flushes.set(id, w);
      for (const p of targets) {
        if (p.postFailed) {
          w.clean = false;
          w.waiting.delete(p.id);
        } else {
          this.post(p, { type: 'flush', id });
        }
      }
      if (w.waiting.size === 0) w.finish(w.clean);
    });
  }

  /** Runs `fn` with the document to itself: no push, merge or save step runs meanwhile. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.gate.run(() => fn());
  }

  /**
   * Undo or redo from a panel. One at a time per document: every panel is
   * flushed; if any still has unsent text nothing happens ('notClean', and the host says
   * so); otherwise `run` (which executes VS Code's own undo or redo) runs under the gate.
   */
  undoRedo(kind: 'undo' | 'redo', run: () => PromiseLike<unknown>): Promise<HistoryResult> {
    const next = this.history.then(async (): Promise<HistoryResult> => {
      if (this.disposed) return 'disposed';
      if (!(await this.flushPanels())) return 'notClean';
      if (this.disposed) return 'disposed';
      try {
        await this.gate.run(async () => {
          await run();
        });
        return 'done';
      } catch (error) {
        this.o.ui.log('error', `${kind} failed`, error);
        return 'failed';
      }
    });
    this.history = next.catch(() => undefined);
    return next;
  }

  /** The "Use Change from Disk" action of a conflict notice. False once the document has closed. */
  useFileVersion(noticeId: string): Promise<boolean> {
    if (this.disposed || !this.reconciler) return Promise.resolve(false);
    return this.reconciler.actions.useFileVersion(noticeId);
  }

  /** The "Replace My View" action of a conflict notice. False once the document has closed. */
  replaceNote(noticeId: string): Promise<boolean> {
    if (this.disposed || !this.reconciler) return Promise.resolve(false);
    return this.reconciler.actions.replaceNote(noticeId);
  }

  /** The "Undo" action of an applied notice. False once the document has closed. */
  undoUsed(noticeId: string): Promise<boolean> {
    if (this.disposed || !this.reconciler) return Promise.resolve(false);
    return this.reconciler.actions.undoUsed(noticeId);
  }

  /** Whether the notice still offers its action. False once the document has closed. */
  offers(noticeId: string): boolean {
    return !this.disposed && !!this.reconciler && this.reconciler.actions.offers(noticeId);
  }

  /** Whether a press of the conflict choice found its backup unreadable. */
  unreadableVersion(noticeId: string): boolean {
    return !!this.reconciler && this.reconciler.actions.unreadableVersion(noticeId);
  }

  /** Notice was dismissed: its buttons can no longer be pressed. */
  noticeClosed(noticeId: string): void {
    this.reconciler?.actions.noticeClosed(noticeId);
  }

  /**
   * The document closed: call at once, from `onDidCloseTextDocument` when `document.isClosed`
   * (a language change is not a close). VS Code applies an edit sent to a closed document's
   * uri to a fresh copy of the file, with no version check, so from now on nothing is read,
   * merged, retried or applied, and no push is accepted. Outside versions not yet merged are
   * announced, except one the file still holds (dispose). The time a closing panel is still
   * heard (CLOSE_LINGER_MS) is for a document that stays open. Typing that reached the core and
   * not the document, at a close VS Code made without asking, is kept in a copy and told.
   */
  documentClosed(): void {
    if (this.disposed) return;
    this.documentIsClosed = true;
    const lost = this.typingNotIn();
    this.dispose();
    if (lost !== null) void this.keepTyping(lost.closedText, lost.copy);
  }

  /**
   * "Put my typing back", on the message about typing a closed note never had, for the note open
   * again: the document becomes `copy` while it holds exactly `closedText`, its text at the close,
   * with nothing unsaved, and the change is logged as the user's own edit, never as another
   * program's. 'done' once applied, or when the document holds `copy` already; 'changed' when it
   * holds neither; 'refused' when VS Code did not take the edit.
   */
  async putBack(closedText: string, copy: string): Promise<PutBackResult> {
    for (let attempt = 0; attempt < MERGE_TRIES; attempt++) {
      const r = await this.gate.run(async (h): Promise<PutBackResult | 'again'> => {
        if (this.disposed || this.o.readOnly) return 'refused';
        const doc = this.session.text;
        if (doc === copy) return 'done';
        if (doc !== closedText || this.o.document.isDirty()) return 'changed';
        const changes = alignedDiff(doc, copy);
        const out = await h.apply(changes, copy, () => {
          const entry = this.session.logOwn(changes);
          this.reconciler?.noteOwnEdit(this.session.text);
          this.broadcast([entry]);
        });
        return out.kind === 'applied' ? 'done' : out.kind === 'stale' ? 'again' : 'refused';
      });
      if (r !== 'again') return r;
    }
    return 'refused';
  }

  /**
   * Call when the coordinator is no longer wanted (the document closed or changed kind). Nothing is
   * posted or applied afterward.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gate.dispose();
    this.reconciler?.dispose(this.documentIsClosed);
    for (const p of this.panels.values()) {
      if (p.closeTimer) this.o.schedule.clearTimeout(p.closeTimer);
      if (p.retryTimer) this.o.schedule.clearTimeout(p.retryTimer);
    }
    this.panels.clear();
    for (const w of [...this.flushes.values()]) w.finish(false);
  }

  /** The log's version and the LF text at it: what every live panel is synced to, or catching up to. */
  synced(): { version: number; text: string } {
    return { version: this.session.version, text: this.session.text };
  }

  /** For tests and the log. */
  inspect(): CoordinatorState {
    const r = this.reconciler?.inspect();
    return {
      version: this.session.version,
      text: this.session.text,
      base: r ? r.base : null,
      gateBusy: this.gate.busy,
      holding: this.gate.holding,
      pendings: r ? r.pendings : 0,
      pendingTexts: r ? r.pendingTexts : [],
      deferred: r ? r.deferred : null,
      panels: [...this.panels.values()].map((p) => ({ id: p.id, clientId: p.clientId, live: p.live })),
      unapplied: this.unapplied.all().length,
      closed: this.documentIsClosed,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals

  private handlePush(p: PanelRecord, msg: PushMessage): void {
    const reject = (reason: PushRejection) => {
      // A post to this panel has failed: it lacks updates it was never sent, and a rejection
      // would leave it waiting for them. It is resynced instead, as when it next reports in.
      if (p.postFailed && !p.closing) {
        this.queueResync(p);
        return;
      }
      this.post(p, { type: 'pushRejected', reason, version: this.session.version, clientId: String(msg.clientId) });
    };
    if (p.clientId === null || msg.clientId !== p.clientId) {
      reject('superseded');
      return;
    }
    if (this.o.readOnly) {
      reject('invalid');
      return;
    }
    // Until it is in the document, or refused in a way that drops the panel's unconfirmed typing,
    // it is typing a close would lose. A push refused as stale or failed stays: its panel sends its
    // typing again, or is resynced, only after an answer the close may not leave time for.
    const received = receivedPush(msg);
    if (received !== null) this.unapplied.add(p.id, received);
    const dropped = () => {
      if (received !== null) this.unapplied.settle(p.id, received);
    };
    void this.gate
      .run(async (h) => {
        if (this.disposed) return;
        if (msg.clientId !== p.clientId || this.panels.get(p.id) !== p) {
          dropped();
          reject('superseded');
          return;
        }
        const prep = this.session.preparePush(msg.clientId, msg.baseVersion, msg.updates, msg.expect);
        if (!prep.ok) {
          if (prep.reason !== 'stale') {
            dropped();
            this.o.ui.log('warn', `A push was refused (${prep.reason}): ${prep.detail}`);
          }
          reject(prep.reason);
          return;
        }
        const commit = () => {
          dropped();
          const entries = this.session.commitPush(prep);
          this.reconciler?.noteOwnEdit(this.session.text);
          this.broadcast(entries);
        };
        if (prep.noop) {
          commit();
          return;
        }
        const out = await h.apply(prep.changes, prep.expectedText, commit);
        switch (out.kind) {
          case 'applied':
            return;
          case 'stale':
            reject('stale');
            return;
          case 'failed':
            this.o.ui.log('warn', 'VS Code refused a push for no reason the core can see');
            reject('failed');
            return;
          case 'mismatch':
            // Every panel has just been sent a new init; this push's id is no longer current.
            dropped();
            reject('superseded');
            return;
        }
      })
      .catch((e) => this.o.ui.log('error', 'A push failed', e));
  }

  private applyMerge(
    h: GateHolder,
    changes: TextChange[],
    expectedText: string,
    reason: CoreEditReason,
  ): Promise<ApplyOutcome> {
    return h.apply(changes, expectedText, () => {
      const entry = this.session.logOwn(changes, reason);
      this.reconciler?.noteOwnEdit(this.session.text);
      this.broadcast([entry]);
    });
  }

  private acceptForeign(e: DocEvent): void {
    const changes = eventChangesToLf(this.session.doc, e.changes);
    const r = this.session.acceptForeign(e.lf, changes, e.reason);
    if (r) {
      if (r.anomaly) this.o.ui.log('warn', `A change event was rebuilt from the texts: ${r.anomaly}`);
      this.broadcast([r.entry]);
    }
    this.reconciler?.noteForeignChange(e.lf, e.dirty, e.reason);
  }

  /** VS Code changed more than the edit it was given (it trims whitespace it added itself). */
  private acceptExtra(landed: DocEvent): void {
    const r = this.session.acceptForeign(landed.lf, null);
    if (!r) return;
    this.o.ui.log('info', 'VS Code added a change of its own to an edit; it was passed on as a separate update');
    this.broadcast([r.entry]);
  }

  /** The session and the document disagreed before an edit: start over from the document. */
  private reseed(documentLf: string): void {
    this.o.ui.log(
      'error',
      'The document and the session disagreed before an edit. Nothing was applied; every panel is reloaded.',
      {
        sessionLength: this.session.text.length,
        documentLength: documentLf.length,
      },
    );
    this.session.reseed(documentLf);
    for (const p of this.panels.values()) if (p.live && !p.closing) this.initPanel(p, 'resync');
  }

  private queueResync(p: PanelRecord): void {
    if (p.resyncQueued || p.closing) return;
    p.resyncQueued = true;
    void this.gate
      .run(async () => {
        p.resyncQueued = false;
        if (this.disposed || p.closing || this.panels.get(p.id) !== p) return;
        this.initPanel(p, 'resync');
      })
      .catch((e) => this.o.ui.log('error', 'A resync failed', e));
  }

  private initPanel(p: PanelRecord, reason: 'open' | 'resync'): void {
    // What the panel had not had confirmed is dropped by its new init, and the panel says so.
    this.unapplied.settle(p.id);
    p.clientId = this.newId();
    p.live = true;
    p.postFailed = false;
    const stamp = this.session.stamp();
    const init: InitMessage = {
      ...this.o.ui.initFields(p.id, reason),
      type: 'init',
      protocol: PROTOCOL,
      clientId: p.clientId,
      text: this.session.text,
      version: this.session.version,
      hash: stamp.hash,
      length: stamp.length,
      readOnly: !!this.o.readOnly,
      reason,
    };
    this.o.ui.postToPanel(p.id, init);
  }

  /**
   * A panel's stamp at its synced version, sent once it has been quiet for a while, so an update
   * it still lacks was lost or is crossing this message. It is sent what it lacks again, which
   * it applies or, already holding it, passes over (or it is resynced when the log no longer
   * reaches back that far). When its version is the log's and the stamps differ, it is sent
   * the document's stamp in an `updates` message with no updates: its own stamp check then
   * reports the fault and asks for the resync.
   */
  private handleCheck(p: PanelRecord, msg: CheckMessage): void {
    if (p.closing || p.postFailed || msg.clientId !== p.clientId || !isStamp(msg)) return;
    const version = this.session.version;
    if (Number.isInteger(msg.version) && msg.version < version) {
      const missed = this.session.updatesSince(msg.version);
      this.o.ui.log('info', `A panel at version ${msg.version} lacks updates up to ${version}; they are sent again`);
      if (!missed) {
        this.queueResync(p);
        return;
      }
      const stamp = this.session.stamp();
      this.post(p, {
        type: 'updates',
        fromVersion: msg.version,
        updates: toWire(missed),
        version,
        length: stamp.length,
        hash: stamp.hash,
      });
      return;
    }
    const stamp = this.session.stamp();
    if (msg.version !== version || sameStamp(stamp, msg)) return;
    this.o.ui.log('warn', `A panel's text differs from the document at version ${msg.version}; it is reloaded`);
    this.post(p, {
      type: 'updates',
      fromVersion: version,
      updates: [],
      version,
      length: stamp.length,
      hash: stamp.hash,
    });
  }

  /**
   * At a close VS Code made without asking (nothing unsaved, and not dirty since the note last held
   * its saved text, dirtySinceSave): the note's text as VS Code last had it, and that text with the
   * typing that reached the core and not the document (copyAtClose); null when no such typing
   * changes it.
   */
  private typingNotIn(): { closedText: string; copy: string } | null {
    if (this.dirtySinceSave || this.o.document.isDirty()) return null;
    const pushes = this.unapplied.all();
    if (pushes.length === 0) return null;
    const closedText = toLf(this.o.document.getText());
    const copy = copyAtClose(
      pushes,
      { doc: this.session.doc, since: (version) => this.session.updatesSince(version) },
      closedText,
    );
    return copy === null ? null : { closedText, copy };
  }

  /**
   * The copy of typing the closed note never had goes to a backup of the user's text, as every
   * such copy does (NoticeBook.backupBytes, which logs it), and is told; with no backup (no file,
   * or the write failed), the notice holds the copy, which the host opens in an unsaved tab.
   */
  private async keepTyping(closedText: string, copy: string): Promise<void> {
    this.o.ui.log('warn', `Typing that had not reached ${this.o.fileName} when VS Code closed it is kept in a copy`);
    const backupPath = this.reconciler ? await this.reconciler.actions.backupBytes(textCopyBytes(copy), 'yours') : null;
    this.o.ui.notify({
      kind: 'typingAtClose',
      id: this.newId(),
      backupPath,
      copy,
      closedText,
      linesChanged: linesChanged(closedText, copy),
    });
  }

  private handleFlushed(panelId: string, msg: FlushedMessage): void {
    const w = this.flushes.get(String(msg.id));
    if (!w || !w.waiting.delete(panelId)) return;
    if (msg.clean !== true) w.clean = false;
    if (w.waiting.size === 0) w.finish(w.clean);
  }

  private broadcast(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    const stamp = this.session.stamp();
    const msg: UpdatesMessage = {
      type: 'updates',
      fromVersion: this.session.version - entries.length,
      updates: toWire(entries),
      version: this.session.version,
      length: stamp.length,
      hash: stamp.hash,
    };
    for (const p of this.panels.values()) if (p.live && !p.closing && !p.postFailed) this.o.ui.postToPanel(p.id, msg);
  }

  private post(p: PanelRecord, message: HostToPanel): void {
    if (p.closing || this.disposed) return;
    this.o.ui.postToPanel(p.id, message);
  }
}
