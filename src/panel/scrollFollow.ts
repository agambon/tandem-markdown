// Scroll sync in a rich view (docs/ARCHITECTURE.md, "Scroll sync"): the place the view shows at
// its top, putting a place at its top, and telling the user's scrolling from the view's own.
//
// A place is a zero-based line and the share of it above the top. A block drawn taller or
// shorter than its source (a picture, a table, a diagram, hidden front matter) stands for its
// source lines in proportion: halfway down a table drawn over lines 10 to 19 is line 15.
//
// The view reports a scroll to the host only while it is linked, and only one the user made
// (`LeadWatch`). A scroll of its own (a follow, or the place an init restores) is marked from its
// start until its last write.

import type { Extension } from '@codemirror/state';
import { EditorView, type BlockInfo } from '@codemirror/view';
import type { PanelToHost } from '../core/protocol';

/** Two tops this close, in pixels, show the same place. */
const SAME_PX = 1;

/** What the user does in the page that can scroll it, anywhere in it (the toolbar's find too). */
const USER_INPUT = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;

export interface Block {
  from: number;
  /** Pixels from the document's top. */
  top: number;
  height: number;
  /** Zero-based source lines covered by this block, inclusive. */
  firstLine: number;
  lastLine: number;
}

/** Editor layout view used by scroll place arithmetic; heights are pixels from the document's top. */
export interface BlockGeometry {
  readonly lines: number;
  blockAtHeight(height: number): Block;
  /** Block containing the start of a zero-based line. */
  blockAtLine(line: number): Block;
}

interface TopPlace {
  line: number;
  from: number;
  offset: number;
}

/** The place at `height`: the block there, and the share of it above `height` spread over its lines. */
export function placeAtHeight(geometry: BlockGeometry, height: number): TopPlace {
  const block = geometry.blockAtHeight(Math.max(0, height));
  const offset = Math.max(0, Math.min(block.height, height - block.top));
  const share = block.height > 0 ? offset / block.height : 0;
  const lines = block.lastLine - block.firstLine + 1;
  return { line: block.firstLine + Math.min(share, 1) * lines, from: block.from, offset };
}

/** The height at which `place` is drawn: the inverse of `placeAtHeight`. */
export function heightOfPlace(geometry: BlockGeometry, place: number): number {
  const line = Math.max(0, Math.min(geometry.lines - 1, Math.floor(place)));
  const block = geometry.blockAtLine(line);
  const lines = block.lastLine - block.firstLine + 1;
  const share = Math.max(0, Math.min(1, (Math.max(0, place) - block.firstLine) / lines));
  return block.top + share * block.height;
}

/**
 * Which scroll events are the user's. A scroll of the view's own runs from `begin` to `end`.
 * After it, CodeMirror goes on moving the view by a pixel or a few as it measures lines it had
 * only estimated, and the browser rounds the scroll position to whole pixels, so a place alone
 * cannot tell the user's scroll from the view's own, and no clock decides which is which. A
 * scroll event is the user's when none runs, the user has acted in the page since the last one
 * (a wheel, a key, a pointer, a touch, or a command run from VS Code), and the place at the top
 * is not the baseline: the place last reported or landed on, carried through edits.
 */
export class LeadWatch {
  private baseline: { from: number; offset: number } | null = null;
  private own = false;
  private acted = false;

  /** A scroll of the view's own begins: what the user did before it no longer counts. */
  begin(): void {
    this.own = true;
    this.acted = false;
  }

  /** The user acted in the page: a wheel, a key, a pointer, a touch, a command. */
  userActed(): void {
    if (!this.own) this.acted = true;
  }

  /** It ended with `place` at the top, or was given up (null), leaving the baseline as it was. */
  end(place: TopPlace | null): void {
    this.own = false;
    if (place) this.baseline = { from: place.from, offset: place.offset };
  }

  /** Watching starts (or stops, with null) with `place` at the top. */
  reset(place: TopPlace | null): void {
    this.baseline = place && { from: place.from, offset: place.offset };
  }

  /** The document changed: `map` takes an offset before the change to one after it. */
  map(map: (pos: number) => number): void {
    if (this.baseline) this.baseline = { ...this.baseline, from: map(this.baseline.from) };
  }

  /** A scroll event with `place` at the top. True when the user moved the view there. */
  scrolled(place: TopPlace): boolean {
    if (this.own) return false;
    const b = this.baseline;
    if (b && b.from === place.from && Math.abs(b.offset - place.offset) < SAME_PX) return false;
    this.baseline = { from: place.from, offset: place.offset };
    return this.acted;
  }
}

function geometryOf(view: EditorView): BlockGeometry {
  const doc = view.state.doc;
  const block = (b: BlockInfo): Block => ({
    from: b.from,
    top: b.top,
    height: b.height,
    firstLine: doc.lineAt(b.from).number - 1,
    lastLine: doc.lineAt(b.to).number - 1,
  });
  return {
    lines: doc.lines,
    blockAtHeight: (height) => block(view.lineBlockAtHeight(height)),
    blockAtLine: (line) => block(view.lineBlockAt(doc.line(line + 1).from)),
  };
}

function topPlaceOf(view: EditorView): TopPlace {
  return placeAtHeight(geometryOf(view), view.scrollDOM.scrollTop - view.documentPadding.top);
}

/** A place to put at the top: a line with its share, or a block's start and pixels into it. */
type Target = { line: number } | { from: number; offset: number };

interface FollowOptions {
  view(): EditorView | null;
  post(message: PanelToHost): void;
}

export class ScrollFollow {
  private readonly watch = new LeadWatch();
  private linked = false;
  private unlisten: (() => void) | null = null;
  /** The place asked for last; a newer one replaces it while a scroll of the view's own runs. */
  private target: Target | null = null;
  private running = false;
  private disposed = false;

  /** Rides in the editor state: carries the baseline through edits. */
  readonly extension: Extension = EditorView.updateListener.of((update) => {
    if (this.linked && update.docChanged) this.watch.map((pos) => update.changes.mapPos(pos, -1));
  });

  constructor(private readonly o: FollowOptions) {}

  /** The host linked the view (it reports the user's scrolling from now on) or unlinked it. */
  setLinked(linked: boolean): void {
    if (this.disposed) return;
    this.linked = linked;
    const view = this.o.view();
    this.stopListening();
    if (!linked || !view) {
      this.watch.reset(null);
      return;
    }
    const scroller = view.scrollDOM;
    const win = view.dom.ownerDocument.defaultView ?? window;
    const acted = this.userActed;
    const options = { passive: true, capture: true };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    for (const type of USER_INPUT) win.addEventListener(type, acted, options);
    this.unlisten = () => {
      scroller.removeEventListener('scroll', this.onScroll);
      for (const type of USER_INPUT) win.removeEventListener(type, acted, options);
    };
    if (!this.running) this.watch.reset(topPlaceOf(view));
  }

  /** The user acted in the page: what scrolls next is theirs. A command run from VS Code counts. */
  readonly userActed = (): void => {
    this.watch.userActed();
  };

  /** Puts a place at the top: a zero-based line and the share of it above the top. */
  goTo(line: number): void {
    if (!Number.isFinite(line)) return;
    this.start({ line: Math.max(0, line) });
  }

  /** Puts the line starting at `from` at the top, `offset` pixels scrolled past its top. */
  showTop(from: number, offset: number): void {
    this.start({ from, offset: Math.max(0, offset) });
  }

  dispose(): void {
    this.disposed = true;
    this.stopListening();
  }

  private stopListening(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private readonly onScroll = (): void => {
    const view = this.o.view();
    if (!view || !this.linked) return;
    const place = topPlaceOf(view);
    if (this.watch.scrolled(place)) this.o.post({ type: 'scrolled', line: place.line });
  };

  private start(target: Target): void {
    if (this.disposed) return;
    this.target = target;
    if (!this.running) this.run();
  }

  /**
   * Scrolls to the latest target. A line whose block is drawn is placed in one write; one that
   * is not is first scrolled into view, which draws and measures it, and placed after that.
   * CodeMirror applies a scroll into view after the writes of its measure cycle, so the second
   * step waits for the next frame, which runs after the cycle that applies it.
   */
  private run(): void {
    const view = this.o.view();
    const target = this.target;
    if (!view || !target || this.disposed) {
      this.stopRunning(null);
      return;
    }
    this.running = true;
    this.watch.begin();
    const from = startOf(view, target);
    const place = () =>
      view.requestMeasure({
        key: this,
        // A place asked for since is placed instead, when its line is drawn too.
        read: (v) => {
          const latest = this.target ?? target;
          return latest === target || drawn(v, latest) ? { target: latest, ...landing(v, latest) } : null;
        },
        write: (landed, v) => this.landed(v, landed),
      });
    if (drawn(view, target)) {
      place();
      return;
    }
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 0 }) });
    const win = view.dom.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      if (this.o.view() === view && view.dom.isConnected && !this.disposed) place();
      else this.stopRunning(null);
    });
  }

  private landed(view: EditorView, landed: (Landing & { target: Target }) | null): void {
    if (landed && Math.abs(view.scrollDOM.scrollTop - landed.top) >= SAME_PX) view.scrollDOM.scrollTop = landed.top;
    if (!landed || landed.target !== this.target) {
      // A newer place, whose line is not drawn yet. The view is in its measure cycle, which takes
      // no new transaction: start again once the cycle is over.
      queueMicrotask(() => this.run());
      return;
    }
    this.stopRunning(landed.place);
  }

  private stopRunning(place: TopPlace | null): void {
    this.target = null;
    this.running = false;
    this.watch.end(place);
  }
}

function startOf(view: EditorView, target: Target): number {
  const doc = view.state.doc;
  if ('line' in target) return doc.line(Math.min(doc.lines, Math.floor(target.line) + 1)).from;
  return Math.max(0, Math.min(doc.length, target.from));
}

/** True when the line `target` names is drawn, so its height is measured, not estimated. */
function drawn(view: EditorView, target: Target): boolean {
  const from = startOf(view, target);
  return from >= view.viewport.from && from <= view.viewport.to;
}

interface Landing {
  top: number;
  place: TopPlace;
}

/**
 * The scroll position that puts `target` at the top, kept within what the view can scroll, and
 * the place there. Read in a measure's read phase: its write phase may not read the layout.
 */
function landing(view: EditorView, target: Target): Landing {
  const padding = view.documentPadding.top;
  const geometry = geometryOf(view);
  let top: number;
  if ('line' in target) top = heightOfPlace(geometry, target.line) + padding;
  else top = view.lineBlockAt(Math.max(0, Math.min(view.state.doc.length, target.from))).top + padding + target.offset;
  const scroller = view.scrollDOM;
  top = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
  return { top, place: placeAtHeight(geometry, top - padding) };
}
