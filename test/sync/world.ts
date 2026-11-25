// Lean deterministic simulation harness connecting DocumentCoordinator, FakeDocument, FakeDisk,
// FakeClock, and HeadlessPanel. Also exports shared helpers (Rng, markersIn, safePositions,
// DEFAULT_SETTINGS) used by harness/ and test/panel/.

import {
  type CoreNotice,
  DocumentCoordinator,
  type FaultRecord,
  type InitFields,
  type UiPort,
  type WhenBothChanged,
} from '../../src/core/coordinator';
import type { TextChange } from '../../src/core/diff';
import { toLf } from '../../src/core/eol';
import { type LogLevel, type PanelSettings, SETTING_DEFAULTS } from '../../src/core/protocol';
import type { SaveStepCount } from '../../src/core/reconcile/types';
import { FakeClock } from './fakes/clock';
import { FakeDisk, encodeAs, utf8Bytes } from './fakes/disk';
import { type Eol, FakeDocument, type SaveKind, raw } from './fakes/document';
import { HeadlessPanel } from './fakes/panel';

// ---------------------------------------------------------------------------
// Shared helpers (used by harness/ and test/panel/)

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const MARKER = /⟦\d+⟧/g;

export function markersIn(text: string): string[] {
  return text.match(MARKER) ?? [];
}

export function safePositions(text: string): number[] {
  const inside = new Set<number>();
  for (const m of text.matchAll(/⟦P?\d+⟧/g)) {
    for (let i = m.index! + 1; i < m.index! + m[0].length; i++) inside.add(i);
  }
  for (const m of text.matchAll(/⟦P?\d*(?!\d|⟧)/g)) {
    for (let i = m.index! + 1; i <= m.index! + m[0].length; i++) inside.add(i);
  }
  const out: number[] = [];
  for (let i = 0; i <= text.length; i++) if (!inside.has(i)) out.push(i);
  return out;
}

export const DEFAULT_SETTINGS: PanelSettings = { ...SETTING_DEFAULTS, workspaceTrusted: true };

// ---------------------------------------------------------------------------
// Deterministic SyncWorld

export interface SyncWorldOptions {
  text: string;
  diskText?: string;
  diskBytes?: Uint8Array;
  eol?: Eol;
  dirty?: boolean;
  dirtyLate?: boolean;
  encoding?: string;
  autoSave?: boolean;
  whenBothChanged?: WhenBothChanged;
  panels?: number;
  memory?: Map<string, unknown>;
  holdOutside?: () => boolean;
  saveSteps?: SaveStepCount;
  /** Delay before VS Code's own clean-doc reload triggers after an external write (T2 ~85 ms). */
  vsReloadDelayMs?: number | null;
  /** Delay before file watcher notifies coordinator after a disk change. */
  watcherDelayMs?: number;
  savesEmptyFirst?: boolean;
}

export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export class SyncWorld {
  readonly clock = new FakeClock();
  readonly disk: FakeDisk;
  readonly doc: FakeDocument;
  readonly coordinator: DocumentCoordinator;
  readonly panels: HeadlessPanel[] = [];
  readonly notices: CoreNotice[] = [];
  readonly logs: { level: LogLevel; message: string; detail?: unknown }[] = [];
  readonly debugLines: string[] = [];
  readonly faults: FaultRecord[] = [];
  readonly memory: Map<string, unknown>;
  prefer: WhenBothChanged;
  readonly encoding: string;
  readonly uri = 'file:///notes/note.md';
  readonly fileName = 'note.md';
  private nextNoticeId = 0;

  constructor(opts: SyncWorldOptions) {
    const eol = opts.eol ?? '\n';
    this.encoding = opts.encoding ?? 'utf8';
    this.prefer = opts.whenBothChanged ?? 'keepMine';
    this.memory = opts.memory ?? new Map<string, unknown>();
    const initialBytes = opts.diskBytes ?? encodeAs(raw(opts.diskText ?? opts.text, eol), this.encoding);
    this.disk = new FakeDisk(this.clock, initialBytes);
    if (opts.savesEmptyFirst) this.disk.savesEmptyFirst = true;

    this.doc = new FakeDocument({
      clock: this.clock,
      disk: this.disk,
      lf: opts.text,
      eol,
      dirty: opts.dirty ?? false,
      dirtyLate: opts.dirtyLate ?? false,
      autoSave: opts.autoSave ?? false,
      encoding: this.encoding,
    });

    const watcherDelay = opts.watcherDelayMs ?? 15;
    const vsReloadDelay = opts.vsReloadDelayMs === undefined ? 85 : opts.vsReloadDelayMs;
    this.disk.onChange = (origin) => {
      if (watcherDelay >= 0) {
        this.clock.setTimeout(() => this.coordinator.diskChanged(), watcherDelay);
      }
      if (origin === 'outside' && vsReloadDelay !== null) {
        this.clock.setTimeout(() => this.doc.fileChanged(), vsReloadDelay);
      }
    };

    const ui: UiPort = {
      postToPanel: (panelId, message) => {
        const panel = this.panels.find((p) => p.id === panelId);
        panel?.post(message);
      },
      initFields: (): InitFields => ({
        mode: 'edit',
        settings: DEFAULT_SETTINGS,
        docInfo: { uri: this.uri, fileName: this.fileName, workspacePath: this.fileName, readOnly: false },
        testMode: true,
      }),
      notify: (n) => this.notices.push(n),
      log: (level, message, detail) => this.logs.push({ level, message, detail }),
      dumpFault: (r) => this.faults.push(r),
      reloadPanel: () => undefined,
      remember: (k, v) => {
        if (v === undefined) this.memory.delete(k);
        else this.memory.set(k, v);
      },
      recall: (k) => this.memory.get(k),
    };

    this.coordinator = new DocumentCoordinator({
      document: this.doc,
      disk: this.disk,
      ui,
      schedule: this.clock,
      key: this.uri,
      fileName: this.fileName,
      whenBothChanged: () => this.prefer,
      newId: () => `id-${++this.nextNoticeId}`,
      debug: (msg) => this.debugLines.push(`t=${this.clock.now()} ${msg}`),
      holdOutside: opts.holdOutside,
      saveSteps: opts.saveSteps,
    });

    this.doc.listener = {
      documentChanged: (c) => this.coordinator.documentChanged(c),
      willSave: () => this.coordinator.willSave(),
      didSave: () => this.coordinator.didSave(),
      documentClosed: () => this.coordinator.documentClosed(),
    };

    const panelCount = opts.panels ?? 1;
    for (let i = 0; i < panelCount; i++) this.addPanel(`panel-${i + 1}`);
  }

  addPanel(id: string): HeadlessPanel {
    const p = new HeadlessPanel(id, this.clock);
    this.panels.push(p);
    this.coordinator.panelAttached(id);
    p.sendReady();
    return p;
  }

  /** Processes all immediately ready messages and disk ops without advancing fake time. */
  async pump(maxSteps = 2000): Promise<void> {
    await flushMicrotasks();
    for (let step = 0; step < maxSteps; step++) {
      let did = false;
      const now = this.clock.now();
      for (const p of this.panels) {
        while (p.toHost.length > 0) {
          const item = p.toHost.shift()!;
          this.coordinator.panelMessage(p.id, item.message);
          did = true;
        }
        while (p.toPanel.length > 0) {
          p.deliverNext();
          did = true;
        }
      }
      if (this.doc.toMain.length > 0) {
        this.doc.processOnMain();
        did = true;
      }
      if (this.doc.toExt.length > 0) {
        this.doc.deliverToExt();
        did = true;
      }
      const readyDisk = this.disk.ready(now);
      if (readyDisk.length > 0) {
        this.disk.resolve(readyDisk[0]!);
        did = true;
      }
      if (this.clock.fireDue() > 0) did = true;
      await flushMicrotasks();
      if (!did) return;
    }
    throw new Error('SyncWorld.pump exceeded maxSteps');
  }

  /** Advances fake time by `ms`, firing timers and pumping messages in exact chronological order. */
  async advance(ms: number): Promise<void> {
    const target = this.clock.now() + ms;
    await this.pump();
    for (let guard = 0; guard < 2000; guard++) {
      const nextTimer = this.clock.nextDue();
      const nextDisk = this.earliestDiskAt();
      const next = Math.min(nextTimer ?? Infinity, nextDisk ?? Infinity);
      if (next > target) {
        this.clock.advanceToward(target);
        await this.pump();
        return;
      }
      this.clock.advanceToward(next);
      await this.pump();
    }
    throw new Error('SyncWorld.advance exceeded guard');
  }

  /** Runs timers and queues until everything is quiet (or `maxMs` of fake time elapses). */
  async settle(maxMs = 15_000): Promise<void> {
    const limit = this.clock.now() + maxMs;
    for (let guard = 0; guard < 4000; guard++) {
      await this.pump();
      const nextTimer = this.clock.nextDue();
      const nextDisk = this.earliestDiskAt();
      const next = Math.min(nextTimer ?? Infinity, nextDisk ?? Infinity);
      if (next === Infinity || next > limit) return;
      this.clock.advanceToward(next);
    }
    throw new Error('SyncWorld.settle exceeded guard');
  }

  writeOutside(lf: string, eol?: Eol): void {
    const useEol = eol ?? this.doc.eol;
    this.disk.write(encodeAs(raw(toLf(lf), useEol), this.encoding), 'outside');
  }

  writeRawOutside(bytes: Uint8Array): void {
    this.disk.write(bytes, 'outside');
  }

  editInSource(change: TextChange): void {
    this.doc.sourceEdit(change);
  }

  save(kind: SaveKind = 'explicit'): void {
    this.doc.save(kind);
  }

  async saveAndSettle(kind: SaveKind = 'explicit'): Promise<void> {
    for (const p of this.panels) {
      if (!p.closed) void p.sync.flush();
    }
    await this.pump();
    this.doc.save(kind);
    await this.settle();
  }

  /** Checks panel, document, and coordinator log agreement. */
  inSync(): boolean {
    const docText = this.doc.lf;
    const core = this.coordinator.inspect();
    if (core.text !== docText) return false;
    return this.panels.every((p) => p.closed || p.text === docText);
  }

  /** True if text is backed up on disk or held directly in a notice. */
  isPreservedInBackupOrNotice(needle: string): boolean {
    for (const b of this.disk.backups.values()) {
      if (!b.deleted && toLf(new TextDecoder().decode(b.bytes)).includes(needle)) return true;
    }
    for (const n of this.notices) {
      if ('diskText' in n && n.diskText?.includes(needle)) return true;
      if ('previousText' in n && n.previousText?.includes(needle)) return true;
      if ('copy' in n && n.copy.includes(needle)) return true;
    }
    return false;
  }

  private earliestDiskAt(): number | null {
    if (this.disk.ops.length === 0) return null;
    let best = Infinity;
    for (const op of this.disk.ops) {
      const at = op.at + op.delay;
      if (at < best) best = at;
    }
    return best;
  }
}

export { utf8Bytes };
