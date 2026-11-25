// The harness's stand-in for VS Code: the real DocumentCoordinator over the simulation's own
// fake document and disk (test/sync/fakes), run in real time inside the page, with a UI port
// that posts to the real panel through a bridge.
//
// The fake document behaves as VS Code's does (docs/ARCHITECTURE.md, "What VS Code is assumed
// to do"): it keeps a main-thread copy and an extension-host copy, refuses an edit when the
// document moved, and delivers the change event before the edit's reply. A pump delivers every
// message, finishes every disk operation and fires every timer in real time, and each channel
// keeps its order. With latency switched on (the storm does) every item waits a random few
// milliseconds and the pump picks at random among the ready channels, so the interleavings vary
// as they do in a real window. Messages are copied through JSON, as VS Code's postMessage does.

import {
  DocumentCoordinator,
  type FaultRecord,
  type InitFields,
  type UiPort,
  type WhenBothChanged,
} from '../src/core/coordinator';
import { toLf } from '../src/core/eol';
import { errorMessage } from '../src/core/errors';
import type { TestAction } from '../src/core/featureProtocol';
import { stampOf, type TextStamp } from '../src/core/hash';
import type { HostToPanel, Mode, PanelSettings, PanelToHost, ViewState } from '../src/core/protocol';
import type { CoreNotice } from '../src/core/reconcile/types';
import type { HostBridge } from '../src/panel/context';
import { FakeClock } from '../test/sync/fakes/clock';
import { FakeDisk, decodeLenient, dominantEol, utf8Bytes } from '../test/sync/fakes/disk';
import { FakeDocument, raw, type ChangeCause, type Eol } from '../test/sync/fakes/document';
import { DEFAULT_SETTINGS, type Rng } from '../test/sync/world';

/** A handler for a feature message: its return value (or promise) answers a message with a requestId. */
export type MessageHandler = (message: PanelToHost & { [key: string]: unknown }, host: FakeHost) => unknown;

export interface HostLog {
  level: string;
  message: string;
  detail?: unknown;
  /** Where it came from: the core, or the panel's `log` messages. */
  from: 'core' | 'panel';
}

/** The fake clock with real time: the fake document and disk, and the coordinator, run on it. */
class RealClock extends FakeClock {
  private readonly live = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly afterTimer: () => void) {
    super();
  }
  override now(): number {
    return performance.now();
  }
  override setTimeout(fn: () => void, ms: number): unknown {
    const handle = setTimeout(
      () => {
        this.live.delete(handle);
        try {
          fn();
        } finally {
          this.afterTimer();
        }
      },
      Math.max(0, ms),
    );
    this.live.add(handle);
    return handle;
  }
  override clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
    this.live.delete(handle as ReturnType<typeof setTimeout>);
  }
  override get pendingTimers(): number {
    return this.live.size;
  }
  /** Stops every timer (the host is being thrown away). */
  stopAll(): void {
    for (const handle of this.live) clearTimeout(handle);
    this.live.clear();
  }
}

interface Item<T> {
  at: number;
  value: T;
}

/** One ordered stream the pump delivers from. */
interface Channel {
  name: string;
  /** Items waiting. */
  size(): number;
  /** The time the head may go. */
  readyAt(): number;
  /** Delivers the head. */
  run(): void;
}

export interface Latency {
  /** Most milliseconds a message waits (host and panel channels, main thread and extension host). */
  messages: number;
  /** Most milliseconds a disk operation takes. */
  disk: number;
  /** The random numbers for the waits and for which ready channel goes first. */
  rng: Rng;
}

export interface FakeHostOptions {
  /** The document's LF text when it opens; also the file's. */
  text: string;
  eol?: Eol;
  fileName?: string;
  mode?: Mode;
  settings?: PanelSettings;
  /** Tampers with the first init: 'protocol' sends another protocol number, 'fields' drops its text. */
  initFault?: 'protocol' | 'fields' | null;
}

interface Connection {
  id: number;
  panelId: string;
  listeners: Set<(message: HostToPanel) => void>;
  state: unknown;
  attached: boolean;
  closed: boolean;
}

export class FakeHost {
  /**
   * Handlers every new fake host starts with, by message type. A feature's fakes
   * (harness/fakes/) add theirs when the harness loads them; `registerHandler` on one host
   * replaces a default for that host only.
   */
  static readonly defaultHandlers = new Map<string, MessageHandler>();

  readonly clock: RealClock;
  readonly disk: FakeDisk;
  readonly doc: FakeDocument;
  readonly coordinator: DocumentCoordinator;
  readonly fileName: string;
  readonly uri: string;

  /** Everything the core asked the host to show (conflicts, saved outside versions...). */
  readonly notices: CoreNotice[] = [];
  /** Messages the host shows of its own ("Undo didn't run. Try again in a moment."). */
  readonly hostMessages: string[] = [];
  readonly logs: HostLog[] = [];
  readonly faults: FaultRecord[] = [];
  /** Messages the panel sent that the host handles itself, newest last (for checks). */
  readonly received: PanelToHost[] = [];
  /** Every init posted, with its reason. */
  readonly inits: { reason: 'open' | 'resync'; clientId: string }[] = [];
  /** `showSource` requests from the panel (the failure page, the view switch). */
  showSourceRequests = 0;
  /** What the panel reported when it could not start (`startFailed`). */
  readonly startFailures: string[] = [];
  /** The panel's last reports. */
  lastViewState: ViewState | null = null;
  lastFocus: { editor: boolean; field: boolean } | null = null;
  mode: Mode;
  settings: PanelSettings;
  prefer: WhenBothChanged = 'keepMine';
  /** Messages to the panel dropped on purpose ("Drop next message"). */
  dropped = 0;
  /** Source (the document box) is the active text editor: VS Code's `window.activeTextEditor` is this document. */
  sourceActive = false;

  private dropNext = false;
  private holding = false;
  private readonly held: { connection: number; message: PanelToHost }[] = [];
  private initFault: 'protocol' | 'fields' | null;
  private latency: Latency | null = null;
  private readonly memory = new Map<string, unknown>();
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly toPanel: Item<{ connection: number; message: HostToPanel }>[] = [];
  private readonly toHost: Item<{ connection: number; message: PanelToHost }>[] = [];
  private readonly watcherEvents: number[] = [];
  private readonly vsFileEvents: number[] = [];
  private readonly ready = new WeakMap<object, number>();
  private readonly lastReady = new Map<string, number>();
  private readonly channels: Channel[];
  private readonly listeners = new Set<() => void>();
  private readonly docListeners = new Set<(before: string, after: string, cause: ChangeCause) => void>();
  private readonly diskListeners = new Set<() => void>();
  private readonly connections = new Map<number, Connection>();
  private readonly tests = new Map<string, (answer: { result: unknown; error?: string }) => void>();
  private readonly reloadListeners = new Set<(viewState: ViewState | null) => void>();
  private connectionSeq = 0;
  private requestSeq = 0;
  private scheduled: 'now' | ReturnType<typeof setTimeout> | null = null;
  private readonly tick = new MessageChannel();
  private disposed = false;

  constructor(o: FakeHostOptions) {
    this.fileName = o.fileName ?? 'sample.md';
    this.uri = `file:///harness/${encodeURIComponent(this.fileName)}`;
    this.mode = o.mode ?? 'edit';
    this.settings = o.settings ?? DEFAULT_SETTINGS;
    this.initFault = o.initFault ?? null;
    for (const [type, handler] of FakeHost.defaultHandlers) this.handlers.set(type, handler);
    this.clock = new RealClock(() => this.kick());
    const eol = o.eol ?? '\n';
    this.disk = new FakeDisk(this.clock, utf8Bytes(raw(o.text, eol)));
    this.doc = new FakeDocument({ clock: this.clock, disk: this.disk, lf: o.text, eol });
    this.disk.onChange = (origin) => {
      const now = this.clock.now();
      this.watcherEvents.push(now);
      if (origin === 'outside') this.vsFileEvents.push(now);
      for (const l of this.diskListeners) l();
      this.kick();
    };
    this.doc.onChange = (before, after, cause) => {
      for (const l of this.docListeners) l(before, after, cause);
    };
    this.coordinator = new DocumentCoordinator({
      document: this.doc,
      disk: this.disk,
      ui: this.ui(),
      schedule: this.clock,
      key: this.uri,
      fileName: this.fileName,
      whenBothChanged: () => this.prefer,
    });
    this.doc.listener = {
      // As the real host does (src/host/documents.ts): a change that is not an undo or redo is
      // labeled 'outside' unless the user is typing in Source (the document box).
      documentChanged: (change) =>
        this.coordinator.documentChanged(
          change.reason || this.sourceActive ? change : { ...change, reason: 'outside' },
        ),
      willSave: () => this.coordinator.willSave(),
      didSave: () => this.coordinator.didSave(),
    };
    this.tick.port1.onmessage = () => this.step();

    const fifo = <T>(
      name: string,
      items: Item<T>[],
      run: (value: T) => void,
      kind: 'messages' | 'disk' = 'messages',
    ): Channel => ({
      name,
      size: () => items.length,
      readyAt: () => this.readyAt(name, items[0]!, items[0]!.at, kind),
      run: () => run(items.shift()!.value),
    });
    const docMain: readonly { at: number }[] = this.doc.toMain;
    const docExt: readonly { at: number }[] = this.doc.toExt;
    this.channels = [
      {
        name: 'main',
        size: () => docMain.length,
        readyAt: () => this.readyAt('main', docMain[0]!, docMain[0]!.at, 'messages'),
        run: () => this.doc.processOnMain(),
      },
      {
        name: 'ext',
        size: () => docExt.length,
        readyAt: () => this.readyAt('ext', docExt[0]!, docExt[0]!.at, 'messages'),
        run: () => this.doc.deliverToExt(),
      },
      {
        name: 'disk',
        size: () => this.disk.ops.length,
        readyAt: () => Math.min(...this.disk.ops.map((op) => this.readyAt('disk', op, op.at, 'disk', false))),
        run: () => {
          const now = performance.now();
          const ready = this.disk.ops
            .map((op, i) => [op, i] as const)
            .filter(([op]) => this.readyAt('disk', op, op.at, 'disk', false) <= now);
          const pick = this.latency && ready.length > 1 ? ready[this.latency.rng.int(ready.length)]! : ready[0]!;
          this.disk.resolve(pick[1]);
        },
      },
      {
        name: 'watcher',
        size: () => this.watcherEvents.length,
        readyAt: () => this.watcherEvents[0]!,
        run: () => {
          this.watcherEvents.shift();
          this.coordinator.diskChanged();
        },
      },
      {
        name: 'vsFile',
        size: () => this.vsFileEvents.length,
        readyAt: () => this.vsFileEvents[0]!,
        run: () => {
          this.vsFileEvents.shift();
          this.doc.fileChanged();
        },
      },
      fifo('toHost', this.toHost, (v) => this.receive(v.connection, v.message)),
      fifo('toPanel', this.toPanel, (v) => this.deliverToPanel(v.connection, v.message)),
    ];
  }

  // ---------------------------------------------------------------------------
  // Panels

  /** A bridge for a new panel page. The panel is attached to the coordinator when it sends `ready`. */
  connect(): HostBridge {
    this.disconnect();
    const id = ++this.connectionSeq;
    // One webview for the whole harness: a page reloaded in it keeps the panel id, as in VS Code.
    const connection: Connection = {
      id,
      panelId: 'panel-1',
      listeners: new Set(),
      state: undefined,
      attached: false,
      closed: false,
    };
    this.connections.set(id, connection);
    return {
      post: (message) => {
        if (connection.closed || this.disposed) return;
        this.toHost.push({ at: this.clock.now(), value: { connection: id, message: copy(message) } });
        this.kick();
      },
      onMessage: (listener) => {
        connection.listeners.add(listener);
        return () => connection.listeners.delete(listener);
      },
      getState: <T>() => connection.state as T | undefined,
      setState: (state) => {
        connection.state = copy(state);
      },
    };
  }

  /** The panel page went away (the tab closed, or the page is being rebuilt). */
  disconnect(): void {
    for (const c of this.connections.values()) {
      if (c.closed && !c.attached) continue;
      c.closed = true;
      if (c.attached) this.coordinator.panelDetached(c.panelId);
      c.attached = false;
    }
    this.kick();
  }

  /** Called with the last view state when the host rebuilds the panel's page (Reload tab, another protocol). */
  onPanelReload(listener: (viewState: ViewState | null) => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  /** Answers panel messages of this type on this host, in place of any default handler. */
  registerHandler(type: string, handler: MessageHandler): () => void {
    this.handlers.set(type, handler);
    return () => this.handlers.delete(type);
  }

  /** Runs the test hook's actions in the panel and resolves with its answer. */
  runInPanel(actions: TestAction[]): Promise<{ result: unknown; error?: string }> {
    const requestId = `t${++this.requestSeq}`;
    return new Promise((resolve) => {
      this.tests.set(requestId, resolve);
      this.post({ type: 'test', requestId, actions });
    });
  }

  /** Posts to the panel as the host does (not through the core). */
  post(message: HostToPanel): void {
    const c = this.current();
    if (c) this.enqueueToPanel(c, message);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.post({ type: 'setMode', mode });
  }

  setSettings(next: Partial<PanelSettings>): void {
    this.settings = { ...this.settings, ...next };
    this.post({ type: 'settings', settings: this.settings });
  }

  /** The next message to the panel is lost. */
  dropNextMessage(): void {
    this.dropNext = true;
  }

  /**
   * A host whose lock is never released: the panel's pushes and resync requests wait, unhandled,
   * until `releaseHeld`, while everything else (Source, the disk, other messages) carries on.
   */
  holdPanelEdits(): void {
    this.holding = true;
  }

  /** Lets the held pushes and resync requests through, in the order they came. */
  releaseHeld(): void {
    this.holding = false;
    for (const value of this.held.splice(0)) this.toHost.push({ at: this.clock.now(), value });
    this.kick();
  }

  get willDropNext(): boolean {
    return this.dropNext;
  }

  /** Random waits on every channel (the storm), or none. */
  setLatency(latency: Latency | null): void {
    this.latency = latency;
    this.kick();
  }

  // ---------------------------------------------------------------------------
  // What the user does in VS Code

  /** Typing in Source: one change to VS Code's in-memory text. */
  sourceEdit(change: { from: number; to: number; insert: string }): void {
    this.doc.sourceEdit(change);
    this.changed();
    this.kick();
  }

  /** Source now holds `next` (typing in the document box): sent as the one change that makes it so. */
  setSourceText(next: string): void {
    const change = singleChange(this.doc.lf, next);
    if (change) this.sourceEdit(change);
  }

  /** Ctrl+Z or Ctrl+Y in Source: VS Code's own undo, on the document. */
  sourceHistory(which: 'undo' | 'redo'): boolean {
    const done = this.doc.history(which);
    this.changed();
    this.kick();
    return done;
  }

  /** Undo or Redo from the rich panel (tandemMarkdown.undo): flush the panel, then VS Code's undo under the lock. */
  history(which: 'undo' | 'redo'): Promise<string> {
    const result = this.coordinator.undoRedo(which, () => this.doc.requestHistory(which));
    this.kick();
    return result.then((r) => {
      if (r === 'notClean') this.hostNotice(`${which === 'undo' ? 'Undo' : 'Redo'} didn't run. Try again in a moment.`);
      this.changed();
      return r;
    });
  }

  /** Save from the panel (tandemMarkdown.save): flush the panel, then save. Resolves when the save has finished. */
  async save(): Promise<void> {
    const c = this.current();
    this.kick();
    if (c?.attached) await this.coordinator.flushPanels([c.panelId]);
    await this.sourceSave();
  }

  /** Ctrl+S in Source: VS Code saves the document as it stands. Resolves when the save has finished. */
  sourceSave(): Promise<void> {
    this.doc.save('explicit');
    this.kick();
    // Finished when nothing is being saved and VS Code's "saved" has reached the extension host.
    return this.until(
      () => !this.doc.saving && !this.doc.toExt.some((m) => m.kind === 'willSave' || m.kind === 'saved'),
      30_000,
      'the save did not finish',
    );
  }

  get autoSave(): boolean {
    return this.doc.autoSave;
  }

  set autoSave(on: boolean) {
    this.doc.autoSave = on;
    this.changed();
  }

  /** Another program writes the file. `text` is LF text; it is written in the file's line endings unless given. */
  writeOutside(text: string, eol?: Eol): void {
    this.disk.write(utf8Bytes(raw(toLf(text), eol ?? this.diskEol)), 'outside');
    this.changed();
  }

  /** Another program rewrites the file with the other line ending and nothing else changed. */
  flipLineEndings(): void {
    const text = this.diskText();
    if (text === null) return;
    this.writeOutside(text, this.diskEol === '\r\n' ? '\n' : '\r\n');
  }

  /** The window regained focus (VS Code tells every coordinator). */
  windowFocused(): void {
    this.coordinator.windowFocused();
    this.kick();
  }

  /** A notice's button that changes the note: "Use Change from Disk" or "Replace My View", or Undo. */
  press(notice: CoreNotice): Promise<boolean> {
    const c = this.coordinator;
    const done =
      notice.kind === 'conflict'
        ? notice.choice === 'replace'
          ? c.replaceNote(notice.id)
          : c.useFileVersion(notice.id)
        : c.undoUsed(notice.id);
    this.kick();
    return done.then((r) => {
      this.changed();
      return r;
    });
  }

  // ---------------------------------------------------------------------------
  // Reading the world

  /** VS Code's in-memory text, as LF text. */
  documentText(): string {
    return this.doc.lf;
  }

  /** The file's text as VS Code would read it (LF text), or null when there is no file. */
  diskText(): string | null {
    return this.disk.textLenient();
  }

  get documentEol(): Eol {
    return this.doc.eol;
  }

  get diskEol(): Eol {
    const f = this.disk.file;
    return (f && dominantEol(decodeLenient(f.bytes))) ?? this.doc.eol;
  }

  documentStamp(): TextStamp {
    return stampOf(this.doc.lf);
  }

  get dirty(): boolean {
    return this.doc.dirty;
  }

  /** The panel's id while a panel is attached. */
  get panelId(): string | null {
    const c = this.current();
    return c?.attached ? c.panelId : null;
  }

  /** Outside versions kept in the backup folder (and not deleted again). */
  backups(): { path: string; text: string }[] {
    return this.disk.liveBackups();
  }

  /** Nothing is waiting anywhere on the host's side: no message, disk operation, timer or lock holder. */
  isQuiet(): boolean {
    const s = this.coordinator.inspect();
    return (
      this.channels.every((c) => c.size() === 0) &&
      this.clock.pendingTimers === 0 &&
      !s.gateBusy &&
      this.doc.pendingReplies() === 0 &&
      !this.doc.saving
    );
  }

  /** Resolves when nothing is waiting, or rejects after `timeoutMs`. */
  whenQuiet(timeoutMs = 30_000): Promise<void> {
    return this.until(() => this.isQuiet(), timeoutMs, 'the host did not settle');
  }

  /** Resolves once `test` is true, checked after every step, timer and change. */
  until(test: () => boolean, timeoutMs = 30_000, what = 'a wait ran out of time'): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        stop();
        reject(new Error(`${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      let pending: ReturnType<typeof setTimeout> | null = null;
      const check = () => {
        // In a later task, so the promise reactions of the step that just ran have settled.
        if (pending !== null) return;
        pending = setTimeout(() => {
          pending = null;
          if (test()) {
            stop();
            resolve();
          }
        }, 0);
      };
      const stop = () => {
        clearTimeout(deadline);
        if (pending !== null) clearTimeout(pending);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  /** Called after every pump step, timer and action. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called for every change to VS Code's in-memory text, with its cause. */
  onDocumentChange(listener: (before: string, after: string, cause: ChangeCause) => void): () => void {
    this.docListeners.add(listener);
    return () => this.docListeners.delete(listener);
  }

  /** Called after every write to the file. */
  onDiskChange(listener: () => void): () => void {
    this.diskListeners.add(listener);
    return () => this.diskListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.coordinator.dispose();
    this.clock.stopAll();
    if (this.scheduled !== null && this.scheduled !== 'now') clearTimeout(this.scheduled);
    this.scheduled = null;
    this.tick.port1.onmessage = null;
    this.tick.port1.close();
    this.listeners.clear();
    this.docListeners.clear();
    this.diskListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals

  private current(): Connection | null {
    let last: Connection | null = null;
    for (const c of this.connections.values()) if (!c.closed) last = c;
    return last;
  }

  private ui(): UiPort {
    return {
      postToPanel: (panelId, message) => {
        const c = this.current();
        if (!c || !c.attached || c.panelId !== panelId) return;
        this.enqueueToPanel(c, message);
      },
      initFields: (_panelId, reason): InitFields => {
        const fields: InitFields = {
          mode: this.mode,
          settings: this.settings,
          docInfo: {
            uri: this.uri,
            fileName: this.fileName,
            workspacePath: `harness/${this.fileName}`,
            readOnly: false,
          },
          // The specs read the panel through its test hook (`runInPanel`).
          testMode: true,
        };
        // A page rebuilt by the host opens where the last one was, as after a switch from Source.
        if (reason === 'open' && this.reopenViewState) fields.viewState = this.reopenViewState;
        this.reopenViewState = null;
        return fields;
      },
      notify: (notice) => {
        this.notices.push(notice);
        this.changed();
      },
      log: (level, message, detail) => {
        this.logs.push({ level, message, detail, from: 'core' });
        if (level === 'error') console.error(`Host: ${message}`, detail ?? '');
      },
      dumpFault: (record) => {
        this.faults.push(record);
      },
      reloadPanel: () => this.reloadPage(),
      remember: (key, value) => {
        if (value === undefined) this.memory.delete(key);
        else this.memory.set(key, value);
      },
      recall: (key) => this.memory.get(key),
    };
  }

  private reopenViewState: ViewState | null = null;

  /** The host rebuilds the panel's page: the harness boots a new panel into the same place. */
  private reloadPage(): void {
    this.reopenViewState = this.lastViewState;
    this.disconnect();
    for (const l of this.reloadListeners) l(this.reopenViewState);
  }

  /** A message the host itself shows (VS Code's information message). */
  private hostNotice(message: string): void {
    this.hostMessages.push(message);
    this.changed();
  }

  private enqueueToPanel(c: Connection, message: HostToPanel): void {
    if (this.disposed) return;
    let m = copy(message);
    if (m.type === 'init') {
      if (this.initFault === 'protocol')
        m = { ...m, protocol: (m as { protocol: number }).protocol + 1 } as HostToPanel;
      else if (this.initFault === 'fields') {
        const broken: Record<string, unknown> = { ...m };
        delete broken.text;
        m = broken as unknown as HostToPanel;
      }
      this.initFault = null;
      const init = message as { reason: 'open' | 'resync'; clientId: string };
      this.inits.push({ reason: init.reason, clientId: init.clientId });
    }
    if (this.dropNext) {
      this.dropNext = false;
      this.dropped++;
      this.changed();
      return;
    }
    this.toPanel.push({ at: this.clock.now(), value: { connection: c.id, message: m } });
    this.kick();
  }

  private deliverToPanel(connection: number, message: HostToPanel): void {
    const c = this.connections.get(connection);
    if (!c || c.closed) return;
    for (const l of [...c.listeners]) {
      try {
        l(message);
      } catch (error) {
        console.error('A panel message listener threw', error);
      }
    }
  }

  /** A message from the panel: the core's, else the host's own, else a registered handler's. */
  private receive(connection: number, message: PanelToHost): void {
    const c = this.connections.get(connection);
    if (!c || (c.closed && !c.attached)) return;
    if (message.type === 'ready' && !c.attached) {
      c.attached = true;
      this.coordinator.panelAttached(c.panelId);
    }
    if (!c.attached) return;
    if (this.holding && (message.type === 'push' || message.type === 'resyncRequest')) {
      this.held.push({ connection, message });
      return;
    }
    if (this.coordinator.panelMessage(c.panelId, message)) return;
    this.received.push(message);
    if (this.received.length > 1000) this.received.splice(0, this.received.length - 1000);
    const m = message as PanelToHost & { [key: string]: unknown };
    const handler = this.handlers.get(m.type);
    if (handler) {
      this.answer(c, m, () => handler(m, this));
      return;
    }
    switch (m.type) {
      case 'log':
        this.logs.push({ level: String(m.level), message: String(m.message), detail: m.detail, from: 'panel' });
        return;
      case 'viewState':
        this.lastViewState = {
          selection: m.selection as ViewState['selection'],
          topLine: Number(m.topLine),
          topOffsetPx: Number(m.topOffsetPx),
          mode: m.mode as Mode,
        };
        this.mode = this.lastViewState.mode;
        return;
      case 'focus':
        this.lastFocus = { editor: !!m.editor, field: !!m.field };
        return;
      case 'switchView':
        if (m.to === 'view' || m.to === 'edit') this.setMode(m.to);
        else this.showSourceRequests++;
        return;
      case 'showSource':
        this.showSourceRequests++;
        return;
      case 'startFailed':
        this.startFailures.push(String(m.detail ?? ''));
        this.logs.push({ level: 'error', message: 'The panel could not start', detail: m.detail, from: 'panel' });
        return;
      case 'reloadView':
        this.reloadPage();
        return;
      case 'testResult': {
        const done = this.tests.get(String(m.requestId));
        this.tests.delete(String(m.requestId));
        const answer: { result: unknown; error?: string } = { result: m.result };
        if (typeof m.error === 'string') answer.error = m.error;
        done?.(answer);
        return;
      }
      case 'showLog':
        return;
      default:
        if (typeof m.requestId === 'string') {
          this.reply(c, m.requestId, { ok: false, error: `The harness has no handler for "${m.type}".` });
        }
    }
  }

  private answer(c: Connection, m: PanelToHost & { [key: string]: unknown }, run: () => unknown): void {
    const requestId = typeof m.requestId === 'string' ? m.requestId : null;
    Promise.resolve()
      .then(run)
      .then(
        (result) => {
          if (requestId) this.reply(c, requestId, { ok: true, result });
        },
        (error: unknown) => {
          if (requestId) this.reply(c, requestId, { ok: false, error: errorMessage(error) });
          else console.error(`The harness handler for "${m.type}" failed`, error);
        },
      );
  }

  private reply(c: Connection, requestId: string, outcome: { ok: boolean; result?: unknown; error?: string }): void {
    if (c.closed) return;
    this.enqueueToPanel(c, { type: 'reply', requestId, ...outcome });
  }

  /** The time an item may be delivered: when it was queued plus a random wait, never before the one ahead of it. */
  private readyAt(channel: string, item: object, at: number, kind: 'messages' | 'disk', ordered = true): number {
    let t = this.ready.get(item);
    if (t === undefined) {
      const l = this.latency;
      const wait = l ? l.rng.next() * (kind === 'disk' ? l.disk : l.messages) : 0;
      t = at + wait;
      if (ordered) t = Math.max(t, this.lastReady.get(channel) ?? 0);
      this.ready.set(item, t);
      if (ordered) this.lastReady.set(channel, t);
    }
    return t;
  }

  /** Makes sure a pump step is coming. */
  private kick(): void {
    if (this.disposed || this.scheduled === 'now') return;
    if (this.scheduled !== null) clearTimeout(this.scheduled);
    this.scheduled = 'now';
    this.tick.port2.postMessage(null);
  }

  /** Delivers one item, then comes back in a later task (so promise reactions settle in between). */
  private step(): void {
    this.scheduled = null;
    if (this.disposed) return;
    const now = performance.now();
    const waiting = this.channels.filter((c) => c.size() > 0);
    const ready = waiting.filter((c) => c.readyAt() <= now);
    if (ready.length > 0) {
      const channel = this.latency && ready.length > 1 ? ready[this.latency.rng.int(ready.length)]! : ready[0]!;
      try {
        channel.run();
      } catch (error) {
        console.error(`The harness pump failed delivering on ${channel.name}`, error);
        this.logs.push({
          level: 'error',
          message: `The harness pump failed delivering on ${channel.name}`,
          detail: error,
          from: 'core',
        });
      }
      this.changed();
      this.kick();
      return;
    }
    this.changed();
    if (waiting.length > 0) {
      const next = Math.min(...waiting.map((c) => c.readyAt()));
      this.scheduled = setTimeout(() => this.step(), Math.max(0, next - now));
    }
  }

  private changed(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (error) {
        console.error('A harness listener threw', error);
      }
    }
  }
}

/** A copy made the way VS Code's postMessage makes one (JSON). */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The one change (common start and end kept) that turns `before` into `after`, or null when they are equal. */
function singleChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end))
    end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}
