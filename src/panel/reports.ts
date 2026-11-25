// What the panel reports to the host on its own: where focus is (for the context keys) and the
// view state (selection, top line, mode). When the user is about to act outside the page it
// also sends what is unsent (docs/ARCHITECTURE.md, "Pushing"). Lines in a view state are
// zero-based, as VS Code and the outline count them.

import { StateEffect, type Extension, type Text } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { PanelToHost, ViewState } from '../core/protocol';
import { fieldHasFocus, pageHasFocus } from './focus';
import { getMode } from './modes';
import { isCommandChord } from './ui/keys';

/** How long selection and scroll changes settle before the view state is reported. */
const VIEW_STATE_DEBOUNCE_MS = 150;

/**
 * Reports a place as the view state at once, in place of the editor's own, and keeps reporting it
 * until the selection, the text or the mode next changes. A command that has the host open the
 * note at a place of its own (Resolve in Source) sends it this way, so that no report of the
 * editor's own place, one already due or one made while the host acts, can come after it.
 */
export const reportPlace = StateEffect.define<ViewState>();

/** Adds an event listener that the panel removes when it is torn down. */
export type Listen = (
  target: EventTarget,
  type: string,
  fn: (event: Event) => void,
  options?: AddEventListenerOptions,
) => void;

interface ReportOptions {
  /** The panel's root element; focus anywhere inside it is focus in the panel. */
  root: HTMLElement;
  post(message: PanelToHost): void;
  view(): EditorView | null;
  /** True once the panel has failed or been disposed: nothing more is reported. */
  stopped(): boolean;
  /** Sends what PanelSync has not sent. */
  flush(): void;
  log(message: string, error: unknown): void;
}

export function viewStateOf(v: EditorView): ViewState {
  const main = v.state.selection.main;
  const height = Math.max(0, v.scrollDOM.scrollTop - v.documentPadding.top);
  const block = v.lineBlockAtHeight(height);
  return {
    selection: { anchor: main.anchor, head: main.head },
    topLine: v.state.doc.lineAt(block.from).number - 1,
    topOffsetPx: Math.max(0, Math.round(height - block.top)),
    mode: getMode(v.state),
  };
}

export class PanelReports {
  private viewStateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The place `reportPlace` gave and the text it is in, reported until the user next moves. */
  private held: { place: ViewState; doc: Text } | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocus: { editor: boolean; field: boolean } | null = null;

  /** Rides in the editor state next to PanelSync's extension: selection, mode and focus reports. */
  readonly extension: Extension = EditorView.updateListener.of((update: ViewUpdate) => {
    if (update.view !== this.o.view()) return;
    if (update.focusChanged) {
      this.focusSoon();
      if (!update.view.hasFocus) this.pushNow();
    }
    let placed: ViewState | null = null;
    for (const tr of update.transactions)
      for (const effect of tr.effects) if (effect.is(reportPlace)) placed = effect.value;
    if (placed) {
      this.held = { place: placed, doc: update.state.doc };
      this.viewStateNow();
    } else if (update.selectionSet || update.docChanged || getMode(update.startState) !== getMode(update.state)) {
      this.held = null;
      this.viewStateSoon();
    }
  });

  constructor(private readonly o: ReportOptions) {}

  /**
   * Reports focus as it moves in the page, and pushes when the pointer leaves the panel, the
   * page is blurred, hidden or unloaded, or a command chord is pressed.
   */
  listen(listen: Listen): void {
    const doc = this.o.root.ownerDocument;
    const win = doc.defaultView ?? window;
    listen(doc, 'focusin', this.focusSoon, { capture: true });
    listen(doc, 'focusout', this.focusSoon, { capture: true });
    listen(win, 'focus', this.focusSoon);
    listen(win, 'blur', () => {
      this.focusSoon();
      this.pushNow();
    });
    listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'hidden') this.pushNow();
    });
    listen(win, 'pagehide', this.pushNow);
    // VS Code (1.120 to 1.146) tells a page whose tab is closed with the mouse nothing else in
    // time: the close button takes no focus, and a message posted while the page unloads never
    // reaches the host. The root fills the page inside VS Code.
    listen(this.o.root, 'pointerleave', this.pushNow);
    // In the capture phase on the window, ahead of VS Code's webview host page, which forwards
    // keys to the workbench from the window's bubble phase: the push goes first on the same
    // channel, so it reaches the host before the command the key runs.
    listen(
      win,
      'keydown',
      (event) => {
        if (isCommandChord(event as KeyboardEvent)) this.pushNow();
      },
      { capture: true },
    );
  }

  readonly viewStateNow = (): void => {
    if (this.viewStateTimer !== null) clearTimeout(this.viewStateTimer);
    this.viewStateTimer = null;
    const view = this.o.view();
    if (!view || this.o.stopped()) return;
    try {
      // A held place stands only in the text it was given for: a new state drops it.
      const held = this.held && this.held.doc === view.state.doc ? this.held.place : null;
      this.o.post({ type: 'viewState', ...(held ?? viewStateOf(view)) });
    } catch (error) {
      this.o.log('Could not report the view state', error);
    }
  };

  readonly viewStateSoon = (): void => {
    if (this.viewStateTimer !== null) clearTimeout(this.viewStateTimer);
    this.viewStateTimer = setTimeout(this.viewStateNow, VIEW_STATE_DEBOUNCE_MS);
  };

  readonly focusSoon = (): void => {
    // Focus moving between two elements fires focusout before focusin: wait for both.
    if (this.focusTimer !== null) return;
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      if (this.o.stopped()) return;
      const now = this.focusNow();
      if (this.lastFocus && this.lastFocus.editor === now.editor && this.lastFocus.field === now.field) return;
      this.lastFocus = now;
      this.o.post({ type: 'focus', editor: now.editor, field: now.field });
    }, 0);
  };

  /** The user is about to act outside the page: send what is unsent and where they were. */
  readonly pushNow = (): void => {
    if (!this.o.view() || this.o.stopped()) return;
    this.o.flush();
    this.viewStateNow();
  };

  dispose(): void {
    if (this.viewStateTimer !== null) clearTimeout(this.viewStateTimer);
    if (this.focusTimer !== null) clearTimeout(this.focusTimer);
    this.viewStateTimer = this.focusTimer = null;
  }

  /** `editor`: focus is anywhere in the panel's page (the toolbar and the notices included). `field`: a text field there has it. */
  private focusNow(): { editor: boolean; field: boolean } {
    const view = this.o.view();
    const editor = !!view && pageHasFocus(this.o.root);
    const field = fieldHasFocus(this.o.root, view?.contentDOM ?? null);
    return { editor, field };
  }
}
