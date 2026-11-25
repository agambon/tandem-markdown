// A model of VS Code's text document as the extension host sees it, behaving as
// docs/ARCHITECTURE.md, "What VS Code is assumed to do", says: a copy of the main thread's text,
// brought up to date by change events on one ordered channel; applyEdit stamped with the copy's
// version and refused if the document moved, its change event arriving before its reply; the
// dirty flag a change event late; a clean document's changed file reloaded as one coarse
// replacement (given up if the document changed while it read, and never while it saves); a save
// running will-save, another extension's save participant, then the write, and "Save without
// Formatting" neither; an edit sent around a close applied to a fresh copy of the file. Every
// applyEdit is also checked for property 6 (its offsets computed against the text the document
// held) and property 7 (no edit applied after the document closed).

import { type TextChange, applyChanges } from '../../../src/core/diff';
import type { DocumentChange, DocumentEdit, DocumentPort } from '../../../src/core/documentGate';
import { toLf } from '../../../src/core/eol';
import type { EventChange } from '../../../src/core/positions';
import type { FakeClock } from './clock';
import { type FakeDisk, decodeLenient, dominantEol, encodeAs } from './disk';

export type Eol = '\n' | '\r\n';

export interface DocListener {
  documentChanged(change: DocumentChange): void;
  willSave(): Promise<void>;
  didSave(): void;
  /** `onDidCloseTextDocument` with `isClosed` true. */
  documentClosed?(): void;
}

type ToExt =
  | {
      kind: 'event';
      changes: EventChange[];
      lf: string;
      eol: Eol;
      dirty: boolean;
      reason?: 'undo' | 'redo';
      version: number;
      at: number;
    }
  | { kind: 'reply'; id: number; ok: boolean; at: number }
  /** A dirty-only change event. */
  | { kind: 'dirty'; dirty: boolean; at: number }
  | { kind: 'willSave'; saveId: number; at: number }
  | { kind: 'saved'; saveId: number; at: number }
  | { kind: 'closed'; at: number };

/** The version of a document VS Code has just loaded from the file. */
const FRESH_VERSION = 1;

type ToMain =
  /** `stamp` is undefined for an edit sent after the extension host learned the document closed. */
  | { kind: 'applyEdit'; id: number; edit: DocumentEdit; stamp: number | undefined; at: number }
  | { kind: 'willSaveDone'; saveId: number; at: number }
  | { kind: 'history'; id: number; which: 'undo' | 'redo'; at: number };

type UndoEl =
  | { kind: 'text'; forward: TextChange[]; before: string; after: string; altBefore: number; altAfter: number }
  | { kind: 'eol'; before: Eol; after: Eol; altBefore: number; altAfter: number };

export interface ChangeCause {
  kind: 'edit' | 'source' | 'reload' | 'revert' | 'participant' | 'undo' | 'redo' | 'eol';
  /** For 'edit': the text the extension host's edit gives on its own, without a change VS Code adds to it. */
  requested?: string;
}

/** 'noFormat' is "Save without Formatting": no will-save, no save participant. */
export type SaveKind = 'explicit' | 'auto' | 'noFormat';

export interface FakeDocumentOptions {
  clock: FakeClock;
  disk: FakeDisk;
  lf: string;
  eol: Eol;
  /** The document opens with unsaved text (restored after a restart). */
  dirty?: boolean;
  /**
   * With `dirty`: the extension host first sees the document clean, and a dirty-only event
   * turning it dirty is already on its way, as VS Code 1.146 does for a document with unsaved
   * edits that was renamed.
   */
  dirtyLate?: boolean;
  autoSave?: boolean;
  /** Probability that an applied edit gets a change of VS Code's own added. */
  ownChangeRate?: number;
  /** Another extension's save participant that trims trailing whitespace. */
  trimOnSave?: boolean;
  random?: () => number;
  /** VS Code's encoding id for the document (default 'utf8'). A save writes UTF-16 LE for 'utf16le', else UTF-8. */
  encoding?: string;
  /**
   * The share of saves run as "Save without Formatting" whatever was asked, by a fixed hash of the
   * save count and the version (StressSetting.noFormatShare).
   */
  noFormatShare?: number;
}

export interface SaveInfo {
  id: number;
  kind: SaveKind;
  startedAt: number;
  /** The text written, once known. */
  written?: string;
  writtenAt?: number;
}

export class FakeDocument implements DocumentPort {
  private readonly noFormatShare: number;
  // Main thread
  lf: string;
  eol: Eol;
  version = 1;
  private altId = 1;
  private altSeq = 1;
  private savedAltId = 1;
  private undoStack: UndoEl[] = [];
  private redoStack: UndoEl[] = [];
  // Extension host's copy
  private mLf: string;
  private mEol: Eol;
  private mVersion = 1;
  private mDirty: boolean;
  // Channels
  readonly toExt: ToExt[] = [];
  readonly toMain: ToMain[] = [];
  private replies = new Map<number, (ok: boolean) => void>();
  private seq = 0;
  // Saves and reloads
  private saveState: { id: number; phase: 'willSave' | 'writing'; timer: unknown } | null = null;
  private saveAgain: SaveKind | null = null;
  private saveSeq = 0;
  private autoSaveTimer: unknown = null;
  private reloading = false;
  private reloadAgain = false;
  private reverting = false;
  /** While an applied edit is being processed: its dirty-only event, sent before or after the reply. */
  private heldDirty: { kind: 'dirty'; dirty: boolean; at: number } | null = null;
  private holdingDirty = false;
  readonly saves: SaveInfo[] = [];

  /** The user closed the document (main thread). */
  closed = false;
  /** The extension host has been told it closed. */
  private mClosed = false;
  /**
   * Edits VS Code applied to a fresh copy of the file after the close: the text it produced,
   * and whether the edit was sent before the extension host knew of the close (VS Code's own
   * race, a documented limit) or after (the core's fault).
   */
  readonly ghosts: { text: string; sentWhileOpen: boolean }[] = [];
  /** Property 6 and 7 failures. */
  readonly violations: string[] = [];
  listener: DocListener | null = null;
  /** Every main-thread change, for the oracle. */
  onChange: (before: string, after: string, cause: ChangeCause) => void = () => {};
  readonly appliedEdits: { id: number; changes: readonly TextChange[] }[] = [];

  private readonly clock: FakeClock;
  private readonly disk: FakeDisk;
  private readonly random: () => number;
  autoSave: boolean;
  ownChangeRate: number;
  trimOnSave: boolean;
  private readonly encodingId: string;

  constructor(o: FakeDocumentOptions) {
    this.noFormatShare = o.noFormatShare ?? 0;
    this.encodingId = o.encoding ?? 'utf8';
    this.clock = o.clock;
    this.disk = o.disk;
    this.lf = o.lf;
    this.eol = o.eol;
    this.mLf = o.lf;
    this.mEol = o.eol;
    this.random = o.random ?? Math.random;
    this.autoSave = !!o.autoSave;
    this.ownChangeRate = o.ownChangeRate ?? 0;
    this.trimOnSave = !!o.trimOnSave;
    if (o.dirty) this.savedAltId = 0;
    this.mDirty = this.dirty && !o.dirtyLate;
    if (this.dirty && o.dirtyLate) this.pushDirty(true);
  }

  get dirty(): boolean {
    return this.altId !== this.savedAltId;
  }

  get rawText(): string {
    return raw(this.lf, this.eol);
  }

  get saving(): boolean {
    return this.saveState !== null;
  }

  /** The save being run, if any. */
  get savingId(): number | null {
    return this.saveState?.id ?? null;
  }

  // ---------------------------------------------------------------------------
  // DocumentPort (extension host side)

  getText(): string {
    return raw(this.mLf, this.mEol);
  }

  isDirty(): boolean {
    return this.mDirty;
  }

  encoding(): string {
    return this.encodingId;
  }

  applyEdit(edit: DocumentEdit): Promise<boolean> {
    if (edit.before.toString() !== this.mLf) {
      this.violations.push(
        `property 6: applyEdit sent with offsets for a text that is not the document's (version ${this.mVersion})`,
      );
    }
    const id = ++this.seq;
    // VS Code stamps an edit with the version of the document the extension host holds; a
    // closed document is no longer held, so the stamp is missing.
    this.toMain.push({
      kind: 'applyEdit',
      id,
      edit,
      stamp: this.mClosed ? undefined : this.mVersion,
      at: this.clock.now(),
    });
    return new Promise<boolean>((resolve) => this.replies.set(id, resolve));
  }

  /** The extension host's `isClosed`. */
  get isClosed(): boolean {
    return this.mClosed;
  }

  /** What the host's undo command does: VS Code's undo or redo, on the main thread. */
  requestHistory(which: 'undo' | 'redo'): Promise<boolean> {
    const id = ++this.seq;
    this.toMain.push({ kind: 'history', id, which, at: this.clock.now() });
    return new Promise<boolean>((resolve) => this.replies.set(id, resolve));
  }

  // ---------------------------------------------------------------------------
  // Delivery (driver)

  /** Delivers the next main-to-extension-host message. */
  deliverToExt(): void {
    const m = this.toExt.shift();
    if (!m) return;
    switch (m.kind) {
      case 'event': {
        this.mLf = m.lf;
        this.mEol = m.eol;
        this.mVersion = m.version;
        this.mDirty = m.dirty;
        const change: DocumentChange = { text: raw(m.lf, m.eol), changes: m.changes, dirty: m.dirty };
        if (m.reason) change.reason = m.reason;
        this.listener?.documentChanged(change);
        return;
      }
      case 'reply': {
        const r = this.replies.get(m.id);
        this.replies.delete(m.id);
        r?.(m.ok);
        return;
      }
      case 'dirty':
        this.mDirty = m.dirty;
        this.listener?.documentChanged({ text: raw(this.mLf, this.mEol), changes: [], dirty: m.dirty });
        return;
      case 'willSave': {
        const l = this.listener;
        const done = () => this.toMain.push({ kind: 'willSaveDone', saveId: m.saveId, at: this.clock.now() });
        if (!l) done();
        else l.willSave().then(done, done);
        return;
      }
      case 'saved':
        // The extension host reports the document clean at a save, whatever the main thread thinks.
        this.mDirty = false;
        this.listener?.documentChanged({ text: raw(this.mLf, this.mEol), changes: [], dirty: false });
        this.listener?.didSave();
        return;
      case 'closed':
        this.mClosed = true;
        this.listener?.documentClosed?.();
        return;
    }
  }

  /** Processes the next extension-host-to-main request. */
  processOnMain(): void {
    const r = this.toMain.shift();
    if (!r) return;
    if (r.kind === 'willSaveDone') {
      if (this.saveState && this.saveState.id === r.saveId && this.saveState.phase === 'willSave') this.afterWillSave();
      return;
    }
    if (r.kind === 'history') {
      const ok = this.history(r.which);
      this.toExt.push({ kind: 'reply', id: r.id, ok, at: this.clock.now() });
      return;
    }
    if (this.closed) {
      this.applyToFreshCopy(r);
      return;
    }
    if (r.stamp !== this.version) {
      this.reply(r.id, false);
      return;
    }
    if (r.edit.before.toString() !== this.lf) {
      this.violations.push("applyEdit applied with offsets for a text that is not the document's");
    }
    let after: string;
    try {
      after = applyChanges(this.lf, r.edit.changes);
    } catch (error) {
      this.violations.push(`applyEdit with changes that do not fit: ${String(error)}`);
      this.reply(r.id, false);
      return;
    }
    if (after === this.lf) {
      this.reply(r.id, false);
      return;
    }
    let changes = [...r.edit.changes];
    if (this.ownChangeRate > 0 && this.random() < this.ownChangeRate) {
      const extra = this.ownChangeFor(changes);
      if (extra) changes = [...changes, extra].sort((a, b) => a.from - b.from);
    }
    this.appliedEdits.push({ id: r.id, changes: r.edit.changes });
    // The edit's event goes out before the reply; its dirty-only event (when the edit moved
    // the flag) sometimes after it.
    this.holdingDirty = true;
    this.edit(changes, { kind: 'edit', requested: after }, { undoable: true });
    this.holdingDirty = false;
    const late = this.heldDirty !== null && this.random() < 0.5;
    if (this.heldDirty && !late) this.toExt.push(this.heldDirty);
    this.reply(r.id, true);
    if (this.heldDirty && late) this.toExt.push(this.heldDirty);
    this.heldDirty = null;
  }

  /**
   * An edit that reached the main thread after the document closed. VS Code loads the file as
   * it is now (a fresh copy at version 1) and applies the edit to it when the edit carries no
   * version, or that one: a hidden, unsaved copy of the file with the edit in it.
   */
  private applyToFreshCopy(r: Extract<ToMain, { kind: 'applyEdit' }>): void {
    const fresh = this.disk.textLenient();
    if (fresh === null || (r.stamp !== undefined && r.stamp !== FRESH_VERSION)) {
      this.reply(r.id, false);
      return;
    }
    let text: string;
    try {
      text = applyChanges(fresh, r.edit.changes);
    } catch {
      text = fresh; // ranges past the end: VS Code clamps them; the copy is changed all the same
    }
    const sentWhileOpen = r.stamp !== undefined;
    this.ghosts.push({ text, sentWhileOpen });
    if (!sentWhileOpen)
      this.violations.push(
        'property 7: an edit sent after the document closed was applied to a fresh copy of the file',
      );
    this.reply(r.id, true);
  }

  // ---------------------------------------------------------------------------
  // Main-thread actions (driver)

  /**
   * The user closes the document (its last editor). A dirty one is closed with "Don't
   * Save": its unsaved text is discarded. Not while a save runs.
   */
  close(): void {
    if (this.closed || this.saveState !== null) return;
    this.closed = true;
    if (this.autoSaveTimer !== null) this.clock.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
    this.saveAgain = null;
    this.toExt.push({ kind: 'closed', at: this.clock.now() });
  }

  /** The user typing or deleting in a Source editor. */
  sourceEdit(change: TextChange): void {
    if (this.closed) return;
    this.edit([change], { kind: 'source' }, { undoable: true });
  }

  /** The user pressing Ctrl+Z or Ctrl+Y in Source. */
  history(which: 'undo' | 'redo'): boolean {
    if (this.closed) return false;
    const el = which === 'undo' ? this.undoStack.pop() : this.redoStack.pop();
    if (!el) return false;
    const reported = this.dirty;
    if (el.kind === 'eol') {
      const target = which === 'undo' ? el.before : el.after;
      this.altId = which === 'undo' ? el.altBefore : el.altAfter;
      this.emitEol(target, which, reported);
    } else if (which === 'undo') {
      if (this.lf !== el.after) throw new Error('fake document: undo stack out of step with the text');
      this.altId = el.altBefore;
      this.emit(invert(el.forward, el.before), which, reported);
    } else {
      if (this.lf !== el.before) throw new Error('fake document: redo stack out of step with the text');
      this.altId = el.altAfter;
      this.emit(el.forward, which, reported);
    }
    (which === 'undo' ? this.redoStack : this.undoStack).push(el);
    return true;
  }

  save(kind: SaveKind): void {
    if (kind !== 'noFormat' && ((this.saves.length * 7919 + this.version * 104729) % 1000) / 1000 < this.noFormatShare)
      kind = 'noFormat';
    if (this.closed) return;
    if (this.saveState) {
      this.saveAgain = this.saveAgain === 'explicit' ? 'explicit' : kind;
      return;
    }
    if (kind === 'auto' && !this.dirty) return;
    const id = ++this.saveSeq;
    this.saves.push({ id, kind, startedAt: this.clock.now() });
    if (kind === 'noFormat') {
      // No will-save, no participant: straight to the write.
      this.saveState = { id, phase: 'writing', timer: null };
      this.write(this.saveState);
      return;
    }
    const timer = this.clock.setTimeout(() => {
      if (this.saveState?.id === id && this.saveState.phase === 'willSave') this.afterWillSave();
    }, 1750);
    this.saveState = { id, phase: 'willSave', timer };
    this.toExt.push({ kind: 'willSave', saveId: id, at: this.clock.now() });
  }

  /**
   * Revert File: VS Code marks the document clean, reads the file, and puts its text in the
   * document (one coarse, undoable change), then reports the flag again.
   */
  revert(): void {
    // Like a reload, a revert reads the file through VS Code's resolve, which never runs
    // while the document is being saved; one a save overtook is abandoned.
    if (this.closed || this.reverting || this.saveState !== null) return;
    this.reverting = true;
    void this.disk.vsRead().then((bytes) => {
      this.reverting = false;
      if (bytes === null || this.saveState !== null || this.closed) return;
      const text = decodeLenient(bytes);
      const newLf = toLf(text);
      const newEol = dominantEol(text) ?? this.eol;
      if (newEol !== this.eol) this.setEol(newEol, true);
      if (newLf !== this.lf)
        this.edit([coarseChange(this.lf, newLf)], { kind: 'revert' }, { undoable: true, clean: true });
      this.savedAltId = this.altId;
      this.pushDirty(false);
    });
  }

  /**
   * VS Code's own watcher saw the file change. Like VS Code's TextFileEditorModel.resolve, it
   * does not reload a document that is dirty or being saved (the event is dropped), and a
   * reload that a save or an edit overtook is abandoned.
   */
  fileChanged(): void {
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    if (this.closed || this.dirty || this.saveState !== null) return;
    this.reloading = true;
    const startVersion = this.version;
    void this.disk.vsRead().then((bytes) => {
      this.reloading = false;
      if (bytes !== null && this.version === startVersion && !this.dirty && this.saveState === null && !this.closed) {
        const text = decodeLenient(bytes);
        const newLf = toLf(text);
        const newEol = dominantEol(text) ?? this.eol;
        if (newEol !== this.eol) this.setEol(newEol, true);
        if (newLf !== this.lf)
          this.edit([coarseChange(this.lf, newLf)], { kind: 'reload' }, { undoable: true, clean: true });
      }
      if (this.reloadAgain) {
        this.reloadAgain = false;
        this.fileChanged();
      }
    });
  }

  pendingReplies(): number {
    return this.replies.size;
  }

  // ---------------------------------------------------------------------------
  // Internals

  private reply(id: number, ok: boolean): void {
    this.toExt.push({ kind: 'reply', id, ok, at: this.clock.now() });
  }

  private afterWillSave(): void {
    const s = this.saveState!;
    this.clock.clearTimeout(s.timer);
    if (this.trimOnSave) {
      const c = trailingWhitespace(this.lf);
      if (c.length > 0) this.edit(c, { kind: 'participant' }, { undoable: true });
    }
    this.write(s);
  }

  private write(s: { id: number; phase: 'willSave' | 'writing'; timer: unknown }): void {
    const snap = { lf: this.lf, eol: this.eol, version: this.version, altId: this.altId };
    s.phase = 'writing';
    const info = this.saves.find((x) => x.id === s.id)!;
    info.written = snap.lf;
    void this.disk.saveWrite(encodeAs(raw(snap.lf, snap.eol), this.encodingId)).then(() => {
      info.writtenAt = this.clock.now();
      if (this.version === snap.version) this.savedAltId = snap.altId;
      this.toExt.push({ kind: 'saved', saveId: s.id, at: this.clock.now() });
      this.saveState = null;
      if (this.saveAgain) {
        const k = this.saveAgain;
        this.saveAgain = null;
        this.save(k);
      }
    });
  }

  /** A change that leaves the document clean (a reload or a revert) is reported clean; any other carries the flag from before it. */
  private edit(changes: TextChange[], cause: ChangeCause, o: { undoable: boolean; clean?: boolean }): void {
    const reported = o.clean ? false : this.dirty;
    if (o.undoable) {
      const altAfter = ++this.altSeq;
      this.undoStack.push({
        kind: 'text',
        forward: changes,
        before: this.lf,
        after: applyChanges(this.lf, changes),
        altBefore: this.altId,
        altAfter,
      });
      this.redoStack = [];
      this.altId = altAfter;
    }
    if (o.clean) this.savedAltId = this.altId;
    this.emit(changes, undefined, reported, cause);
  }

  private setEol(eol: Eol, clean: boolean): void {
    const reported = clean ? false : this.dirty;
    const altAfter = ++this.altSeq;
    this.undoStack.push({ kind: 'eol', before: this.eol, after: eol, altBefore: this.altId, altAfter });
    this.redoStack = [];
    this.altId = altAfter;
    if (clean) this.savedAltId = this.altId;
    this.emitEol(eol, undefined, reported);
  }

  /** A dirty-only event (held back while an applied edit is processed, so it can follow the reply). */
  private pushDirty(dirty: boolean): void {
    const m = { kind: 'dirty' as const, dirty, at: this.clock.now() };
    if (this.holdingDirty) this.heldDirty = m;
    else this.toExt.push(m);
  }

  /** After a change event that reported `reported`: the flag's own event, if the change moved it. */
  private followDirty(reported: boolean): void {
    if (this.dirty !== reported) this.pushDirty(this.dirty);
  }

  /** Applies ascending LF changes on the main thread and sends the event. */
  private emit(
    changes: TextChange[],
    reason: 'undo' | 'redo' | undefined,
    reported: boolean,
    cause?: ChangeCause,
  ): void {
    const before = this.lf;
    const after = applyChanges(before, changes);
    const event: EventChange[] = changes
      .slice()
      .reverse()
      .map((c) => ({
        range: { start: lineChar(before, c.from), end: lineChar(before, c.to) },
        text: c.insert.split('\n').join(this.eol),
      }));
    this.lf = after;
    this.version++;
    const m: ToExt = {
      kind: 'event',
      changes: event,
      lf: after,
      eol: this.eol,
      dirty: reported,
      version: this.version,
      at: this.clock.now(),
    };
    if (reason) m.reason = reason;
    this.toExt.push(m);
    this.followDirty(reported);
    this.onChange(before, after, cause ?? { kind: reason ?? 'edit' });
    this.armAutoSave();
  }

  /** A line-ending change: one event replacing the whole document with its own text. */
  private emitEol(eol: Eol, reason: 'undo' | 'redo' | undefined, reported: boolean): void {
    const lines = this.lf.split('\n');
    const last = lines.length - 1;
    const event: EventChange[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: last, character: lines[last]!.length } },
        text: lines.join(eol),
      },
    ];
    this.eol = eol;
    this.version++;
    const m: ToExt = {
      kind: 'event',
      changes: event,
      lf: this.lf,
      eol,
      dirty: reported,
      version: this.version,
      at: this.clock.now(),
    };
    if (reason) m.reason = reason;
    this.toExt.push(m);
    this.followDirty(reported);
    this.onChange(this.lf, this.lf, { kind: 'eol' });
    this.armAutoSave();
  }

  private armAutoSave(): void {
    if (!this.autoSave) return;
    if (this.autoSaveTimer !== null) this.clock.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = this.clock.setTimeout(() => {
      this.autoSaveTimer = null;
      this.save('auto');
    }, 1000);
  }

  /** A trailing-whitespace run away from every change, to delete as VS Code's own addition. */
  private ownChangeFor(changes: readonly TextChange[]): TextChange | null {
    const re = / +(?=\n|$)/g;
    const candidates: TextChange[] = [];
    for (let m = re.exec(this.lf); m; m = re.exec(this.lf)) {
      const from = m.index;
      const to = from + m[0].length;
      if (changes.every((c) => to < c.from || from > c.to)) candidates.push({ from, to, insert: '' });
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(this.random() * candidates.length)]!;
  }
}

export function raw(lf: string, eol: Eol): string {
  return eol === '\n' ? lf : lf.split('\n').join(eol);
}

function lineChar(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, character: offset - start };
}

/** Changes that undo `forward` (ascending changes of `before`), as changes of the text after it. */
function invert(forward: readonly TextChange[], before: string): TextChange[] {
  const out: TextChange[] = [];
  let delta = 0;
  for (const c of forward) {
    const from = c.from + delta;
    out.push({ from, to: from + c.insert.length, insert: before.slice(c.from, c.to) });
    delta += c.insert.length - (c.to - c.from);
  }
  return out;
}

/** VS Code's reload: one replacement from the first changed line to the last. */
function coarseChange(oldLf: string, newLf: string): TextChange {
  const a = splitKeep(oldLf);
  const b = splitKeep(newLf);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const from = a.slice(0, p).join('').length;
  const oldTo = oldLf.length - a.slice(a.length - s).join('').length;
  const newTo = newLf.length - b.slice(b.length - s).join('').length;
  return { from, to: oldTo, insert: newLf.slice(from, newTo) };
}

function splitKeep(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function trailingWhitespace(lf: string): TextChange[] {
  const out: TextChange[] = [];
  const re = / +(?=\n|$)/g;
  for (let m = re.exec(lf); m; m = re.exec(lf)) out.push({ from: m.index, to: m.index + m[0].length, insert: '' });
  return out;
}
