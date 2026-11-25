// The panel's boot (docs/ARCHITECTURE.md, "Boot"): a `Panel` builds the page skeleton, joins the
// editor to PanelSync, routes the host's messages in the order they arrive, records content-policy
// violations and answers Verify File's stamp requests. The failure page, the lost-contact warning,
// the message strip, the reports to the host, scroll sync and the test hook live beside it.
//
// For each `init`: `sync.start(init)`, then a fresh editor state with that extension in the
// view, then `sync.bind(view)`. The first init creates the view; every later one is a resync:
// a fresh state at the new version, the selection carried across with
// `diffChanges(oldText, newText)` and the scroll position kept. A resync that loses nothing
// shows nothing (it is logged); one that loses typing shows it, with Copy text, and one that
// loses a deletion says the deleted text is back. A lost edit of spaces or line breaks alone
// is logged.

import { getSyncedVersion } from '@codemirror/collab';
import { ChangeSet, type EditorState, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { diffChanges } from '../core/diff';
import { errorMessage } from '../core/errors';
import type { StampMessage, StampRequestMessage } from '../core/featureProtocol';
import { stampOf } from '../core/hash';
import {
  PROTOCOL,
  systemSchedule,
  type HostToPanel,
  type InitMessage,
  type Mode,
  type NoticeMessage,
  type ViewState,
} from '../core/protocol';
import { runCommand } from './commands/registry';
import { ContactWatch } from './contact';
import { createPanelContext, type HostBridge, type PanelContextHandle, type PanelSlots } from './context';
import { copyAction } from './copyText';
import { createEditorState, createEditorView } from './editor';
import { showFailurePage } from './failurePage';
import { lostEdit, lostNotice, type LostEdit } from './lostText';
import { treeFor } from './markdown/tree';
import { MessageStrip, stripMessageOf } from './messageStrip';
import { getMode, setModeEffect } from './modes';
import { PanelReports, viewStateOf, type Listen } from './reports';
import { ScrollFollow } from './scrollFollow';
import { PanelSync, resyncPending } from './sync';
import { commitOpenField } from './tables/cellEdit';
import { setTabShown, tabShownField } from './tabShown';
import { TestHook } from './testHook';

/** How far the first cursor search parses, and for how long, before it settles for what is parsed. */
const FIRST_CURSOR_PARSE_CHARS = 50_000;
const FIRST_CURSOR_PARSE_MS = 50;

export interface PanelHandle {
  dispose(): void;
}

/** Boots the panel into `root`. Everything the panel draws lives inside it. */
export function bootPanel(bridge: HostBridge, root: HTMLElement): PanelHandle {
  const panel = new Panel(bridge, root);
  return { dispose: () => panel.dispose() };
}

/** One panel, from its skeleton and the first init to its close or its failure page. */
class Panel {
  private readonly doc: Document;
  private readonly win: Window;
  private ctx: PanelContextHandle | null = null;
  private view: EditorView | null = null;
  private started = false;
  private failed = false;
  private disposed = false;
  private readOnly = false;
  /** Whether the tab is shown, as the host last said; each new state starts from it. */
  private tabShown = true;
  /** What the view loses to the init now starting, read just before a resync starts. */
  private lostNow: LostEdit | null = null;
  /** Created by the first init when the extension runs under its in-VS-Code suite. */
  private testHook: TestHook | null = null;
  /** Host messages that arrived before the first init, replayed after it. */
  private readonly early: HostToPanel[] = [];
  private readonly cspViolations: string[] = [];
  private readonly cleanups: (() => void)[] = [];
  private readonly slots: PanelSlots;
  /** The message strip and its place in the page. */
  private readonly strip: MessageStrip;
  private readonly messageSlot: HTMLElement;
  private readonly contact: ContactWatch;
  private readonly sync: PanelSync;
  private readonly reports: PanelReports;
  private readonly scroll: ScrollFollow;

  constructor(
    private readonly bridge: HostBridge,
    private readonly root: HTMLElement,
  ) {
    this.doc = root.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    this.messageSlot = this.doc.createElement('div');
    this.slots = this.buildSkeleton(this.messageSlot);
    this.strip = new MessageStrip(this.messageSlot, bridge, () => this.view?.focus());

    // Whatever the page's policy refuses was meant to draw something: it goes to the log, where a
    // drawing that never came can be traced.
    this.listen(this.doc, 'securitypolicyviolation', (event) =>
      this.recordViolation(event as SecurityPolicyViolationEvent),
    );

    this.contact = new ContactWatch({
      stopped: this.stopped,
      showNotice: (notice) => this.ctx?.showNotice(notice) ?? null,
      editable: () => !!this.view && !resyncPending(this.view.state),
      post: (message) => bridge.post(message),
    });
    this.cleanups.push(() => this.contact.dispose());

    this.sync = new PanelSync({
      post: (message) => {
        if (message.type === 'push' || message.type === 'resyncRequest') this.contact.watch();
        bridge.post(message);
      },
      schedule: systemSchedule,
      onResync: (reason, dropped) => this.onResync(reason, dropped),
      onFault: (fault) => {
        // PanelSync has already sent the host a `fault` with both texts; this is for the page's console.
        console.warn(`Tandem Markdown: sync fault (${fault.kind}): ${fault.detail}`);
      },
    });

    this.reports = new PanelReports({
      root,
      post: (message) => bridge.post(message),
      view: () => this.view,
      stopped: this.stopped,
      flush: () => void this.sync.flush(),
      log: (message, error) => this.ctx?.log('warn', message, error),
    });
    this.reports.listen(this.listen);
    this.scroll = new ScrollFollow({ view: () => this.view, post: (message) => bridge.post(message) });
    this.cleanups.push(() => this.scroll.dispose());
    // A view that regains focus sends its stamp if its text changed since the last check.
    this.listen(this.win, 'focus', () => this.sync.focused());

    this.cleanups.push(bridge.onMessage((message) => this.receive(message)));

    try {
      bridge.post({ type: 'ready', protocol: PROTOCOL });
    } catch (error) {
      this.fail('the host could not be told the panel is ready', error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.root.replaceChildren();
  }

  private readonly listen: Listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  };

  private readonly stopped = (): boolean => this.failed || this.disposed;

  /** The toolbar, the message strip (`messages`), the notices and the editor's place, in `root`. */
  private buildSkeleton(messages: HTMLElement): PanelSlots {
    this.root.classList.add('tm-root');
    const slots: PanelSlots = {
      toolbar: this.doc.createElement('div'),
      notices: this.doc.createElement('div'),
      editor: this.doc.createElement('div'),
    };
    slots.toolbar.className = 'tm-toolbar';
    messages.className = 'tm-messages';
    slots.notices.className = 'tm-notices';
    slots.editor.className = 'tm-editor';
    this.root.replaceChildren(slots.toolbar, messages, slots.notices, slots.editor);
    return slots;
  }

  private recordViolation(e: SecurityPolicyViolationEvent): void {
    const report = `${e.violatedDirective}: ${e.blockedURI || '(inline)'}`;
    this.cspViolations.push(report);
    this.bridge.post({
      type: 'log',
      level: 'warn',
      message: `The page's content policy refused ${report}`,
      detail: e.sample,
    });
  }

  /** A resync started: what the view lost to it is logged, and typing or a deletion lost is shown. */
  private onResync(reason: string, dropped: boolean): void {
    const lost = dropped ? this.lostNow : null;
    this.lostNow = null;
    const ctx = this.ctx;
    if (!ctx) return;
    const notice = lost && lostNotice(lost);
    if (!lost || !notice) {
      ctx.log(
        dropped ? 'warn' : 'info',
        dropped
          ? `This tab reloaded (${reason}) and lost an edit of spaces or line breaks only`
          : `This tab reloaded (${reason})`,
      );
      return;
    }
    ctx.log(
      'warn',
      notice.copy === undefined
        ? `This tab reloaded (${reason}) and lost a deletion of ${lost.restored.length} characters`
        : `This tab reloaded (${reason}) and lost ${lost.typed.length} typed characters`,
    );
    ctx.notify({
      kind: 'warning',
      sticky: true,
      text: notice.text,
      actions: notice.copy === undefined ? undefined : [copyAction(ctx, 'Copy text', notice.copy)],
    });
  }

  private fail(message: string, error?: unknown): void {
    if (this.stopped()) return;
    this.failed = true;
    const detail = error instanceof Error && error.stack ? `${message}\n${error.stack}` : message;
    try {
      // The host logs this (the same message its page guard sends when the bundle does not load).
      this.bridge.post({ type: 'startFailed', detail });
    } catch {
      // The host is unreachable; the page below still says what to do.
    }
    console.error(`Tandem Markdown: the panel could not start: ${message}`, error ?? '');
    this.teardown();
    const button = showFailurePage(this.root, () => this.bridge.post({ type: 'showSource' }));
    if (this.testHook) this.cleanups.push(this.testHook.answerAsFailurePage(this.root, button));
  }

  private onInit(m: InitMessage): void {
    if (m.testMode === true && !this.testHook) this.testHook = this.createTestHook();
    const problem = initProblem(m);
    if (problem) {
      this.fail(problem);
      return;
    }
    this.readOnly = m.readOnly || m.docInfo.readOnly;
    this.contact.clientId = m.clientId;
    const mode: Mode = this.readOnly ? 'view' : m.mode;
    if (!this.ctx)
      this.ctx = createPanelContext({ bridge: this.bridge, doc: m.docInfo, slots: this.slots, settings: m.settings });
    else this.ctx.setSettings(m.settings);
    if (!this.view) this.open(this.ctx, m, mode);
    else this.reload(this.ctx, this.view, m, mode);
  }

  private open(c: PanelContextHandle, m: InitMessage, mode: Mode): void {
    const { sync, reports, scroll, doc, win } = this;
    const ext = sync.start(m);
    const v = createEditorView({
      ctx: c,
      text: m.text,
      mode,
      sync: [ext, reports.extension, scroll.extension, this.tabShownNow()],
      parent: this.slots.editor,
    });
    this.view = v;
    const saved = m.viewState;
    if (saved) {
      v.dispatch({ selection: clampSelection(v.state, saved.selection) });
    } else {
      // A fresh open never starts inside a block that shows its source while the cursor is in it.
      const at = firstCursor(v.state);
      if (at !== 0) v.dispatch({ selection: { anchor: at } });
    }
    sync.bind(v);
    this.listen(v.scrollDOM, 'scroll', reports.viewStateSoon, { passive: true });
    this.listen(v.contentDOM, 'compositionend', () => sync.compositionEnded());
    if (saved) {
      restoreScroll(v, saved, scroll);
      // A switch from Source: carry on typing once the page has focus. A fresh open waits for a click.
      if (doc.hasFocus()) v.focus();
      else {
        const once = () => {
          win.removeEventListener('focus', once);
          if (this.view === v && !this.stopped() && (doc.activeElement === doc.body || doc.activeElement === null))
            v.focus();
        };
        win.addEventListener('focus', once);
        this.cleanups.push(() => win.removeEventListener('focus', once));
      }
    }
    reports.viewStateSoon();
  }

  private reload(c: PanelContextHandle, v: EditorView, m: InitMessage, mode: Mode): void {
    const { sync, reports, scroll } = this;
    const old = v.state;
    const oldText = old.doc.toString();
    const hadFocus = v.hasFocus;
    const top = viewStateOf(v);
    const topFrom = old.doc.line(top.topLine + 1).from;
    const diff = diffChanges(oldText, m.text);
    this.lostNow = lostEdit(old, diff);
    const ext = sync.start(m); // tells of a lost edit, unless the view already held the init's text
    this.lostNow = null;
    const changes = ChangeSet.of(diff, oldText.length);
    const main = old.selection.main.map(changes);
    v.setState(
      createEditorState({
        ctx: c,
        text: m.text,
        mode,
        sync: [ext, reports.extension, scroll.extension, this.tabShownNow()],
        selection: { anchor: main.anchor, head: main.head },
      }),
    );
    sync.bind(v);
    // The same text at the top as before, wherever the changes moved it.
    const newTop = v.state.doc.lineAt(Math.min(changes.mapPos(topFrom, 1), v.state.doc.length)).from;
    if (newTop > 0 || top.topOffsetPx > 0) scroll.showTop(newTop, top.topOffsetPx);
    if (hadFocus && !v.hasFocus) v.focus();
    reports.viewStateSoon();
  }

  /** The tab-shown field of a new state, starting from what the host last said. */
  private tabShownNow(): Extension {
    return tabShownField.init(() => this.tabShown);
  }

  private setTabShown(shown: unknown): void {
    if (typeof shown !== 'boolean') return;
    this.tabShown = shown;
    this.view?.dispatch({ effects: setTabShown.of(shown) });
  }

  private setMode(mode: unknown): void {
    const view = this.view;
    if (!view || (mode !== 'view' && mode !== 'edit')) return;
    const next: Mode = this.readOnly ? 'view' : mode;
    if (getMode(view.state) !== next) view.dispatch({ effects: setModeEffect.of(next) });
  }

  /** A notice the host asks for. It has no buttons: nothing on the host would answer one. */
  private showHostNotice(m: NoticeMessage): void {
    if (!this.ctx || typeof m.text !== 'string') return;
    const kind = m.kind === 'warning' || m.kind === 'error' ? m.kind : 'info';
    this.ctx.notify({ kind, text: m.text, sticky: !!m.sticky });
  }

  private route(m: HostToPanel): void {
    const view = this.view;
    switch (m.type) {
      case 'init':
        this.onInit(m);
        return;
      case 'updates':
      case 'pushRejected':
        this.sync.handle(m);
        return;
      case 'flush':
        // A cell being typed in is not a document change until it is committed; a save or a close must not leave it behind.
        if (view) commitOpenField(view);
        this.sync.handle(m);
        return;
      case 'setMode':
        this.setMode(m.mode);
        return;
      case 'tabShown':
        this.setTabShown(m.shown);
        return;
      case 'settings':
        if (m.settings && typeof m.settings === 'object') this.ctx?.setSettings(m.settings);
        return;
      case 'command':
        // A command can scroll the view (going to a heading from the outline), as the user's own scroll.
        this.scroll.userActed();
        if (view && typeof m.id === 'string') runCommand(view, m.id, m.args);
        return;
      case 'notice':
        this.showHostNotice(m);
        return;
      case 'messages': {
        const shown = stripMessageOf(m.shown);
        if (shown !== undefined) this.strip.show(shown, m.focus === true);
        return;
      }
      case 'reply':
        this.ctx?.handleReply(m);
        return;
      case 'scrollLink':
        this.scroll.setLinked(m.linked === true);
        return;
      case 'scrollTo':
        if (typeof m.line === 'number') this.scroll.goTo(m.line);
        return;
      case 'stampRequest':
        // Verify File: send what is unsent, then the text's stamp.
        void this.answerStamp(m);
        return;
      case 'test':
        this.testHook?.answer(m);
        return;
      default:
        // Feature messages: the features that use them listen on the bridge themselves.
        return;
    }
  }

  /** A message from the host: held until the first init, then routed in the order they came. */
  private receive(message: HostToPanel): void {
    if (this.stopped()) return;
    if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return;
    this.contact.heard(message);
    if (!this.started) {
      if (message.type !== 'init') {
        this.early.push(message);
        return;
      }
      this.started = true;
      try {
        this.route(message);
      } catch (error) {
        this.fail(errorMessage(error), error);
        return;
      }
      for (const held of this.early.splice(0)) this.deliver(held);
      return;
    }
    this.deliver(message);
  }

  private deliver(message: HostToPanel): void {
    if (this.stopped()) return;
    try {
      this.route(message);
    } catch (error) {
      if (message.type === 'init') this.fail(errorMessage(error), error);
      else if (this.ctx) this.ctx.log('error', `Handling the host's "${message.type}" message failed`, error);
      else console.error(`Tandem Markdown: handling the host's "${message.type}" message failed`, error);
    }
  }

  /**
   * Verify File: answers `stampRequest { id, withText? }` with `stamp { id, clean, version,
   * length, hash, text? }`: the stamp of the panel's text once nothing is unconfirmed (`clean`
   * false when that did not happen within FLUSH_MS), at the host's log version it is synced to.
   */
  private async answerStamp(m: StampRequestMessage): Promise<void> {
    const id = m.id;
    if (typeof id !== 'string') return;
    const v = this.view;
    let clean = false;
    if (v) {
      commitOpenField(v);
      clean = await this.sync.flush();
    }
    if (this.stopped()) return;
    const now = this.view;
    if (!now) {
      this.bridge.post({ type: 'stamp', id, clean: false, version: -1, length: 0, hash: '' });
      return;
    }
    const text = now.state.doc.toString();
    const stamp = stampOf(text);
    const version = getSyncedVersion(now.state);
    const answer: StampMessage = {
      type: 'stamp',
      id,
      clean: clean && this.sync.hasUnconfirmed() === false,
      version,
      length: stamp.length,
      hash: stamp.hash,
    };
    if (m.withText === true) answer.text = text;
    this.bridge.post(answer);
  }

  private createTestHook(): TestHook {
    return new TestHook({
      bridge: this.bridge,
      view: () => this.view,
      disposed: () => this.disposed,
      cspViolations: () => this.cspViolations,
      setMode: (mode) => this.setMode(mode),
      messageStrip: this.messageSlot,
      flush: () => {
        if (this.view) commitOpenField(this.view);
        return this.sync.flush();
      },
    });
  }

  private teardown(): void {
    this.reports.dispose();
    for (const undo of this.cleanups.splice(0)) {
      try {
        undo();
      } catch (error) {
        console.error('Tandem Markdown: a cleanup failed while the panel closed', error);
      }
    }
    this.sync.dispose();
    const v = this.view;
    this.view = null;
    v?.destroy();
  }
}

/** What is wrong with an init, or null when it can be drawn. */
function initProblem(m: InitMessage): string | null {
  if (m.protocol !== PROTOCOL) return `the host speaks protocol ${String(m.protocol)}, this panel ${PROTOCOL}`;
  if (typeof m.clientId !== 'string' || m.clientId === '') return 'the init has no client id';
  if (typeof m.text !== 'string') return 'the init has no text';
  if (!Number.isInteger(m.version) || m.version < 0) return 'the init has no version';
  if (m.mode !== 'view' && m.mode !== 'edit') return 'the init has no mode';
  if (!m.settings || typeof m.settings !== 'object') return 'the init has no settings';
  if (!m.docInfo || typeof m.docInfo !== 'object' || typeof m.docInfo.uri !== 'string')
    return 'the init has no document information';
  if (m.text.includes('\r')) return 'the init text has a carriage return';
  return null;
}

function clampSelection(
  state: EditorState,
  selection: { anchor: number; head: number } | undefined,
): { anchor: number; head: number } {
  const length = state.doc.length;
  const clamp = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(length, Math.round(n))) : 0;
  return { anchor: clamp(selection?.anchor), head: clamp(selection?.head) };
}

/**
 * Puts the line `saved.topLine` (zero-based) at the top of the viewport, `topOffsetPx` scrolled
 * past its top, as a scroll of the view's own (scroll sync does not take it for the user's).
 */
function restoreScroll(view: EditorView, saved: ViewState, scroll: ScrollFollow): void {
  const topLine = Number.isInteger(saved.topLine) ? Math.max(0, saved.topLine) : 0;
  const offset =
    typeof saved.topOffsetPx === 'number' && Number.isFinite(saved.topOffsetPx) ? Math.max(0, saved.topOffsetPx) : 0;
  if (topLine === 0 && offset === 0) return; // already there
  scroll.showTop(view.state.doc.line(Math.min(view.state.doc.lines, topLine + 1)).from, offset);
}

/**
 * The first cursor of a fresh open: the start of the first line that is not inside the
 * front matter or a table (blocks that show their source while the cursor is in them).
 */
function firstCursor(state: EditorState): number {
  const doc = state.doc;
  const tree = treeFor(state, FIRST_CURSOR_PARSE_CHARS, FIRST_CURSOR_PARSE_MS);
  let line = doc.line(1);
  for (;;) {
    const block = sourceBlockAt(tree, line.from);
    if (!block) return line.from;
    const last = doc.lineAt(block.to);
    if (last.number >= doc.lines) return doc.length;
    line = doc.line(last.number + 1);
  }
}

function sourceBlockAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'Table' || node.name === 'Frontmatter') return node;
  }
  return null;
}
