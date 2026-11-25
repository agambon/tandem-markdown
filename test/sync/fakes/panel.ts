// A panel without a browser: PanelSync over a bare EditorState, with the two message queues
// the driver controls, and the boot steps the real panel will do for each init.
import { getSyncedVersion, sendableUpdates } from '@codemirror/collab';
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { type HostToPanel, type InitMessage, PROTOCOL, type PanelToHost } from '../../../src/core/protocol';
import { corruption } from '../../../src/panel/corruption';
import { type PanelFault, PanelSync, type SyncTarget } from '../../../src/panel/sync';
import type { FakeClock } from './clock';

export interface ResyncNotice {
  reason: string;
  dropped: boolean;
  /** The panel's text just before the resync. */
  droppedText: string[];
  /** The text of the init that replaced it. */
  initText: string;
  at: number;
}

class Target implements SyncTarget {
  state: EditorState;
  composing = false;
  hasFocus = false;
  constructor(state: EditorState) {
    this.state = state;
  }
  dispatch(tr: Transaction): void {
    if (tr.startState !== this.state)
      throw new Error('headless panel: a transaction for a state that is no longer current');
    this.state = tr.state;
  }
}

export class HeadlessPanel {
  readonly toHost: { at: number; message: PanelToHost }[] = [];
  readonly toPanel: { at: number; message: HostToPanel }[] = [];
  readonly sync: PanelSync;
  target: Target | null = null;
  readonly notices: ResyncNotice[] = [];
  readonly faults: PanelFault[] = [];
  inits = 0;
  resyncInits = 0;
  closed = false;
  /** A close was asked for and is waiting on the flush. */
  closing = false;
  /** Every message posted to this panel, for checks. */
  readonly received: HostToPanel[] = [];
  /** The panel's text when it posted its latest push: the document's text once that push lands. */
  pushedText: string | null = null;
  private pendingDrop: string[] = [];
  private pendingInitText = '';

  constructor(
    readonly id: string,
    private readonly clock: FakeClock,
  ) {
    this.sync = new PanelSync({
      post: (message) => {
        if (message.type === 'push') this.pushedText = this.text;
        this.toHost.push({ at: this.clock.now(), message });
      },
      schedule: clock,
      onResync: (reason, dropped) => {
        this.notices.push({
          reason,
          dropped,
          droppedText: dropped ? this.pendingDrop : [],
          initText: this.pendingInitText,
          at: this.clock.now(),
        });
      },
      onFault: (fault) => this.faults.push(fault),
    });
  }

  get text(): string | null {
    return this.target ? this.target.state.doc.toString() : null;
  }

  get version(): number | null {
    return this.target ? getSyncedVersion(this.target.state) : null;
  }

  sendReady(): void {
    this.toHost.push({ at: this.clock.now(), message: { type: 'ready', protocol: PROTOCOL } });
  }

  /** The host posted a message to this panel. */
  post(message: HostToPanel): void {
    this.received.push(message);
    if (!this.closed) this.toPanel.push({ at: this.clock.now(), message });
  }

  /** Delivers the next host message, as the boot code would. */
  deliverNext(): void {
    const item = this.toPanel.shift();
    if (!item) return;
    const m = item.message;
    if (m.type === 'init') {
      this.onInit(m as InitMessage);
      return;
    }
    this.sync.handle(m);
  }

  /** Drops the next host message without anyone knowing (a lost message). */
  dropNext(): HostToPanel | null {
    const item = this.toPanel.shift();
    return item ? item.message : null;
  }

  // ---------------------------------------------------------------------------
  // The user working in the panel

  /** Types `text` at `pos`, one character per transaction, as typing does. */
  type(pos: number, text: string): void {
    const t = this.target!;
    let at = pos;
    for (const ch of Array.from(text)) {
      this.local({ changes: { from: at, insert: ch }, selection: { anchor: at + ch.length }, userEvent: 'input.type' });
      at += ch.length;
    }
    void t;
  }

  paste(pos: number, text: string): void {
    this.local({ changes: { from: pos, insert: text }, userEvent: 'input.paste' });
  }

  delete(from: number, to: number): void {
    this.local({ changes: { from, to }, userEvent: to - from <= 1 ? 'delete.backward' : 'delete.selection' });
  }

  /** A programmatic change (a command, a checkbox, a table cell). */
  command(from: number, to: number, insert: string): void {
    this.local({ changes: { from, to, insert } });
  }

  blur(): void {
    if (this.target) this.target.hasFocus = false;
    void this.sync.flush();
  }

  focus(): void {
    if (this.target) this.target.hasFocus = true;
    this.sync.focused();
  }

  compositionStart(): void {
    if (!this.target) return;
    this.target.composing = true;
  }

  compositionEnd(): void {
    if (!this.target) return;
    this.target.composing = false;
    this.sync.compositionEnded();
  }

  /**
   * Fault: the panel's text goes wrong without collab knowing (a bug in the panel), under any
   * edits it has not had confirmed (`corruption`). The text `poison` must never reach the
   * document.
   */
  corrupt(pos: number, poison: string): void {
    const t = this.target!;
    t.state = t.state.update(corruption(t.state, pos, poison)).state;
  }

  /** The panel has asked the host for a resync and the init has not come (PanelSync's resync). */
  get resyncAsked(): boolean {
    const g = this.syncState;
    return g !== null && g.resyncReason !== null;
  }

  /** A push was refused as stale and the panel waits for the updates it lacks before pushing again. */
  get staleWaiting(): boolean {
    const g = this.syncState;
    return g !== null && g.staleWaitVersion !== null;
  }

  private get syncState(): { resyncReason: unknown; staleWaitVersion: unknown } | null {
    return (this.sync as unknown as { gen: { resyncReason: unknown; staleWaitVersion: unknown } | null }).gen;
  }

  close(): void {
    this.closed = true;
    this.sync.dispose();
  }

  private local(spec: TransactionSpec): void {
    const t = this.target!;
    t.dispatch(t.state.update(spec));
  }

  private onInit(m: InitMessage): void {
    this.inits++;
    if (m.reason === 'resync') this.resyncInits++;
    // What the resync may drop: the panel's whole text as it was (the notice's `dropped`
    // says whether anything unconfirmed was really discarded).
    this.pendingDrop = this.target ? [this.target.state.doc.toString()] : [];
    this.pendingInitText = m.text;
    void sendableUpdates;
    const ext = this.sync.start(m);
    const state = EditorState.create({ doc: m.text, extensions: [ext] });
    if (this.target) {
      const focus = this.target.hasFocus;
      this.target = new Target(state);
      this.target.hasFocus = focus;
    } else {
      this.target = new Target(state);
    }
    this.sync.bind(this.target);
  }
}
