// PanelSync: the panel's half of sync, on @codemirror/collab. The host is the authority; this
// panel is one of its clients. It holds unconfirmed local changes, pushes them in word-sized
// steps, replays them over whatever the host sends first, checks after every quiet update that
// its text is the host's, and once quiet after any change sends its stamp for the host to
// compare. When something is wrong it asks for a resync; until the init the view takes no
// edits (`resyncPending`).
//
// No DOM in here, and every timer comes from the injected schedule, so the core simulation
// runs it against a bare EditorState.

import { collab, getClientID, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import {
  Annotation,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Transaction,
  type Extension,
} from '@codemirror/state';
import type { ChangeSet } from '@codemirror/state';
import { errorMessage } from '../core/errors';
import { sameStamp, stampOf } from '../core/hash';
import { decodeChangeSet } from '../core/positions';
import {
  FLUSH_MS,
  type FlushMessage,
  type HostToPanel,
  type InitMessage,
  type PanelToHost,
  type PushRejectedMessage,
  type Schedule,
  type UpdateReason,
  type UpdatesMessage,
  type WireUpdate,
} from '../core/protocol';

/** One update from the host as the transaction applying it saw it: its reason and its changes. */
interface ReceivedUpdate {
  reason?: UpdateReason;
  /** On the host's text at that update's version, as the host logged it. */
  changes: ChangeSet;
}

/**
 * On every transaction that applies updates from the host: each update, in the host's order,
 * this panel's own confirmed ones included. Drawing features read it (render/outsideMark.ts).
 */
export const receivedUpdates = Annotation.define<readonly ReceivedUpdate[]>();

const lockEffect = StateEffect.define<null>();

/**
 * Set once this view has asked the host for a resync: the view is about to be replaced, so
 * it takes no edits. The state is read-only (typing and the commands do nothing, the cursor
 * stays and can move) until the init brings a fresh state.
 */
const resyncLock = StateField.define<boolean>({
  create: () => false,
  update: (locked, tr) => locked || tr.effects.some((e) => e.is(lockEffect)),
  // Only a true is given, at the highest precedence, so Rich view's own read-only setting is untouched.
  provide: (field) =>
    Prec.highest(EditorState.readOnly.computeN([field], (state) => (state.field(field) ? [true] : []))),
});

/**
 * True while this view has asked for a resync and the init has not come. Code that edits the
 * document without going through `state.readOnly` (a checkbox, a table cell, an image link
 * arriving late) does nothing then.
 */
export function resyncPending(state: EditorState): boolean {
  return state.field(resyncLock, false) ?? false;
}

/** After this long without a keystroke, typing is pushed. */
const IDLE_MS = 400;
/** Typing older than this is pushed even while typing continues. */
const OLDEST_MS = 2000;
/** After a stale answer, how long to wait for the updates the panel is missing. */
export const STALE_WAIT_MS = 1000;
/** A push with no answer for this long means a message was lost: resync. */
export const PUSH_ANSWER_MS = 5000;
/** A resync request with no init for this long is sent again. */
const RESYNC_RETRY_MS = 3000;
/** While a composition holds host messages back, how often to look whether it is over. */
const COMPOSITION_POLL_MS = 250;
/** After this long with no change to the view's text and nothing on its way, its stamp goes to the host to compare. */
export const CHECK_MS = 1000;

/** What sync needs of the editor. An EditorView satisfies it. */
export interface SyncTarget {
  readonly state: EditorState;
  dispatch(tr: Transaction): void;
  /** True during IME composition (EditorView.composing). */
  readonly composing?: boolean;
  /** EditorView.hasFocus. */
  readonly hasFocus?: boolean;
}

export interface PanelFault {
  kind: 'checksum' | 'gap' | 'badMessage' | 'badUpdate' | 'ownMismatch' | 'diverged' | 'rejected' | 'noAnswer';
  detail: string;
  panelText?: string;
}

interface PanelSyncOptions {
  post(message: PanelToHost): void;
  schedule: Schedule;
  /**
   * A new init was started after an earlier one (a resync). `dropped` is true when local
   * changes that are not in the document were discarded: the notice must say so. Those are
   * the changes not yet sent when this view asked for the resync, and a push then in flight
   * unless the host was seen to apply it; for a resync the host started, whatever was
   * unconfirmed. Not called when the view already held exactly the init's text.
   */
  onResync?(reason: string, dropped: boolean): void;
  /**
   * Something is wrong between this panel and the host. A resync has been asked for. Show
   * "The view was reloaded from the document. Nothing was written to the file." with "Open log".
   */
  onFault?(fault: PanelFault): void;
}

type TimerName = 'idle' | 'oldest' | 'stale' | 'answer' | 'resync' | 'check';

/**
 * What the view held when it asked for a resync, and what has been heard since of the push
 * then in flight. The host answers that push before the resync request (messages keep their
 * order both ways), so by the time the init comes the panel normally knows whether it landed.
 */
interface Held {
  /** Unconfirmed local updates the view held then. */
  total: number;
  /** Of those, the ones in the pushes in flight, as sent (JSON), in order. */
  inFlight: string[];
  /** How many of `inFlight` the host has been seen to apply since. */
  applied: number;
  /** The host refused that push, or applied something else under this view's id. */
  refused: boolean;
  /** The host's log version heard up to. */
  version: number;
}

/** A push in flight: its updates as sent (JSON), and how many of them the host has confirmed. */
interface Push {
  count: number;
  confirmed: number;
  json: string[];
}

class Generation {
  /**
   * Pushes in flight, oldest first. A push goes once every push before it has been answered; the
   * answers can wait in the queue behind an open composition, so more than one can be in flight.
   */
  pushes: Push[] = [];
  /** A push was wanted while one could not be sent (in flight, or waiting for updates after `stale`). */
  pushDue = false;
  oldestUnsentAt: number | null = null;
  /** After `stale`: the host's version the panel must reach before pushing again. */
  staleWaitVersion: number | null = null;
  /** Set once a resync has been asked for: nothing more is pushed or applied. */
  resyncReason: string | null = null;
  /** Set with `resyncReason`. */
  held: Held | null = null;
  /** The text changed, here or by the host's updates, since the last `check` was sent. */
  checkDue = false;
  timers = new Map<TimerName, unknown>();
  constructor(
    readonly clientId: string,
    readonly startVersion: number,
  ) {}
}

interface FlushWaiter {
  resolve(clean: boolean): void;
  timer: unknown;
}

/**
 * Usage, for each init: `const ext = sync.start(init)`; build a fresh state with `ext` in its
 * extensions; give it to the view (`view.setState(state)`); `sync.bind(view)`. Route
 * `updates`, `pushRejected` and `flush` to `handle`. Call `flush()` whenever the user is about
 * to act outside the page (reports.ts), `compositionEnded()` on compositionend, and
 * `focused()` on focus.
 */
export class PanelSync {
  private gen: Generation | null = null;
  private target: SyncTarget | null = null;
  private queue: (UpdatesMessage | PushRejectedMessage | FlushMessage)[] = [];
  private draining = false;
  private receiving = false;
  /** While `receiving`: what the transaction being built is told about the updates it applies. */
  private incoming: readonly ReceivedUpdate[] | null = null;
  private kicked = false;
  private composeTimer: unknown = null;
  private flushWaiters = new Set<FlushWaiter>();
  private disposed = false;

  constructor(private readonly options: PanelSyncOptions) {}

  /**
   * Call with each init. Returns the extension for a fresh EditorState at that version under
   * that client id. A later init (a resync) is announced through `onResync`, unless the view
   * already holds exactly the init's text: then nothing is lost and nothing changes on screen.
   */
  start(init: { clientId: string; version: number; reason?: InitMessage['reason']; text?: string }): Extension {
    const prev = this.gen;
    let dropped = false;
    let unchanged = false;
    if (prev && this.isCurrent(prev)) {
      const state = this.target!.state;
      unchanged = typeof init.text === 'string' && state.doc.toString() === init.text;
      dropped = !unchanged && lostLocalEdits(prev, state);
    }
    if (prev) this.clearTimers(prev);
    const gen = new Generation(init.clientId, init.version);
    this.gen = gen;
    // Updates and answers queued before this init are covered by its text. Flush requests still need an answer.
    this.queue = this.queue.filter((m) => m.type === 'flush');
    if ((prev || init.reason === 'resync') && !unchanged)
      this.options.onResync?.(prev?.resyncReason ?? 'the host reloaded this view', dropped);
    return [
      resyncLock,
      collab({ startVersion: init.version, clientID: init.clientId }),
      EditorState.transactionExtender.of((tr) => {
        if (this.receiving) return this.incoming ? { annotations: receivedUpdates.of(this.incoming) } : null;
        this.observe(gen, tr);
        return null;
      }),
    ];
  }

  /** The editor whose state holds the extension from `start`. Call after each state swap. */
  bind(target: SyncTarget): void {
    if (this.disposed) return;
    this.target = target;
    // An init is checked like any change: an update lost right after it would go unnoticed.
    if (this.gen) this.textChanged(this.gen);
    this.drain();
    this.pushNow();
    this.checkFlushes();
  }

  /** Route these host messages here: updates, pushRejected, flush. Returns false for any other type. */
  handle(message: HostToPanel): boolean {
    if (this.disposed) return false;
    if (message.type !== 'updates' && message.type !== 'pushRejected' && message.type !== 'flush') return false;
    this.queue.push(message as UpdatesMessage | PushRejectedMessage | FlushMessage);
    this.drain();
    return true;
  }

  /** Sends anything unsent. Resolves true once nothing is unconfirmed, false after FLUSH_MS. */
  flush(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: FlushWaiter = {
        resolve,
        timer: this.options.schedule.setTimeout(() => {
          this.flushWaiters.delete(waiter);
          resolve(false);
        }, FLUSH_MS),
      };
      this.flushWaiters.add(waiter);
      this.pushNow();
      this.checkFlushes();
    });
  }

  hasUnconfirmed(): boolean {
    if (!this.target) return false;
    return sendableUpdates(this.target.state).length > 0;
  }

  /** IME composition ended: queued host messages are applied and unsent typing is pushed. */
  compositionEnded(): void {
    if (this.disposed) return;
    this.drain();
    this.pushNow();
  }

  /** The view regained focus: its stamp goes to the host now if the text changed since the last check. */
  focused(): void {
    if (this.disposed || !this.gen) return;
    this.sendCheck(this.gen);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.gen) this.clearTimers(this.gen);
    if (this.composeTimer !== null) this.options.schedule.clearTimeout(this.composeTimer);
    for (const w of this.flushWaiters) {
      this.options.schedule.clearTimeout(w.timer);
      w.resolve(false);
    }
    this.flushWaiters.clear();
    this.queue = [];
    this.gen = null;
    this.target = null;
  }

  // ---------------------------------------------------------------------------
  // Local changes and pushing

  private observe(gen: Generation, tr: Transaction): void {
    if (gen !== this.gen || this.receiving || this.disposed || !tr.docChanged) return;
    const now = this.options.schedule.now();
    if (gen.oldestUnsentAt === null) {
      gen.oldestUnsentAt = now;
      this.arm(gen, 'oldest', OLDEST_MS, () => this.pushNow());
    }
    this.arm(gen, 'idle', IDLE_MS, () => this.pushNow());
    this.textChanged(gen);
    if (!isPlainTyping(tr) || endsWord(tr)) this.kick();
  }

  /** A check is due, CHECK_MS after the latest change. */
  private textChanged(gen: Generation): void {
    gen.checkDue = true;
    this.arm(gen, 'check', CHECK_MS, () => this.sendCheck(gen));
  }

  /**
   * Sends the stamp of the view's text at its synced version, for the host to compare with the
   * document's, if the text changed since the last check and nothing is on its way: nothing
   * unconfirmed, no push answer awaited, no resync asked for. What is on its way arms the check
   * again when it lands; a composition is looked at again after CHECK_MS.
   */
  private sendCheck(gen: Generation): void {
    const t = this.target;
    if (gen !== this.gen || !gen.checkDue || !t || !this.isCurrent(gen) || gen.resyncReason !== null) return;
    if (t.composing) {
      this.arm(gen, 'check', CHECK_MS, () => this.sendCheck(gen));
      return;
    }
    if (gen.pushes.length > 0 || gen.staleWaitVersion !== null || sendableUpdates(t.state).length > 0) return;
    gen.checkDue = false;
    this.clear(gen, 'check');
    const stamp = stampOf(t.state.doc);
    this.options.post({
      type: 'check',
      clientId: gen.clientId,
      version: getSyncedVersion(t.state),
      length: stamp.length,
      hash: stamp.hash,
    });
  }

  /** Push once the current dispatch has finished. */
  private kick(): void {
    if (this.kicked) return;
    this.kicked = true;
    void Promise.resolve().then(() => {
      this.kicked = false;
      this.pushNow();
    });
  }

  /**
   * Sends what is unsent, unless a push in flight has no answer yet or it waits for updates after
   * `stale`. An open composition does not hold it back: what the input method has composed so far
   * is in the view's text, and sending it changes nothing on the page. While host messages wait
   * behind the composition, the push is made as the view will be once it has taken them (ahead),
   * so it names the host's version and the host takes it.
   */
  private pushNow(): void {
    const gen = this.gen;
    const t = this.target;
    if (this.disposed || !gen || !t || !this.isCurrent(gen) || gen.resyncReason !== null) return;
    const waiting = this.queue.length > 0 ? this.ahead(gen, t) : null;
    if ((gen.pushes.length > 0 && waiting?.answered !== true) || gen.staleWaitVersion !== null) {
      gen.pushDue = true;
      return;
    }
    const state = waiting?.state ?? t.state;
    const ups = sendableUpdates(state);
    gen.pushDue = false;
    gen.oldestUnsentAt = null;
    this.clear(gen, 'idle');
    this.clear(gen, 'oldest');
    if (ups.length === 0) {
      this.checkFlushes();
      return;
    }
    const json = ups.map((u) => u.changes.toJSON());
    gen.pushes.push({ count: ups.length, confirmed: 0, json: json.map((j) => JSON.stringify(j)) });
    const noAnswer = () => {
      // Answers may be waiting in the queue behind an IME composition: that is not a lost message.
      if (this.queue.length > 0) {
        this.arm(gen, 'answer', PUSH_ANSWER_MS, noAnswer);
        return;
      }
      this.requestResync('a push was never answered', {
        kind: 'noAnswer',
        detail: `no answer to a push of ${ups.length} updates`,
      });
    };
    this.arm(gen, 'answer', PUSH_ANSWER_MS, noAnswer);
    this.options.post({
      type: 'push',
      clientId: gen.clientId,
      baseVersion: getSyncedVersion(state),
      updates: json,
      expect: stampOf(state.doc),
    });
  }

  /**
   * The view's state as it will be once it has taken the host's updates waiting in the queue,
   * received message by message as onUpdates receives them, made without touching the view; and
   * whether every push in flight is answered there, by the host's copies of its updates or by a
   * refusal. Null when no update waits, or the waiting ones end in a resync (a gap, a malformed
   * update, one under this view's id it did not send). One message at a time, since unconfirmed
   * changes mapped over several updates composed can fall elsewhere than mapped over each in turn.
   */
  private ahead(gen: Generation, t: SyncTarget): { state: EditorState; answered: boolean } | null {
    let state = t.state;
    // The next push in flight the queue answers, and how many of its updates it has confirmed.
    let next = 0;
    let confirmed = gen.pushes[0]?.confirmed ?? 0;
    const answer = () => {
      next++;
      confirmed = gen.pushes[next]?.confirmed ?? 0;
    };
    this.receiving = true;
    try {
      for (const m of this.queue) {
        if (m.type === 'flush') continue;
        if (m.type === 'pushRejected') {
          if (m.clientId !== gen.clientId) continue;
          if (m.reason !== 'stale') return null;
          if (next < gen.pushes.length) answer();
          continue;
        }
        const version = getSyncedVersion(state);
        if (
          !Array.isArray(m.updates) ||
          !Number.isInteger(m.fromVersion) ||
          m.fromVersion + m.updates.length !== m.version ||
          m.fromVersion > version
        )
          return null;
        const decoded: { changes: ChangeSet; clientID: string }[] = [];
        for (const u of m.updates.slice(version - m.fromVersion)) {
          const changes = decodeChangeSet(u?.changes);
          if (!changes || typeof u.clientId !== 'string') return null;
          if (u.clientId === gen.clientId) {
            const push = gen.pushes[next];
            if (!push || JSON.stringify(u.changes) !== push.json[confirmed]) return null;
            if (++confirmed >= push.count) answer();
          }
          decoded.push({ changes, clientID: u.clientId });
        }
        if (decoded.length > 0) state = receiveUpdates(state, decoded).state;
      }
    } catch {
      return null;
    } finally {
      this.receiving = false;
    }
    return state === t.state ? null : { state, answered: next >= gen.pushes.length };
  }

  // ---------------------------------------------------------------------------
  // Host messages, strictly in order

  private drain(): void {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const gen = this.gen;
        const t = this.target;
        if (!gen || !t || !this.isCurrent(gen)) break;
        if (t.composing && changesText(gen, t, this.queue[0]!)) {
          this.watchComposition();
          // An answer waiting here behind the composition still answers its push.
          if (gen.pushDue) this.pushNow();
          break;
        }
        const m = this.queue.shift()!;
        if (m.type === 'updates') this.onUpdates(gen, t, m);
        else if (m.type === 'pushRejected') this.onRejected(gen, t, m);
        else this.onFlushRequest(m);
      }
    } finally {
      this.draining = false;
    }
  }

  private onUpdates(gen: Generation, t: SyncTarget, m: UpdatesMessage): void {
    if (gen.resyncReason !== null) {
      this.heardAfterRequest(gen, m);
      return;
    }
    if (
      !Array.isArray(m.updates) ||
      !Number.isInteger(m.fromVersion) ||
      m.fromVersion + m.updates.length !== m.version
    ) {
      this.requestResync('a malformed message from the host', {
        kind: 'badMessage',
        detail: 'updates message does not add up',
      });
      return;
    }
    const v = getSyncedVersion(t.state);
    if (m.fromVersion > v) {
      this.requestResync('a message from the host was missed', {
        kind: 'gap',
        detail: `at version ${v}, updates start at ${m.fromVersion}`,
      });
      return;
    }
    const fresh: WireUpdate[] = m.updates.slice(v - m.fromVersion);
    if (fresh.length > 0) {
      const decoded: { changes: ChangeSet; clientID: string }[] = [];
      for (const u of fresh) {
        const cs = decodeChangeSet(u?.changes);
        if (!cs || typeof u.clientId !== 'string') {
          this.requestResync('a malformed update from the host', {
            kind: 'badUpdate',
            detail: 'an update is not a change set',
          });
          return;
        }
        decoded.push({ changes: cs, clientID: u.clientId });
      }
      // The host's copies of this panel's own updates confirm the pushes in flight, in order. They
      // must be exactly what was sent: collab confirms by client id and order alone.
      let own = 0;
      for (const u of fresh) {
        if (u.clientId !== gen.clientId) continue;
        if (JSON.stringify(u.changes) !== sentAt(gen, own)) {
          this.requestResync('the host confirmed a change this view did not send', {
            kind: 'ownMismatch',
            detail: "an update under this view's id does not match its push",
          });
          return;
        }
        own++;
      }
      // The updates must fit: the first applies to the host's text at this version, which is
      // the panel's text with its unconfirmed changes undone, and each to the one before.
      const unconfirmed = sendableUpdates(t.state);
      let length = unconfirmed.length > 0 ? unconfirmed[0]!.changes.length : t.state.doc.length;
      const localEnd =
        unconfirmed.length > 0 ? unconfirmed[unconfirmed.length - 1]!.changes.newLength : t.state.doc.length;
      let fits = localEnd === t.state.doc.length;
      for (const u of decoded) {
        if (u.changes.length !== length) fits = false;
        length = u.changes.newLength;
      }
      if (!fits) {
        this.requestResync("an update did not fit this view's text", {
          kind: 'badUpdate',
          detail: 'an update is for a text of another length',
          panelText: t.state.doc.toString(),
        });
        return;
      }
      let tr: Transaction | null = null;
      let failure = '';
      this.receiving = true;
      this.incoming = fresh.map((u, i) =>
        u.reason ? { reason: u.reason, changes: decoded[i]!.changes } : { changes: decoded[i]!.changes },
      );
      try {
        tr = receiveUpdates(t.state, decoded);
        void tr.state; // CodeMirror applies the changes lazily; make any fault happen here
      } catch (error) {
        tr = null;
        failure = errorMessage(error);
      } finally {
        this.receiving = false;
        this.incoming = null;
      }
      // Asked for outside the receiving window: the request locks the view with a transaction of its own.
      if (!tr) {
        this.requestResync("an update did not fit this view's text", {
          kind: 'badUpdate',
          detail: failure,
          panelText: t.state.doc.toString(),
        });
        return;
      }
      t.dispatch(tr);
      this.textChanged(gen);
      for (let left = own; left > 0 && gen.pushes.length > 0;) {
        const push = gen.pushes[0]!;
        const n = Math.min(left, push.count - push.confirmed);
        push.confirmed += n;
        left -= n;
        if (push.confirmed >= push.count) gen.pushes.shift();
      }
      if (own > 0 && gen.pushes.length === 0) this.clear(gen, 'answer');
      this.moveCursorAfterHistory(gen, t, fresh, decoded);
    }
    if (gen.staleWaitVersion !== null && getSyncedVersion(t.state) >= gen.staleWaitVersion) {
      gen.staleWaitVersion = null;
      this.clear(gen, 'stale');
    }
    // Checksum: when quiet and level with the host, the texts must be identical.
    if (sendableUpdates(t.state).length === 0 && getSyncedVersion(t.state) === m.version) {
      if (!sameStamp(stampOf(t.state.doc), { length: m.length, hash: m.hash })) {
        const text = t.state.doc.toString();
        this.requestResync('the view and the document differed', {
          kind: 'checksum',
          detail: `version ${m.version}: host length ${m.length}, view length ${text.length}`,
          panelText: text,
        });
        return;
      }
    }
    if (gen.pushDue) this.pushNow();
    this.checkFlushes();
  }

  private onRejected(gen: Generation, t: SyncTarget, m: PushRejectedMessage): void {
    if (m.clientId !== gen.clientId) return; // meant for an earlier init
    if (gen.resyncReason !== null) {
      // The push that was in flight when the resync was asked for did not land.
      if (gen.held) gen.held.refused = true;
      return;
    }
    // Answers come in the order of the pushes: the oldest in flight is the one refused.
    gen.pushes.shift();
    if (gen.pushes.length === 0) this.clear(gen, 'answer');
    switch (m.reason) {
      case 'stale':
        // Messages arrive in order, so the updates that made the push stale came first.
        if (getSyncedVersion(t.state) >= m.version) {
          this.pushNow();
        } else {
          gen.staleWaitVersion = m.version;
          gen.pushDue = true;
          this.arm(gen, 'stale', STALE_WAIT_MS, () => {
            if (this.gen === gen && gen.staleWaitVersion !== null) {
              this.requestResync('updates from the host did not arrive', {
                kind: 'gap',
                detail: `waiting for version ${gen.staleWaitVersion}`,
              });
            }
          });
        }
        break;
      case 'diverged':
        this.requestResync('the view and the document differed', {
          kind: 'diverged',
          detail: "the host found that a push would not produce this view's text",
          panelText: t.state.doc.toString(),
        });
        break;
      default:
        this.requestResync(`a push was refused (${m.reason})`, { kind: 'rejected', detail: `refused as ${m.reason}` });
        break;
    }
    this.checkFlushes();
  }

  private onFlushRequest(m: FlushMessage): void {
    void this.flush().then((clean) => {
      if (!this.disposed) this.options.post({ type: 'flushed', id: m.id, clean });
    });
  }

  /** Undo and redo from VS Code move the cursor to the end of what changed, in the focused panel only. */
  private moveCursorAfterHistory(
    gen: Generation,
    t: SyncTarget,
    fresh: WireUpdate[],
    decoded: { changes: ChangeSet; clientID: string }[],
  ): void {
    if (!t.hasFocus) return;
    let k = -1;
    for (let i = fresh.length - 1; i >= 0; i--) {
      if ((fresh[i]!.reason === 'undo' || fresh[i]!.reason === 'redo') && fresh[i]!.clientId !== gen.clientId) {
        k = i;
        break;
      }
    }
    if (k < 0) return;
    let pos = -1;
    decoded[k]!.changes.iterChangedRanges((_fA, _tA, _fB, toB) => {
      pos = toB;
    });
    if (pos < 0) return;
    for (let j = k + 1; j < decoded.length; j++) pos = decoded[j]!.changes.mapPos(pos, 1);
    for (const u of sendableUpdates(t.state)) pos = u.changes.mapPos(pos, 1);
    pos = Math.max(0, Math.min(pos, t.state.doc.length));
    t.dispatch(t.state.update({ selection: { anchor: pos }, scrollIntoView: true }));
  }

  private requestResync(reason: string, fault?: PanelFault): void {
    const gen = this.gen;
    if (!gen || gen.resyncReason !== null || this.disposed) return;
    gen.resyncReason = reason;
    const t = this.target;
    const current = !!t && this.isCurrent(gen);
    if (current) {
      gen.held = {
        total: sendableUpdates(t.state).length,
        inFlight: gen.pushes.flatMap((p) => p.json.slice(p.confirmed)),
        applied: 0,
        refused: false,
        version: getSyncedVersion(t.state),
      };
    }
    gen.pushes = [];
    for (const name of ['idle', 'oldest', 'stale', 'answer', 'check'] as const) this.clear(gen, name);
    if (fault) {
      this.options.onFault?.(fault);
      const msg: PanelToHost = { type: 'fault', kind: fault.kind, detail: fault.detail };
      if (fault.panelText !== undefined) (msg as { panelText?: string }).panelText = fault.panelText;
      this.options.post(msg);
    }
    this.options.post({ type: 'resyncRequest', reason });
    const again = () => {
      if (this.gen !== gen || this.disposed) return;
      this.options.post({ type: 'resyncRequest', reason });
      this.arm(gen, 'resync', RESYNC_RETRY_MS, again);
    };
    this.arm(gen, 'resync', RESYNC_RETRY_MS, again);
    // Nothing typed from here on could be kept: the view stops taking edits until the init.
    if (current) t!.dispatch(t!.state.update({ effects: lockEffect.of(null) }));
  }

  /**
   * An `updates` message after the resync request: nothing is applied, but the host's copies
   * of this view's own updates say the push that was in flight has landed.
   */
  private heardAfterRequest(gen: Generation, m: UpdatesMessage): void {
    const held = gen.held;
    if (!held || held.inFlight.length === 0 || !Array.isArray(m.updates) || !Number.isInteger(m.fromVersion)) return;
    m.updates.forEach((u, i) => {
      if (m.fromVersion + i < held.version || u?.clientId !== gen.clientId) return; // heard before, or not this view's
      if (held.applied < held.inFlight.length && JSON.stringify(u.changes) === held.inFlight[held.applied])
        held.applied++;
      else held.refused = true;
    });
    held.version = Math.max(held.version, m.fromVersion + m.updates.length);
  }

  // ---------------------------------------------------------------------------
  // Helpers

  /** The bound editor holds this generation's state (not one from before the last init). */
  private isCurrent(gen: Generation): boolean {
    if (!this.target) return false;
    return getClientID(this.target.state) === gen.clientId;
  }

  private checkFlushes(): void {
    if (this.flushWaiters.size === 0 || this.hasUnconfirmed()) return;
    for (const w of this.flushWaiters) {
      this.options.schedule.clearTimeout(w.timer);
      w.resolve(true);
    }
    this.flushWaiters.clear();
  }

  private watchComposition(): void {
    if (this.composeTimer !== null || this.disposed) return;
    this.composeTimer = this.options.schedule.setTimeout(() => {
      this.composeTimer = null;
      if (this.target?.composing) {
        this.watchComposition();
        return;
      }
      this.drain();
      this.pushNow();
    }, COMPOSITION_POLL_MS);
  }

  private arm(gen: Generation, name: TimerName, ms: number, fn: () => void): void {
    this.clear(gen, name);
    gen.timers.set(
      name,
      this.options.schedule.setTimeout(() => {
        gen.timers.delete(name);
        if (this.gen === gen && !this.disposed) fn();
      }, ms),
    );
  }

  private clear(gen: Generation, name: TimerName): void {
    const h = gen.timers.get(name);
    if (h !== undefined) {
      this.options.schedule.clearTimeout(h);
      gen.timers.delete(name);
    }
  }

  private clearTimers(gen: Generation): void {
    for (const h of gen.timers.values()) this.options.schedule.clearTimeout(h);
    gen.timers.clear();
  }
}

/**
 * Whether a resync of the view in `state` (of generation `gen`) throws away local edits that
 * are not in the document. Called only when the init's text differs from the view's.
 */
function lostLocalEdits(gen: Generation, state: EditorState): boolean {
  const unconfirmed = sendableUpdates(state).length;
  const held = gen.held;
  // The host reloaded the view on its own: it answers a push before sending an init, so
  // whatever is still unconfirmed never landed.
  if (gen.resyncReason === null || !held) return unconfirmed > 0;
  // Changed after the request (only code that ignores the lock can), or not yet sent then.
  if (unconfirmed > held.total || held.total > held.inFlight.length) return true;
  // The push in flight then: kept only when the host was seen to apply all of it.
  return held.inFlight.length > 0 && (held.refused || held.applied < held.inFlight.length);
}

/** The `k`th update in flight that the host has not confirmed, as sent (JSON), from the oldest push. */
function sentAt(gen: Generation, k: number): string | undefined {
  for (const push of gen.pushes) {
    const left = push.count - push.confirmed;
    if (k < left) return push.json[push.confirmed + k];
    k -= left;
  }
  return undefined;
}

/**
 * Whether applying host message `m` could change the view's text, which would break an input
 * method's composition in it: an update from anyone else, or anything that ends in a resync,
 * whose init replaces the text (a message that does not add up, a gap, a push refused for any
 * reason but `stale`). The host's copies of this view's own updates, a flush request and a
 * `stale` refusal leave the text as it is, so a composition does not hold them back.
 */
function changesText(gen: Generation, t: SyncTarget, m: UpdatesMessage | PushRejectedMessage | FlushMessage): boolean {
  if (m.type === 'flush') return false;
  if (m.type === 'pushRejected') return m.clientId === gen.clientId && m.reason !== 'stale';
  if (!Array.isArray(m.updates) || !Number.isInteger(m.fromVersion)) return true;
  const v = getSyncedVersion(t.state);
  if (m.fromVersion > v) return true;
  return m.updates.slice(v - m.fromVersion).some((u) => u?.clientId !== gen.clientId);
}

/** Typing one character, or deleting one: pushed by word, not by keystroke. */
function isPlainTyping(tr: Transaction): boolean {
  if (!(tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward') || tr.isUserEvent('delete.forward')))
    return false;
  let deleted = 0;
  tr.changes.iterChanges((fromA, toA) => {
    deleted += toA - fromA;
  });
  return deleted <= 2; // one character, or one surrogate pair
}

const WORD_END = /[\s.,;:!?)\]}"]/;

/** Typed text that ends a word: whitespace, a newline, or closing punctuation. */
function endsWord(tr: Transaction): boolean {
  let last = '';
  tr.changes.iterChanges((_fA, _tA, _fB, _tB, inserted) => {
    if (inserted.length > 0) last = inserted.sliceString(inserted.length - 1);
  });
  return last !== '' && WORD_END.test(last);
}
