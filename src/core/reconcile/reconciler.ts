// Reconciler: keeps one open document in sync with its file on disk through a single serialized
// lock and one compact state object. Merge decisions live in `decide.ts`, disk I/O in `disk.ts`,
// and notice resolution actions in `actions.ts`.

import { alignedDiff } from '../alignDiff';
import type { GateHolder } from '../documentGate';
import { textForShowing } from '../encoding';
import { NoticeActions } from './actions';
import { type ReconcileDecision, decideReconcile } from './decide';
import { type SettledRead, asWritten, bytesKey, readSettled, sameBytes, sameStat, stampKey } from './disk';
import { type CoreNotice, type FileStat, MERGE_TRIES, type ReconcilerDeps, type SaveStepCount } from './types';

const WATCHER_DEBOUNCE_MS = 150;
const CLEAN_RELOAD_GRACE_MS = 350;
const CLEAN_EVENT_WAIT_MS = 120;
const RETRY_MS = 1000;
const WILL_SAVE_LIMIT_MS = 800;
const VSCODE_STEP_TIMEOUT_MS = 1500;
const VSCODE_STEP_ERRORS = 3;
const SAVE_WINDOW_EXPIRE_MS = 5000;
const MAX_SAVE_CANDIDATES = 8;
const MAX_CLEAN_CANDIDATES = 4;

const sessionSaveSteps: SaveStepCount = { counted: 0, warned: false };

interface PendingDiskVersion {
  base: string | null;
  diskText: string;
  diskBytes: Uint8Array;
  backupPath: string | null;
  truncated: boolean;
  savedOver: boolean;
}

interface CheckRequest {
  forceRead: boolean;
  recheck: boolean;
  afterSave: boolean;
}

interface ReconcileOpts {
  inSave: boolean;
  recheck: boolean;
  afterSave: boolean;
  savedOver: boolean;
  existingBackup: string | null;
  explicitBase?: string | null;
}

type ConflictNotice = Extract<CoreNotice, { kind: 'conflict' }>;
type ConflictFields = Omit<ConflictNotice, 'kind' | 'id' | 'restMerged' | 'savedOver' | 'passages' | 'choice'> &
  Partial<Pick<ConflictNotice, 'id' | 'restMerged' | 'savedOver' | 'passages' | 'choice'>>;

export class Reconciler {
  readonly actions: NoticeActions;
  private readonly steps: SaveStepCount;
  private readonly s: {
    base: string | null;
    baseStat: FileStat | null;
    openingText: string | null;
    baselineBytes: Uint8Array | null;
    rememberedStamp: string | null;
    lastRemembered: string | null;
    jumps: number;
    baseJumps: number;
    pendingCleanChange: { text: string; at: number } | null;
    /** Unconfirmed clean states superseded by a later edit before a disk check confirmed them. */
    recentCleanCandidates: string[];
    inFlightSave: { startedAt: number; willSaveRan: boolean; candidates: string[] } | null;
    pending: PendingDiskVersion | null;
    deferredText: string | null;
    readFailing: boolean;
    announcedBadBytes: Set<string>;
  };
  private lock: Promise<void> = Promise.resolve();
  private queued: CheckRequest | null = null;
  private preSaveWaiting = 0;
  private watcherTimer: unknown = null;
  private recheckTimer: unknown = null;
  private retryTimer: unknown = null;
  private readonly sleepTimers = new Set<{ handle: unknown; finish(ok: boolean): void }>();
  private disposed = false;

  constructor(private readonly d: ReconcilerDeps) {
    this.steps = d.saveSteps ?? sessionSaveSteps;
    this.actions = new NoticeActions(d, () => this.disposed);
    const dirty = d.isDirty();
    const recalled = dirty ? d.recall(rememberKey(d.key)) : undefined;
    const remembered = typeof recalled === 'string' ? recalled : null;
    this.s = {
      base: null,
      baseStat: null,
      openingText: dirty ? null : asWritten(d.documentLf(), d.encoding()),
      baselineBytes: null,
      rememberedStamp: remembered,
      lastRemembered: remembered,
      jumps: 0,
      baseJumps: 0,
      pendingCleanChange: null,
      recentCleanCandidates: [],
      inFlightSave: null,
      pending: null,
      deferredText: null,
      readFailing: false,
      announcedBadBytes: new Set(),
    };
    this.requestCheck({ forceRead: true });
  }

  diskChanged(): void {
    if (this.disposed) return;
    if (this.watcherTimer !== null) this.d.schedule.clearTimeout(this.watcherTimer);
    this.watcherTimer = this.d.schedule.setTimeout(() => {
      this.watcherTimer = null;
      this.requestCheck({});
    }, WATCHER_DEBOUNCE_MS);
  }

  windowFocused(): void {
    if (!this.disposed) this.requestCheck({});
  }

  noteTextSeen(lf: string): void {
    if (this.disposed) return;
    const written = asWritten(lf, this.d.encoding());
    if (this.s.pendingCleanChange !== null && this.s.pendingCleanChange.text !== written) {
      this.retirePendingClean(written);
    }
    if (this.s.inFlightSave !== null) this.pushSaveCandidate(written);
    this.syncRememberedBase(written);
  }

  noteOwnEdit(lf: string): void {
    if (this.disposed) return;
    const written = asWritten(lf, this.d.encoding());
    this.retirePendingClean(written);
    this.syncRememberedBase(written);
  }

  noteForeignChange(lf: string, dirty: boolean, reason: 'undo' | 'redo' | 'outside' | undefined): void {
    if (this.disposed) return;
    const written = asWritten(lf, this.d.encoding());
    if (this.s.pendingCleanChange !== null && this.s.pendingCleanChange.text !== written) {
      this.retirePendingClean(written);
    }
    if (reason === 'undo' || reason === 'redo') {
      this.s.jumps++;
      this.s.pendingCleanChange = null;
    } else if (!dirty && written !== this.effectiveBase()) {
      this.s.pendingCleanChange = { text: written, at: this.d.schedule.now() };
      this.scheduleCheckTimer('recheck', CLEAN_EVENT_WAIT_MS);
    } else if (dirty) {
      this.retirePendingClean(written);
    }
    this.syncRememberedBase(written);
  }

  noteDirtyOnly(dirty: boolean): void {
    if (this.disposed) return;
    const written = asWritten(this.d.documentLf(), this.d.encoding());
    if (dirty) this.retirePendingClean(written);
    else if (this.s.pendingCleanChange !== null) this.requestCheck({ forceRead: true });
    this.syncRememberedBase(written);
  }

  async willSave(): Promise<void> {
    if (this.disposed) return;
    const startedAt = this.d.schedule.now();
    this.preSaveWaiting++;
    this.cancelSleeps();
    let timedOut = false;
    let deadlineHandle: unknown = null;
    const deadline = new Promise<void>((resolve) => {
      deadlineHandle = this.d.schedule.setTimeout(() => {
        timedOut = true;
        this.cancelSleeps();
        resolve();
      }, WILL_SAVE_LIMIT_MS);
    });
    const work = this.runLocked(async () => {
      this.preSaveWaiting = Math.max(0, this.preSaveWaiting - 1);
      if (this.disposed || timedOut) return;
      try {
        await this.checkDisk({ forceRead: true, recheck: true, afterSave: false }, () => timedOut, true);
      } catch (error) {
        this.d.log('error', `Pre-save check failed for ${this.d.fileName}`, error);
      }
    });
    await Promise.race([work, deadline]);
    if (deadlineHandle !== null) this.d.schedule.clearTimeout(deadlineHandle);
    if (!this.disposed) {
      this.s.inFlightSave = {
        startedAt,
        willSaveRan: true,
        candidates: [asWritten(this.d.documentLf(), this.d.encoding())],
      };
    }
    if (!this.disposed && this.d.schedule.now() - startedAt >= VSCODE_STEP_TIMEOUT_MS) {
      this.steps.counted++;
      if (this.steps.counted > VSCODE_STEP_ERRORS && !this.steps.warned) {
        this.steps.warned = true;
        this.d.notify({ kind: 'saveCheckOff', id: this.d.newId() });
      }
    }
  }

  didSave(): void {
    if (this.disposed) return;
    const docWritten = asWritten(this.d.documentLf(), this.d.encoding());
    if (this.s.inFlightSave === null) {
      this.s.inFlightSave = { startedAt: this.d.schedule.now(), willSaveRan: false, candidates: [docWritten] };
    } else {
      this.pushSaveCandidate(docWritten);
    }
    this.s.pendingCleanChange = null;
    this.syncRememberedBase(docWritten);
    this.requestCheck({ forceRead: true, afterSave: true });
  }

  dispose(closedForGood = false): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of [this.watcherTimer, this.recheckTimer, this.retryTimer]) {
      if (h !== null) this.d.schedule.clearTimeout(h);
    }
    this.watcherTimer = this.recheckTimer = this.retryTimer = null;
    this.cancelSleeps();
    this.actions.clear();
    if (closedForGood && this.s.pending !== null) {
      const p = this.s.pending;
      this.s.pending = null;
      this.d.notify({ kind: 'closedWithPending', id: this.d.newId(), backupPath: p.backupPath, diskText: p.diskText });
    }
  }

  inspect(): { base: string | null; pendings: number; pendingTexts: string[]; deferred: string | null } {
    return {
      base: this.s.base,
      pendings: this.s.pending ? 1 : 0,
      pendingTexts: this.s.pending ? [this.s.pending.diskText] : [],
      deferred: this.s.deferredText,
    };
  }

  private requestCheck(req: Partial<CheckRequest>): void {
    if (this.disposed) return;
    const next = { forceRead: !!req.forceRead, recheck: !!req.recheck, afterSave: !!req.afterSave };
    if (this.queued !== null) {
      this.queued.forceRead ||= next.forceRead;
      this.queued.recheck ||= next.recheck;
      this.queued.afterSave ||= next.afterSave;
      return;
    }
    this.queued = next;
    void this.runLocked(async () => {
      const run = this.queued;
      this.queued = null;
      if (this.disposed || run === null || this.preSaveWaiting > 0) return;
      try {
        await this.checkDisk(run, () => this.disposed || this.preSaveWaiting > 0, false);
      } catch (error) {
        this.d.log('error', `Outside-change check failed for ${this.d.fileName}`, error);
      }
    });
  }

  private runLocked(fn: () => Promise<void>): Promise<void> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async checkDisk(req: CheckRequest, stopped: () => boolean, inSave: boolean): Promise<void> {
    if (stopped() || this.disposed) return;
    const s = this.s;
    if (
      !req.afterSave &&
      !inSave &&
      s.inFlightSave &&
      this.d.schedule.now() - s.inFlightSave.startedAt > SAVE_WINDOW_EXPIRE_MS
    ) {
      s.inFlightSave = null;
    }
    if (
      !req.forceRead &&
      !req.recheck &&
      !req.afterSave &&
      !inSave &&
      !s.pending &&
      !s.pendingCleanChange &&
      !s.inFlightSave &&
      s.baseStat !== null &&
      (s.base !== null || s.baselineBytes !== null)
    ) {
      const stat = await this.d.disk.stat();
      if (stopped() || this.disposed) return;
      if (stat !== null && s.baseStat !== null && sameStat(stat, s.baseStat)) return;
    }
    const read = await readSettled(this.d.disk, this.d.schedule, {
      encoding: this.d.encoding(),
      base: this.effectiveBase(),
      inSave,
      isKnown: (text) => this.isKnownText(text),
      sleep: (ms) => this.sleep(ms),
      stopped: () => stopped() || this.disposed,
    });
    if (stopped() || this.disposed || read.kind === 'aborted') return;
    await this.handleRead(read, req, inSave);
  }

  private async handleRead(
    read: Exclude<SettledRead, { kind: 'aborted' }>,
    req: CheckRequest,
    inSave: boolean,
  ): Promise<void> {
    const s = this.s;
    if (read.kind === 'failed') {
      if (!s.readFailing) {
        s.readFailing = true;
        this.d.notify({ kind: 'readStatus', id: this.d.newId(), ok: false, error: read.error });
      }
      if (!inSave) this.scheduleCheckTimer('retry', RETRY_MS);
      return;
    }
    if (s.readFailing && read.kind !== 'unstable') {
      s.readFailing = false;
      this.d.notify({ kind: 'readStatus', id: this.d.newId(), ok: true });
    }
    if (read.kind === 'missing') {
      if (req.afterSave) s.inFlightSave = null;
      return;
    }
    if (read.kind === 'unstable') {
      if (inSave && read.bytes !== null) await this.actions.backupBytes(read.bytes, 'beforeSave');
      else if (!inSave) this.scheduleCheckTimer('retry', RETRY_MS);
      return;
    }
    if (read.kind === 'bytesOnly' || read.kind === 'undecodable') {
      await this.handleUnreadableBytes(read, inSave, req.afterSave);
      if (req.afterSave) s.inFlightSave = null;
      return;
    }

    const { text: diskText, bytes, stat, truncated } = read;
    if (s.base === null && s.rememberedStamp !== null && stampKey(diskText, this.d.encoding()) === s.rememberedStamp) {
      this.setBase(diskText, stat);
      return;
    }
    if (s.pendingCleanChange !== null && s.pendingCleanChange.text === diskText) {
      const priorBase = this.effectiveBase();
      s.jumps++;
      this.setBase(diskText, stat);
      const quietPath =
        priorBase !== null && priorBase !== diskText ? await this.actions.backupText(priorBase, 'beforeRemoval') : null;
      if (truncated && priorBase !== null) {
        this.d.notify({
          kind: 'truncatedFollow',
          id: this.d.newId(),
          backupPath: quietPath,
          previousText: priorBase,
          diskText,
        });
      }
      if (req.afterSave) s.inFlightSave = null;
      return;
    }
    if (
      !inSave &&
      s.pendingCleanChange !== null &&
      diskText === this.effectiveBase() &&
      this.d.schedule.now() - s.pendingCleanChange.at < CLEAN_EVENT_WAIT_MS
    ) {
      this.scheduleCheckTimer('recheck', CLEAN_EVENT_WAIT_MS);
      return;
    }

    let existingBackup: string | null = null;
    let savedOver = inSave;
    let recheck = req.recheck;
    if (s.pending !== null) {
      const p = s.pending;
      s.pending = null;
      if (p.diskText !== diskText) {
        await this.reconcileVersion(p.diskText, p.diskBytes, null, p.truncated, {
          inSave,
          recheck: true,
          afterSave: false,
          savedOver: true,
          existingBackup: p.backupPath,
          explicitBase: p.base,
        });
        if (this.disposed) return;
      } else {
        existingBackup = p.backupPath;
        savedOver = p.savedOver;
        recheck = true;
      }
    }

    await this.reconcileVersion(diskText, bytes, stat, truncated, {
      inSave,
      recheck,
      afterSave: req.afterSave,
      savedOver,
      existingBackup,
    });
    if (req.afterSave) s.inFlightSave = null;
  }

  private async reconcileVersion(
    diskText: string,
    diskBytes: Uint8Array,
    stat: FileStat | null,
    truncated: boolean,
    opts: ReconcileOpts,
  ): Promise<void> {
    const encoding = this.d.encoding();
    const base = opts.explicitBase !== undefined ? opts.explicitBase : this.effectiveBase();
    const possibleBases = this.possibleBasesFor(base);
    const currentWritten = asWritten(this.d.documentLf(), encoding);

    if (
      !opts.inSave &&
      !opts.recheck &&
      !opts.afterSave &&
      !this.d.isDirty() &&
      base !== null &&
      currentWritten === base &&
      diskText !== base &&
      !truncated
    ) {
      this.s.deferredText = diskText;
      this.scheduleCheckTimer('recheck', CLEAN_RELOAD_GRACE_MS);
      return;
    }
    this.s.deferredText = null;

    let backupPath = opts.existingBackup;
    if (opts.inSave && backupPath === null && diskText !== base && diskText !== currentWritten) {
      backupPath = await this.actions.backupBytes(diskBytes, truncated ? 'cut' : 'beforeSave');
      if (this.disposed) return;
    }

    const stash = async (needBackup: boolean) => {
      if (needBackup && backupPath === null) backupPath = await this.actions.backupBytes(diskBytes, 'notMerged');
      this.s.pending = { base, diskText, diskBytes, backupPath, truncated, savedOver: opts.savedOver };
      if (!opts.inSave) this.scheduleCheckTimer('retry', RETRY_MS);
    };

    for (let attempt = 0; attempt < MERGE_TRIES; attempt++) {
      if (this.disposed) return;
      if (!opts.inSave && this.d.holdOutside?.()) return stash(false);

      type GateStep =
        { status: 'again' } | { status: 'stop' } | { status: 'done'; decision: ReconcileDecision; doc: string };
      const applied = await this.d.withGate<GateStep>(null, async (h: GateHolder): Promise<GateStep> => {
        if (this.disposed) return { status: 'stop' };
        const doc = this.d.documentLf();
        const revertedToBase =
          opts.afterSave &&
          base !== null &&
          diskText === base &&
          this.s.inFlightSave !== null &&
          this.s.inFlightSave.willSaveRan &&
          !this.s.inFlightSave.candidates.includes(base);
        const decision = decideReconcile({
          doc,
          encoding,
          base,
          possibleBases,
          disk: diskText,
          truncated,
          prefer: this.d.prefer(),
          exactBase: this.s.base !== null && this.s.jumps === this.s.baseJumps,
          afterSave: revertedToBase,
        });
        if (decision.action === 'noop') {
          if (this.s.base === null && base !== null) this.setBase(base, stat);
          else if (stat !== null) this.s.baseStat = stat;
          return { status: 'done', decision, doc };
        }
        if (decision.action === 'advanceBase' || decision.action === 'handoff' || decision.nextText === doc) {
          this.setBase(decision.nextBase, stat);
          return { status: 'done', decision, doc };
        }
        const out = await this.d.applyMerge(h, alignedDiff(doc, decision.nextText), decision.nextText, 'merge');
        if (out.kind === 'applied') {
          this.setBase(decision.nextBase, stat);
          return { status: 'done', decision, doc };
        }
        return { status: out.kind === 'stale' ? 'again' : 'stop' };
      });
      if (applied.status === 'again') continue;
      if (applied.status === 'stop') return stash(true);
      await this.finishDecision(applied.decision, applied.doc, base, diskText, diskBytes, backupPath, opts.savedOver);
      return;
    }
    await stash(true);
  }

  private async finishDecision(
    decision: ReconcileDecision,
    docBefore: string,
    base: string | null,
    diskText: string,
    diskBytes: Uint8Array,
    existingBackup: string | null,
    savedOver: boolean,
  ): Promise<void> {
    if (decision.action === 'noop' || decision.action === 'advanceBase') {
      await this.actions.deleteBackup(existingBackup);
      return;
    }
    if (decision.action === 'follow') {
      const quietPath = await this.actions.backupText(decision.quietBackupOf, 'beforeRemoval');
      await this.actions.deleteBackup(existingBackup);
      if (decision.truncated) {
        this.d.notify({
          kind: 'truncatedFollow',
          id: this.d.newId(),
          backupPath: quietPath,
          previousText: decision.quietBackupOf,
          diskText,
        });
      }
      return;
    }
    if (decision.action === 'merge') {
      if (decision.quietBackupOf !== undefined) await this.actions.backupText(decision.quietBackupOf, 'beforeRemoval');
      await this.actions.deleteBackup(existingBackup);
      return;
    }
    if (decision.action === 'conflictKeepTheirs') {
      const diskBackup = existingBackup ?? (await this.actions.backupBytes(diskBytes, 'conflict'));
      const userBackup = await this.actions.backupText(docBefore, 'yours');
      const id = this.d.newId();
      this.actions.recordUndo(id, decision.nextText, decision.undoTarget, diskBackup);
      this.d.notify({
        kind: 'applied',
        id,
        how: 'setting',
        backupPath: userBackup,
        previousText: userBackup === null ? docBefore : null,
        diskBackupPath: diskBackup,
        canUndo: true,
      });
      return;
    }
    if (decision.action === 'conflictKeepOurs') {
      if (decision.quietBackupOf !== undefined) await this.actions.backupText(decision.quietBackupOf, 'beforeRemoval');
      const backupPath = existingBackup ?? (await this.actions.backupBytes(diskBytes, 'conflict'));
      const id = this.d.newId();
      this.actions.recordChoice(id, 'use', base, backupPath, diskText, decision.nextText);
      this.notifyConflict({
        id,
        reason: 'clash',
        restMerged: decision.restMerged,
        savedOver,
        backupPath,
        diskText,
        baseText: base,
        noteText: decision.nextText,
        passages: decision.passages,
        choice: 'use',
      });
      return;
    }
    const label = decision.reason === 'noBase' ? 'unknownBase' : decision.reason === 'truncated' ? 'cut' : 'conflict';
    const backupPath = existingBackup ?? (await this.actions.backupBytes(diskBytes, label));
    const id = this.d.newId();
    this.actions.recordChoice(id, 'replace', base, backupPath, diskText);
    this.notifyConflict({
      id,
      reason: decision.reason,
      savedOver,
      backupPath,
      diskText,
      baseText: base,
      noteText: docBefore,
      choice: 'replace',
    });
  }

  private async handleUnreadableBytes(
    read: Extract<SettledRead, { kind: 'bytesOnly' | 'undecodable' }>,
    inSave: boolean,
    afterSave: boolean,
  ): Promise<void> {
    if (read.kind === 'bytesOnly') {
      const ownSave = !inSave && (afterSave || this.s.inFlightSave !== null);
      const same = ownSave || this.s.baselineBytes === null || sameBytes(read.bytes, this.s.baselineBytes);
      this.s.baselineBytes = read.bytes;
      this.s.baseStat = read.stat;
      if (same) return;
    } else {
      const key = bytesKey(read.bytes);
      if (this.s.announcedBadBytes.has(key)) return;
      this.s.announcedBadBytes.add(key);
      this.s.baseStat = read.stat;
    }
    const cut = read.kind === 'undecodable' && read.cutMidChar;
    const label = cut ? 'cut' : read.kind === 'bytesOnly' && inSave ? 'beforeSave' : 'undecodable';
    const backupPath = await this.actions.backupBytes(read.bytes, label);
    this.notifyConflict({
      reason: cut ? 'truncated' : 'encoding',
      savedOver: inSave,
      backupPath,
      diskText: textForShowing(read.bytes, this.d.encoding()),
      baseText: read.kind === 'bytesOnly' ? null : this.effectiveBase(),
      noteText: this.d.documentLf(),
    });
  }

  private notifyConflict(f: ConflictFields): void {
    this.d.notify({
      kind: 'conflict',
      id: f.id ?? this.d.newId(),
      reason: f.reason,
      restMerged: f.restMerged ?? false,
      savedOver: f.savedOver ?? false,
      backupPath: f.backupPath,
      diskText: f.diskText,
      baseText: f.baseText,
      noteText: f.noteText,
      passages: f.passages ?? [],
      choice: f.choice ?? 'none',
    });
  }

  private effectiveBase(): string | null {
    return this.s.base ?? this.s.openingText;
  }

  private possibleBasesFor(base: string | null): string[] {
    return [
      ...(base !== null ? [base] : []),
      ...(this.s.inFlightSave?.candidates ?? []),
      ...this.s.recentCleanCandidates,
      ...(this.s.pendingCleanChange ? [this.s.pendingCleanChange.text] : []),
    ];
  }

  private isKnownText(text: string): boolean {
    return (
      text === this.s.base ||
      text === this.s.openingText ||
      this.s.recentCleanCandidates.includes(text) ||
      text === asWritten(this.d.documentLf(), this.d.encoding()) ||
      this.s.inFlightSave?.candidates.includes(text) === true
    );
  }

  private retirePendingClean(currentWritten: string): void {
    const pending = this.s.pendingCleanChange;
    if (pending === null) return;
    this.s.pendingCleanChange = null;
    if (pending.text !== currentWritten) {
      if (!this.s.recentCleanCandidates.includes(pending.text)) {
        this.s.recentCleanCandidates.push(pending.text);
        if (this.s.recentCleanCandidates.length > MAX_CLEAN_CANDIDATES) this.s.recentCleanCandidates.shift();
      }
      this.s.jumps++;
    }
  }

  private setBase(text: string, stat: FileStat | null): void {
    this.s.base = text;
    this.s.openingText = null;
    this.s.rememberedStamp = null;
    this.s.recentCleanCandidates = [];
    if (stat !== null) this.s.baseStat = stat;
    this.s.baseJumps = this.s.jumps;
    this.s.pendingCleanChange = null;
    this.syncRememberedBase(asWritten(this.d.documentLf(), this.d.encoding()));
  }

  private pushSaveCandidate(text: string): void {
    const c = this.s.inFlightSave?.candidates;
    if (!c || c.includes(text)) return;
    c.push(text);
    if (c.length > MAX_SAVE_CANDIDATES) c.shift();
  }

  private syncRememberedBase(docWritten: string): void {
    const base = this.effectiveBase();
    const want = base !== null && docWritten !== base ? stampKey(base, this.d.encoding()) : null;
    if (want === this.s.lastRemembered) return;
    this.s.lastRemembered = want;
    this.d.remember(rememberKey(this.d.key), want ?? undefined);
  }

  private scheduleCheckTimer(slot: 'recheck' | 'retry', ms: number): void {
    if (this.disposed) return;
    if (slot === 'retry' && this.retryTimer !== null) return;
    if (slot === 'recheck' && this.recheckTimer !== null) this.d.schedule.clearTimeout(this.recheckTimer);
    const handle = this.d.schedule.setTimeout(() => {
      if (slot === 'recheck') this.recheckTimer = null;
      else this.retryTimer = null;
      this.requestCheck({ forceRead: true, recheck: true });
    }, ms);
    if (slot === 'recheck') this.recheckTimer = handle;
    else this.retryTimer = handle;
  }

  private sleep(ms: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const entry = {
        handle: null as unknown,
        finish: (ok: boolean) => {
          if (!this.sleepTimers.delete(entry)) return;
          this.d.schedule.clearTimeout(entry.handle);
          resolve(ok && !this.disposed);
        },
      };
      entry.handle = this.d.schedule.setTimeout(() => entry.finish(true), ms);
      this.sleepTimers.add(entry);
    });
  }

  private cancelSleeps(): void {
    for (const entry of [...this.sleepTimers]) entry.finish(false);
  }
}

function rememberKey(uri: string): string {
  return `base:${uri}`;
}
