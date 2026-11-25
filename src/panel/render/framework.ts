// The render framework: the reveal questions, the two ways to contribute decorations, and the
// one widget base class, with the fault guard around all of them (a fault is reported in
// faults.ts). The features in render/ and tables/ draw through it (outsideMark.ts keeps its
// own state field). The line table and block index they read are in lines.ts, and what a
// change damages in damage.ts. docs/ARCHITECTURE.md, "Drawing", has a worked example of each kind.

import { ensureSyntaxTree, forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import {
  type EditorSelection,
  Facet,
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  EditorState,
  type Extension,
  type Range,
  type Text,
  type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { IterMode, type SyntaxNode, type SyntaxNodeRef, type Tree } from '@lezer/common';
import { panelContext, type Notice, type PanelContext } from '../context';
import { getMode, type Mode } from '../modes';
import { trackPending, whenIdle, type OnDemand } from '../onDemand';
import { featureOn } from '../syntax';
import { docDamage, mergeSpans, outside, widenToBlocks } from './damage';
import { featureFaultEffect, isFeatureFaulted, reportFault } from './faults';
import { blocksIn, blocksOf, linesField, linesOf, type BlockEntry, type Lines, type Span } from './lines';

// ---------------------------------------------------------------------------
// Reveal

/** Freezes (a selection) or thaws (null) the reveal answers, as a mouse-down does. */
export const freezeEffect = StateEffect.define<EditorSelection | null>();

/** While a mouse button is down: the selection as it was on mouse-down. */
const freezeField = StateField.define<EditorSelection | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(freezeEffect)) value = effect.value;
    if (value && tr.docChanged) value = value.map(tr.changes);
    return value;
  },
});

/** The selection the reveal questions are answered from, or null in Rich view. */
function revealSelection(state: EditorState): EditorSelection | null {
  if (getMode(state) !== 'edit') return null;
  return state.field(freezeField, false) ?? state.selection;
}

function touches(selection: EditorSelection | null, from: number, to: number, inner?: readonly Span[]): boolean {
  if (!selection) return false;
  for (const range of selection.ranges) {
    if (range.from > to || range.to < from) continue;
    if (inner && inner.some((child) => range.from >= child.from && range.to <= child.to)) continue;
    return true;
  }
  return false;
}

/**
 * For an inline node: true when a selection range touches it (inside it or at either edge).
 * Pass the node's children that reveal their own marks as `inner`: a range that lies within
 * one of them (touching its edges included) reveals that child only, not this node.
 */
export function isRevealed(state: EditorState, from: number, to: number, inner?: readonly Span[]): boolean {
  return touches(revealSelection(state), from, to, inner);
}

/**
 * Each selection range widened to whole lines, cached per selection. A range touches the
 * line-widened span of a block exactly when its own line-widened span touches the block, so
 * line and block questions need no line lookups of their own.
 */
const widenedSelections = new WeakMap<EditorSelection, Span[]>();

function widened(state: EditorState, selection: EditorSelection): Span[] {
  let spans = widenedSelections.get(selection);
  if (!spans) {
    const lines = linesOf(state.doc);
    spans = selection.ranges.map((r) => ({
      from: lines.start(lines.numberAt(r.from)),
      to: lines.end(lines.numberAt(r.to)),
    }));
    widenedSelections.set(selection, spans);
  }
  return spans;
}

function touchesSpans(spans: readonly Span[], from: number, to: number): boolean {
  for (const span of spans) if (span.from <= to && span.to >= from) return true;
  return false;
}

/** For a line-level mark (`#`, a rule's dashes): true when a selection range touches the line holding `pos`. */
export function isLineRevealed(state: EditorState, pos: number): boolean {
  const selection = revealSelection(state);
  return !!selection && touchesSpans(widened(state, selection), pos, pos);
}

/** For a block that swaps to its raw source: true when a selection range touches any of its lines. */
export function isBlockRevealed(state: EditorState, from: number, to: number): boolean {
  const selection = revealSelection(state);
  return !!selection && touchesSpans(widened(state, selection), from, to);
}

/**
 * How long the answers stay frozen after the button comes up. A double or triple click
 * measures its second mouse-down against the layout, so the layout must not change between
 * the clicks. A key press ends the wait at once.
 */
const REVEAL_RELEASE_DELAY_MS = 400;

/**
 * Calls `ended` once, when the press under way in the editor ends: at the button's release in
 * the window (`true`), or when the press is lost (`false`), to a drag that ends or to the window
 * losing focus. Heard in the bubble phase on the window, so CodeMirror's own mouse-up handling
 * (on the document) has placed the selection before `ended` runs. Gives what stops the waiting.
 */
function whenPressEnds(view: EditorView, ended: (released: boolean) => void): () => void {
  const win = view.dom.ownerDocument.defaultView ?? window;
  const released = () => {
    stop();
    ended(true);
  };
  const lost = () => {
    stop();
    ended(false);
  };
  const stop = () => {
    win.removeEventListener('mouseup', released);
    win.removeEventListener('dragend', lost);
    win.removeEventListener('blur', lost);
  };
  win.addEventListener('mouseup', released);
  win.addEventListener('dragend', lost);
  win.addEventListener('blur', lost);
  return stop;
}

/** Freezes the reveal answers between mouse-down and mouse-up, so a line cannot move under the pointer. */
const freezeOnMouseDown = ViewPlugin.fromClass(
  class {
    /** Stops waiting for the press under way to end; null while no button is down. */
    private stopWaiting: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly view: EditorView) {}

    private get down(): boolean {
      return this.stopWaiting !== null;
    }

    private frozen(): boolean {
      return !!this.view.state.field(freezeField, false);
    }

    hold(): void {
      if (getMode(this.view.state) !== 'edit') return;
      this.cancelTimer();
      if (!this.frozen()) this.view.dispatch({ effects: freezeEffect.of(this.view.state.selection) });
      this.stopWaiting ??= whenPressEnds(this.view, this.ended);
    }

    private ended = (released: boolean): void => {
      this.stopWaiting = null;
      this.cancelTimer();
      if (released) this.timer = setTimeout(this.thaw, REVEAL_RELEASE_DELAY_MS);
      else this.thaw();
    };

    thaw = (): void => {
      this.cancelTimer();
      if (this.frozen()) this.view.dispatch({ effects: freezeEffect.of(null) });
    };

    private cancelTimer(): void {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }

    /** Called on a move with no button down. */
    settle(): void {
      if (!this.down && this.frozen() && this.timer === null) this.thaw();
    }

    keyDown(): void {
      if (!this.down && this.frozen()) this.thaw();
    }

    destroy(): void {
      this.stopWaiting?.();
      this.stopWaiting = null;
      this.cancelTimer();
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        if (event.button === 0) this.hold();
        return false;
      },
      mousemove(event) {
        // A release we never heard about: let go.
        if (event.buttons === 0) this.settle();
        return false;
      },
      keydown() {
        this.keyDown();
        return false;
      },
    },
  },
);

// ---------------------------------------------------------------------------
// The size limit: over `settings.maxRichFileSizeKb`, every feature is off and the text is plain.

/** Dispatched by the editor when the settings change, so the size limit is checked again. */
export const settingsChangedEffect = StateEffect.define<null>();

/**
 * Draws one feature again over the whole document (its id, as given to `inlineFeature` or
 * `blockFeature`). For a feature whose drawing depends on something outside the blocks it
 * draws: answers from the host, or link definitions elsewhere in the file.
 */
export const redrawFeatureEffect = StateEffect.define<string>();

/** Per panel, each module asked for and the features to draw again once it has loaded. */
const loadsAsked = new WeakMap<PanelContext, Map<OnDemand<unknown>, Set<string>>>();

/**
 * Loads `module` once the page is idle (or at once, `now`), once per panel, and then draws
 * `feature` again, with every other feature that asked for it meanwhile (`InlineDraw.drawWhenLoaded`).
 */
function drawWhenLoaded(ctx: PanelContext, feature: string, module: OnDemand<unknown>, at: 'idle' | 'now'): void {
  let asked = loadsAsked.get(ctx);
  if (!asked) loadsAsked.set(ctx, (asked = new Map()));
  const waiting = asked.get(module);
  if (waiting) {
    waiting.add(feature);
    return;
  }
  const features = new Set([feature]);
  asked.set(module, features);
  void trackPending(
    (at === 'idle' ? whenIdle() : Promise.resolve())
      .then(() => module.load())
      .then(
        () => ctx.dispatch({ effects: [...features].map((f) => redrawFeatureEffect.of(f)) }),
        (error: unknown) => ctx.log('error', `Drawing feature "${feature}" could not load what it draws with`, error),
      ),
  );
}

function withinSizeLimit(state: EditorState): boolean {
  const kb = state.facet(panelContext)?.settings.maxRichFileSizeKb;
  if (!kb || kb <= 0) return true;
  // Measured in characters of the LF text, which is the byte count for plain ASCII.
  return state.doc.length <= kb * 1024;
}

const richEnabledField = StateField.define<boolean>({
  create: withinSizeLimit,
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(settingsChangedEffect))) return withinSizeLimit(tr.state);
    return value;
  },
});

/** False while the file is over the size limit, when no feature draws anything. */
function isRichEnabled(state: EditorState): boolean {
  return state.field(richEnabledField, false) ?? true;
}

/** True when `feature` draws nothing: the file is over the size limit, the feature failed, or its syntax is off. */
function drawsNothing(ctx: PanelContext, state: EditorState, feature: string): boolean {
  return !isRichEnabled(state) || isFeatureFaulted(ctx, feature) || !featureOn(ctx.settings, feature);
}

/** The setting the size limit is read from, which "Change limit" opens. */
const SIZE_LIMIT_SETTING = 'tandemMarkdown.maxRichFileSizeKb';

/** The notice of a note over the size limit, with "Change limit", which opens the setting in VS Code. */
export function sizeLimitNotice(ctx: PanelContext): Notice {
  return {
    kind: 'info',
    sticky: true,
    text: `${ctx.doc.fileName} is over ${ctx.settings.maxRichFileSizeKb} KB, so it is shown as plain markdown.`,
    actions: [{ label: 'Change limit', run: () => ctx.bridge.post({ type: 'openSetting', id: SIZE_LIMIT_SETTING }) }],
  };
}

const sizeNotice = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      if (!isRichEnabled(view.state)) this.tell(view.state);
    }
    update(update: ViewUpdate): void {
      if (isRichEnabled(update.startState) && !isRichEnabled(update.state)) this.tell(update.state);
    }
    tell(state: EditorState): void {
      const ctx = state.facet(panelContext);
      if (ctx) ctx.notify(sizeLimitNotice(ctx));
    }
  },
);

// ---------------------------------------------------------------------------
// Background parsing: block features use what is parsed and rebuild as the tree grows.
// CodeMirror's own worker stops about 100,000 characters past the viewport; for files under
// BACKGROUND_PARSE_LIMIT this finishes the job in small idle slices.

const BACKGROUND_PARSE_LIMIT = 300 * 1024;

const finishParse = ViewPlugin.fromClass(
  class {
    private cancel: (() => void) | null = null;
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(update: ViewUpdate): void {
      if (update.docChanged) this.schedule();
    }
    schedule(): void {
      if (this.cancel) return;
      const { state } = this.view;
      if (state.doc.length >= BACKGROUND_PARSE_LIMIT || syntaxTreeAvailable(state)) return;
      const run = () => {
        this.cancel = null;
        forceParsing(this.view, this.view.state.doc.length, 20);
        this.schedule();
      };
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 200 });
        this.cancel = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(run, 30);
        this.cancel = () => clearTimeout(id);
      }
    }
    destroy(): void {
      this.cancel?.();
      this.cancel = null;
    }
  },
);

// ---------------------------------------------------------------------------
// The line height CodeMirror estimates with
//
// CodeMirror estimates the height of every line it has not drawn from one sample, the first
// short line in view that holds nothing but plain text (`measureTextSize` in @codemirror/view
// 6.43), and when that sample moves by more than 0.3 px it drops every measured height in the
// document and estimates them all again. Lines here are drawn at many heights (code, a code
// box's padded first line, a table's source, a line with a gap above), so the sample would
// follow whatever is in view and a long document would move by thousands of pixels. Every
// drawn line's text sits in one mark, so no line is ever the sample: CodeMirror measures its
// own line of body text, which keeps one height.

const lineText = Decoration.mark({ class: 'tm-line-text' });

const unsampledLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const lines = linesOf(view.state.doc);
      const marks: Range<Decoration>[] = [];
      for (const { from, to } of view.visibleRanges) {
        const last = lines.numberAt(to);
        for (let n = lines.numberAt(from); n <= last; n++) {
          const start = Math.max(from, lines.start(n));
          const end = Math.min(to, lines.end(n));
          if (end > start) marks.push(lineText.range(start, end));
        }
      }
      return Decoration.set(marks);
    }
  },
  {
    provide: (plugin) => EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/** The framework's own extensions. editor.ts adds them once, before the features. */
export function renderFramework(): Extension {
  return [
    linesField,
    freezeField,
    freezeOnMouseDown,
    keepSelectionWhilePressed,
    richEnabledField,
    inlineEpoch,
    sizeNotice,
    finishParse,
    unsampledLines,
  ];
}

// ---------------------------------------------------------------------------
// Widgets

/**
 * The one base class for widgets. Do not override `toDOM`, `updateDOM`, `eq` or
 * `ignoreEvent`: implement `draw`, and optionally `redraw`, `sameAs` and `ignores`. Those run
 * inside a guard; a throw turns the widget's feature off and the widget shows its source text.
 */
export abstract class RichWidget extends WidgetType {
  /** Set when the widget is added through a Draw. */
  feature = 'unknown';
  ctx: PanelContext | undefined;
  block = false;

  /** `source` is the document text this widget stands for. It is shown if drawing fails. */
  constructor(readonly source: string) {
    super();
  }

  /**
   * Always false. CodeMirror reads this undocumented property of a widget: when it is true, the
   * widget's element is left editable by the browser instead of being marked
   * `contenteditable="false"`. Declared here so that a subclass cannot give a field this name
   * by chance; the compiler refuses one.
   */
  get editable(): boolean {
    return false;
  }

  /**
   * What the widget reads as in plain text, where no drawing is shown (a task's name, a note in
   * the hover card): its source unless the widget says otherwise.
   */
  get plainText(): string {
    return this.source;
  }

  /** Build the widget's DOM with createElement and textContent. Never innerHTML. */
  abstract draw(view: EditorView): HTMLElement;

  /** Update `dom` (drawn by a widget of the same class) to show this widget. Return false to redraw from scratch. */
  redraw?(dom: HTMLElement, view: EditorView): boolean;

  /**
   * Whether `other` (same class, same source) draws the same. Default true. Compare every
   * field that changes the drawing.
   */
  sameAs(_other: this): boolean {
    return true;
  }

  /** Whether the editor should ignore `event` inside the widget. Default: ignore all. */
  ignores?(event: Event): boolean;

  private fault(where: string, error: unknown, view?: EditorView): void {
    reportFault(this.ctx ?? view?.state.facet(panelContext), this.feature, `a widget's ${where}`, error, view);
  }

  override eq(other: WidgetType): boolean {
    if (other === this) return true;
    if (!(other instanceof RichWidget) || other.constructor !== this.constructor || other.source !== this.source)
      return false;
    try {
      return this.sameAs(other as this);
    } catch (error) {
      this.fault('eq', error);
      return false;
    }
  }

  override toDOM(view: EditorView): HTMLElement {
    try {
      return this.draw(view);
    } catch (error) {
      this.fault('toDOM', error, view);
      const fallback = view.dom.ownerDocument.createElement(this.block ? 'div' : 'span');
      fallback.className = 'tm-fallback';
      fallback.textContent = this.source;
      return fallback;
    }
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!this.redraw || dom.classList.contains('tm-fallback')) return false;
    try {
      return this.redraw(dom, view);
    } catch (error) {
      this.fault('updateDOM', error, view);
      return false;
    }
  }

  override ignoreEvent(event: Event): boolean {
    if (!this.ignores) return true;
    try {
      return this.ignores(event);
    } catch (error) {
      this.fault('ignoreEvent', error);
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// A press on a drawing

// The editor keeps its own copy of the page's selection. When the page tells it the selection
// changed (`selectionchange`), it asks the widget under it and leaves alone what a widget that
// `ignores` holds; but each measure also reads the page's selection, without asking
// (@codemirror/view 6.43), and when that read comes first, a caret or a selection left in a
// drawing's text becomes the cursor, moved into the block, which shows its source.

/** The panels in which a press that began on a widget's drawing, in Rich editor, is still held. */
const pressedOnDrawing = new WeakSet<PanelContext>();

/** While such a press is held, a transaction that only moves the selection is that read, and is dropped. */
const keepSelectionWhilePressed = EditorState.transactionFilter.of((tr) => {
  const ctx = tr.startState.facet(panelContext);
  const onlySelects = !!tr.selection && !tr.docChanged && tr.effects.length === 0;
  return onlySelects && ctx && pressedOnDrawing.has(ctx) ? [] : tr;
});

/**
 * In Rich editor, lets a click in `element`, a widget's drawing, leave the editor's selection as
 * it was, while a drag or a double click there still selects the drawing's text. During the press
 * the editor takes nothing from the page (`keepSelectionWhilePressed`). When it ends, the caret of
 * a press that selected nothing goes back to the cursor, and the text a press selected is told to
 * the editor as a selection change, so that it is seen, asked about and left before a measure.
 */
export function leaveSelectionOnClick(view: EditorView, element: HTMLElement): void {
  element.addEventListener('mousedown', (event) => {
    const ctx = view.state.facet(panelContext);
    // A press a part of the drawing took for itself (a button, a link) left no caret.
    if (event.button !== 0 || event.defaultPrevented || !ctx || getMode(view.state) !== 'edit') return;
    pressedOnDrawing.add(ctx);
    whenPressEnds(view, (released) => {
      pressedOnDrawing.delete(ctx);
      if (!released) return;
      const doc = view.dom.ownerDocument;
      if (doc.getSelection()?.isCollapsed === false) doc.dispatchEvent(new Event('selectionchange'));
      else caretToCursor(view);
    });
  });
}

/**
 * Puts the page's caret back at the editor's cursor: the editor writes its selection to the page
 * only when it sees one change, and Chrome 157 reports no change for a caret placed in text the
 * editor does not own. An editor drawn inside (an embedded note's) that took the focus keeps its
 * own caret.
 */
function caretToCursor(view: EditorView): void {
  const page = view.dom.ownerDocument.getSelection();
  if (!page || !view.hasFocus) return;
  const anchor = view.domAtPos(view.state.selection.main.anchor);
  const head = view.domAtPos(view.state.selection.main.head);
  page.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
}

// ---------------------------------------------------------------------------
// Draw: what a feature's build function gets

export interface InlineDraw {
  readonly state: EditorState;
  readonly doc: Text;
  /** The syntax tree as far as it is parsed. */
  readonly tree: Tree;
  /** The document's line table (shared by every feature; use it instead of `doc.line` in loops). */
  readonly lines: Lines;
  readonly mode: Mode;
  readonly ctx: PanelContext;
  /**
   * The span to draw. Inline: the visible part of the document. Block: all of it, or, after
   * an edit, just the top-level blocks that changed and one neighbor each side (always whole
   * top-level blocks and whole lines); everything outside keeps what was drawn before.
   */
  readonly from: number;
  readonly to: number;

  /** isRevealed, asked through the Draw (a block feature redraws when the answer flips). */
  revealed(from: number, to: number, inner?: readonly Span[]): boolean;
  lineRevealed(pos: number): boolean;
  blockRevealed(from: number, to: number): boolean;

  /**
   * Walks the tree over [from, to], skipping nested code-language trees. Return false from
   * `enter` to skip a node's children.
   */
  iterate(enter: (node: SyntaxNodeRef) => boolean | void, leave?: (node: SyntaxNodeRef) => void): void;

  /**
   * Adds a class (and optional attributes) to the text in [from, to], in a `span`, or in an
   * element named `tagName`.
   */
  mark(from: number, to: number, className: string, attributes?: Record<string, string>, tagName?: string): void;
  /** Hides [from, to] (within one line). The cursor steps over it. */
  hide(from: number, to: number): void;
  /** Draws `widget` in place of [from, to] (within one line). The cursor steps over it. */
  replace(from: number, to: number, widget: RichWidget): void;
  /** Draws `widget` at `pos`, before (side < 0) or after (side > 0) the cursor there. */
  widget(pos: number, widget: RichWidget, side?: number): void;
  /**
   * For a build that met something only `module` can draw: loads it once the page is idle, or at
   * once for what the first paint must show (`now`), and then draws again what this build drew.
   * Until then the build draws that thing as typed.
   */
  drawWhenLoaded(module: OnDemand<unknown>, at?: 'idle' | 'now'): void;
}

export interface BlockDraw extends InlineDraw {
  /**
   * Every block node (headings, paragraphs, lists, items, quotes, code...) inside [from, to],
   * in document order, parents before children. The list is built once per tree and shared
   * by every feature.
   */
  blocks(enter: (block: BlockEntry) => void): void;
  /** Adds a class (and optional attributes) to the line holding `pos`. */
  line(pos: number, className: string, attributes?: Record<string, string>): void;
  /** Removes the whole lines from the one holding `from` to the one holding `to`. */
  hideLines(from: number, to: number): void;
  /** Draws a block widget in place of the whole lines from `from`'s to `to`'s. */
  replaceLines(from: number, to: number, widget: RichWidget): void;
  /** Draws a block widget between lines: above the line holding `pos` (side -1) or below it (side 1). */
  blockWidget(pos: number, widget: RichWidget, side: -1 | 1): void;
  /**
   * What every inline feature reads of where `node` stands (`placeKey`), for inline content
   * drawn outside the lines. The answer is noted, so `node` is drawn again when it changes.
   */
  placeKey(node: SyntaxNode): string;
  /**
   * Other features' marks over [from, to] (`sourceMarks`), for inline content drawn outside the
   * lines. Noted, so [from, to] is drawn again when they change there.
   */
  marks(from: number, to: number): DecorationSet[];
}

const markCache = new Map<string, Decoration>();
const lineCache = new Map<string, Decoration>();
const hideDecoration = Decoration.replace({});
const hideLinesDecoration = Decoration.replace({ block: true });

function markDecoration(className: string, attributes?: Record<string, string>, tagName?: string): Decoration {
  if (attributes || tagName)
    return Decoration.mark({ class: className, ...(attributes && { attributes }), ...(tagName && { tagName }) });
  let deco = markCache.get(className);
  if (!deco) markCache.set(className, (deco = Decoration.mark({ class: className })));
  return deco;
}

function lineDecoration(className: string, attributes?: Record<string, string>): Decoration {
  if (attributes) return Decoration.line({ class: className, attributes });
  let deco = lineCache.get(className);
  if (!deco) lineCache.set(className, (deco = Decoration.line({ class: className })));
  return deco;
}

const REVEAL_INLINE = 0;
const REVEAL_LINE = 1;
const REVEAL_BLOCK = 2;

/**
 * A reveal question a block build asked over a range, with the answer it got. Kept in a
 * RangeSet, so an edit moves the questions by chunks and a cursor move finds those near it.
 */
class Question extends RangeValue {
  constructor(
    readonly kind: number,
    /** The children that reveal themselves, as offsets from the question's start. */
    readonly inner: readonly Span[] | undefined,
    readonly answer: boolean,
  ) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other === this;
  }
}
Question.prototype.startSide = -1;
Question.prototype.endSide = 1;
Question.prototype.mapMode = MapMode.Simple;

type Questions = RangeSet<Question>;

/** What `placeKey` gave for a node a block build drew inline content of, noted over the node. */
class Placed extends RangeValue {
  constructor(
    readonly name: string,
    readonly key: string,
  ) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other === this;
  }
}
Placed.prototype.startSide = -1;
Placed.prototype.endSide = 1;
Placed.prototype.mapMode = MapMode.Simple;

/** The marks a block build drew over a range (`BlockDraw.marks`), as a key, noted over the range. */
class Marked extends RangeValue {
  constructor(readonly key: string) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other === this;
  }
}
Marked.prototype.startSide = -1;
Marked.prototype.endSide = 1;
Marked.prototype.mapMode = MapMode.Simple;

/** `sets`, marks over a range starting at `from`, as a key that does not change when the range moves. */
export function marksKey(sets: readonly DecorationSet[], from: number): string {
  let key = '';
  sets.forEach((set, k) => {
    for (let cursor = set.iter(); cursor.value; cursor.next()) {
      const spec = cursor.value.spec as { class?: string; attributes?: Record<string, string> };
      key += `${k}:${cursor.from - from}-${cursor.to - from}:${spec.class ?? ''}:${JSON.stringify(spec.attributes ?? null)};`;
    }
  });
  return key;
}

/** The spans, widened to their top-level blocks, of the noted ranges whose marks are no longer what they were. */
function remarkedSpans(marked: RangeSet<Marked>, state: EditorState): Span[] {
  const tree = syntaxTree(state);
  const lines = linesOf(state.doc);
  const spans: Span[] = [];
  marked.between(0, state.doc.length, (from, to, value) => {
    if (marksKey(sourceMarks(state, from, to), from) !== value.key)
      spans.push(widenToBlocks(tree, lines, from, to, false));
  });
  return mergeSpans(spans);
}

/** The node named `name` that spans exactly [from, to] in `tree`, or null. */
function nodeSpanning(tree: Tree, from: number, to: number, name: string): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(from, 1); node && node.from === from; node = node.parent)
    if (node.to === to && node.name === name) return node;
  return null;
}

/** The spans, widened to their top-level blocks, of the noted nodes whose `placeKey` is no longer what it was. */
function movedSpans(placed: RangeSet<Placed>, state: EditorState): Span[] {
  const tree = syntaxTree(state);
  const lines = linesOf(state.doc);
  const spans: Span[] = [];
  placed.between(0, state.doc.length, (from, to, value) => {
    const node = nodeSpanning(tree, from, to, value.name);
    if (!node || placeKey(state, node) !== value.key) spans.push(widenToBlocks(tree, lines, from, to, false));
  });
  return mergeSpans(spans);
}

function answer(state: EditorState, kind: number, from: number, to: number, inner?: readonly Span[]): boolean {
  return kind === REVEAL_INLINE
    ? isRevealed(state, from, to, inner)
    : kind === REVEAL_LINE
      ? isLineRevealed(state, from)
      : isBlockRevealed(state, from, to);
}

/** Answers `question` again, asked over [from, to]. */
function answerAgain(state: EditorState, question: Question, from: number, to: number): boolean {
  const inner = question.inner?.map((s) => ({ from: from + s.from, to: from + s.to }));
  return answer(state, question.kind, from, to, inner);
}

class Collector implements BlockDraw {
  /** Block widgets, hidden and replaced lines, and anything else that crosses a line break. */
  readonly decorations: Range<Decoration>[] = [];
  readonly lineClasses: Range<Decoration>[] = [];
  /** Marks, inline widgets, and hidden or replaced text within one line (see `Drawn`). */
  readonly inline: Range<Decoration>[] = [];
  readonly atomic: Range<Decoration>[] = [];
  readonly questions: Range<Question>[] | null;
  /** The keys `placeKey` gave, for nodes whose key is not empty. */
  readonly placed: Range<Placed>[] = [];
  /** The ranges other features' marks were drawn over, with them as a key. */
  readonly marked: Range<Marked>[] = [];
  readonly doc: Text;
  readonly tree: Tree;
  readonly lines: Lines;
  readonly mode: Mode;

  constructor(
    readonly state: EditorState,
    readonly ctx: PanelContext,
    readonly feature: string,
    readonly from: number,
    readonly to: number,
    /** `outside`: an inline feature drawing for `inlineDrawing`, over `nodes` only. */
    readonly channel: 'inline' | 'block' | 'outside',
    private readonly blockList: readonly BlockEntry[] | null = null,
    private readonly nodes: readonly SyntaxNode[] = [],
    /** The feature drawn again when a module this build waits for has loaded. */
    private readonly owner: string = feature,
  ) {
    this.doc = state.doc;
    this.tree = syntaxTree(state);
    this.lines = linesOf(state.doc);
    this.mode = getMode(state);
    this.questions = channel === 'block' ? [] : null;
  }

  private ask(kind: number, from: number, to: number, inner?: readonly Span[]): boolean {
    // Inline content drawn outside the lines is never revealed: its source is edited elsewhere.
    if (this.channel === 'outside') return false;
    const result = answer(this.state, kind, from, to, inner);
    if (this.questions) {
      const offsets = inner?.map((s) => ({ from: s.from - from, to: s.to - from }));
      this.questions.push(new Question(kind, offsets, result).range(from, to));
    }
    return result;
  }

  revealed(from: number, to: number, inner?: readonly Span[]): boolean {
    return this.ask(REVEAL_INLINE, from, to, inner);
  }
  lineRevealed(pos: number): boolean {
    return this.ask(REVEAL_LINE, pos, pos);
  }
  blockRevealed(from: number, to: number): boolean {
    return this.ask(REVEAL_BLOCK, from, to);
  }

  iterate(enter: (node: SyntaxNodeRef) => boolean | void, leave?: (node: SyntaxNodeRef) => void): void {
    if (this.channel === 'outside') {
      for (const node of this.nodes) node.cursor(IterMode.IgnoreMounts).iterate(enter, leave);
      return;
    }
    this.tree.iterate({ from: this.from, to: this.to, mode: IterMode.IgnoreMounts, enter, ...(leave && { leave }) });
  }

  drawWhenLoaded(module: OnDemand<unknown>, at: 'idle' | 'now' = 'idle'): void {
    drawWhenLoaded(this.ctx, this.owner, module, at);
  }

  blocks(enter: (block: BlockEntry) => void): void {
    this.blockOnly('blocks');
    for (const block of this.blockList ?? blocksOf(this.state)) enter(block);
  }

  placeKey(node: SyntaxNode): string {
    this.blockOnly('placeKey');
    const key = placeKey(this.state, node);
    // A node whose key is empty holds nothing that reads where it stands until its text changes.
    if (key) this.placed.push(new Placed(node.name, key).range(node.from, node.to));
    return key;
  }

  marks(from: number, to: number): DecorationSet[] {
    this.blockOnly('marks');
    const sets = sourceMarks(this.state, from, to);
    this.marked.push(new Marked(marksKey(sets, from)).range(from, to));
    return sets;
  }

  private inLine(from: number, to: number, what: string): void {
    if (this.channel !== 'block' && to > this.lines.end(this.lines.numberAt(from))) {
      throw new RangeError(`${what} [${from}, ${to}] crosses a line break; use a blockFeature for that`);
    }
  }

  private lineStart(pos: number): number {
    return this.lines.start(this.lines.numberAt(pos));
  }

  private lineEnd(pos: number): number {
    return this.lines.end(this.lines.numberAt(pos));
  }

  /** Where a decoration goes: the block channel keeps what stays within a line apart. */
  private target(from: number, to: number): Range<Decoration>[] {
    return this.channel !== 'block' || to <= this.lineEnd(from) ? this.inline : this.decorations;
  }

  private blockOnly(what: string): void {
    if (this.channel !== 'block') throw new Error(`${what}() is only available in a blockFeature`);
  }

  private bind(widget: RichWidget, block: boolean): RichWidget {
    widget.feature = this.feature;
    widget.ctx = this.ctx;
    widget.block = block;
    return widget;
  }

  mark(from: number, to: number, className: string, attributes?: Record<string, string>, tagName?: string): void {
    if (to > from) this.inline.push(markDecoration(className, attributes, tagName).range(from, to));
  }

  hide(from: number, to: number): void {
    if (to <= from) return;
    this.inLine(from, to, 'hide');
    const range = hideDecoration.range(from, to);
    this.target(from, to).push(range);
    this.atomic.push(range);
  }

  replace(from: number, to: number, widget: RichWidget): void {
    // CodeMirror refuses an empty replace range; drawing the widget at `from` is the same thing.
    if (to <= from) return this.widget(from, widget);
    this.inLine(from, to, 'replace');
    const range = Decoration.replace({ widget: this.bind(widget, false) }).range(from, to);
    this.target(from, to).push(range);
    this.atomic.push(range);
  }

  widget(pos: number, widget: RichWidget, side = 1): void {
    this.inline.push(Decoration.widget({ widget: this.bind(widget, false), side }).range(pos));
  }

  line(pos: number, className: string, attributes?: Record<string, string>): void {
    this.blockOnly('line');
    this.lineClasses.push(lineDecoration(className, attributes).range(this.lineStart(pos)));
  }

  hideLines(from: number, to: number): void {
    this.blockOnly('hideLines');
    const range = hideLinesDecoration.range(this.lineStart(from), this.lineEnd(to));
    this.decorations.push(range);
    this.atomic.push(range);
  }

  replaceLines(from: number, to: number, widget: RichWidget): void {
    this.blockOnly('replaceLines');
    const deco = Decoration.replace({ widget: this.bind(widget, true), block: true });
    const range = deco.range(this.lineStart(from), this.lineEnd(to));
    this.decorations.push(range);
    this.atomic.push(range);
  }

  blockWidget(pos: number, widget: RichWidget, side: -1 | 1): void {
    this.blockOnly('blockWidget');
    const deco = Decoration.widget({ widget: this.bind(widget, true), block: true, side });
    this.decorations.push(deco.range(side < 0 ? this.lineStart(pos) : this.lineEnd(pos)));
  }
}

/**
 * The document position of `node` in the editor, or null when the node is not in the
 * editor's content (CodeMirror's `posAtDOM` throws then): a widget's DOM can outlive it. In
 * inline content drawn outside the lines (a table's cell), where the first character it draws
 * comes from (`drawnSpan`).
 */
export function posOf(view: EditorView, node: Node): number | null {
  const drawn = drawnSpan(node);
  if (drawn) return drawn.from;
  try {
    return view.posAtDOM(node);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The two channels

type InlineBuild = (d: InlineDraw) => void;
type BlockBuild = (d: BlockDraw) => void;

/**
 * What a feature drew. After every edit CodeMirror checks the sets it is given directly for
 * height changes over the whole document, walking each part of a set that holds hidden or
 * replaced text. So a block feature gives what stays within a line (`inline`) as a decoration
 * source CodeMirror reads per viewport, and its line classes apart from the rest.
 */
interface Drawn {
  decorations: DecorationSet;
  lineClasses: DecorationSet;
  inline: DecorationSet;
  atomic: RangeSet<Decoration>;
  questions: Questions;
  /** What `placeKey` gave for the inline content drawn outside the lines (`BlockDraw.placeKey`). */
  placed: RangeSet<Placed>;
  /** Where other features' marks were drawn in inline content outside the lines (`BlockDraw.marks`). */
  marked: RangeSet<Marked>;
}

const nothingDrawn: Drawn = {
  decorations: Decoration.none,
  lineClasses: Decoration.none,
  inline: Decoration.none,
  atomic: RangeSet.empty,
  questions: RangeSet.empty,
  placed: RangeSet.empty,
  marked: RangeSet.empty,
};

/**
 * What `build` draws for `feature` over [from, to] of `state`, on the inline or the block channel;
 * nothing when the feature is off or throws (the fault is reported, with `view` when there is one).
 */
export function drawRange(
  feature: string,
  build: (d: Collector) => void,
  state: EditorState,
  from: number,
  to: number,
  channel: 'inline' | 'block',
  view?: EditorView,
): Drawn {
  const ctx = state.facet(panelContext);
  if (!ctx || drawsNothing(ctx, state, feature)) return nothingDrawn;
  const collector = new Collector(state, ctx, feature, from, to, channel);
  try {
    build(collector);
    if (channel === 'inline') {
      return {
        decorations: Decoration.set(collector.inline, true),
        lineClasses: Decoration.none,
        inline: Decoration.none,
        atomic: RangeSet.of(collector.atomic, true),
        questions: RangeSet.empty,
        placed: RangeSet.empty,
        marked: RangeSet.empty,
      };
    }
    return {
      decorations: Decoration.set(collector.decorations, true),
      lineClasses: Decoration.set(collector.lineClasses, true),
      inline: Decoration.set(collector.inline, true),
      atomic: RangeSet.of(collector.atomic, true),
      questions: RangeSet.of(collector.questions ?? [], true),
      placed: RangeSet.of(collector.placed, true),
      marked: RangeSet.of(collector.marked, true),
    };
  } catch (error) {
    reportFault(ctx, feature, 'build', error, view);
    return nothingDrawn;
  }
}

/**
 * Draws a block feature again over `spans` only (each a run of whole top-level blocks) and
 * keeps the rest of `current`, which is already mapped to the new document.
 */
function runPartial(
  feature: string,
  build: (d: Collector) => void,
  state: EditorState,
  current: Drawn,
  spans: Span[],
): Drawn {
  const ctx = state.facet(panelContext);
  if (!ctx || drawsNothing(ctx, state, feature)) return nothingDrawn;
  const decorations: Range<Decoration>[] = [];
  const lineClasses: Range<Decoration>[] = [];
  const inline: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const questions: Range<Question>[] = [];
  const placed: Range<Placed>[] = [];
  const marked: Range<Marked>[] = [];
  try {
    for (const span of spans) {
      const collector = new Collector(
        state,
        ctx,
        feature,
        span.from,
        span.to,
        'block',
        blocksIn(state, span.from, span.to),
      );
      build(collector);
      // Whatever lies wholly outside the span is already drawn; drawing it again would double it.
      const touching = (r: Range<RangeValue>) => r.from <= span.to && r.to >= span.from;
      decorations.push(...collector.decorations.filter(touching));
      lineClasses.push(...collector.lineClasses.filter(touching));
      inline.push(...collector.inline.filter(touching));
      atomic.push(...collector.atomic.filter(touching));
      questions.push(...collector.questions!.filter(touching));
      placed.push(...collector.placed.filter(touching));
      marked.push(...collector.marked.filter(touching));
    }
  } catch (error) {
    reportFault(ctx, feature, 'build', error);
    return nothingDrawn;
  }
  const filterFrom = spans[0]!.from;
  const filterTo = spans[spans.length - 1]!.to;
  const filter = (from: number, to: number) => outside(spans, from, to);
  return {
    decorations: current.decorations.update({ filter, filterFrom, filterTo, add: decorations, sort: true }),
    lineClasses: current.lineClasses.update({ filter, filterFrom, filterTo, add: lineClasses, sort: true }),
    inline: current.inline.update({ filter, filterFrom, filterTo, add: inline, sort: true }),
    atomic: current.atomic.update({ filter, filterFrom, filterTo, add: atomic, sort: true }),
    questions: current.questions.update({ filter, filterFrom, filterTo, add: questions, sort: true }),
    placed: current.placed.update({ filter, filterFrom, filterTo, add: placed, sort: true }),
    marked: current.marked.update({ filter, filterFrom, filterTo, add: marked, sort: true }),
  };
}

/**
 * The spans whose reveal answers flipped, widened to their top-level blocks. An answer can
 * flip only where the selection it was given (mapped to the new document) or the new one
 * touches, so only the questions on those lines are asked again.
 */
function flippedSpans(questions: Questions, tr: Transaction): Span[] {
  const state = tr.state;
  const lines = linesOf(state.doc);
  const near: Span[] = [];
  const before = revealSelection(tr.startState);
  const after = revealSelection(state);
  if (before) near.push(...widened(state, tr.docChanged ? before.map(tr.changes) : before));
  if (after) near.push(...widened(state, after));
  const spans: Span[] = [];
  for (const { from, to } of mergeSpans(near)) {
    questions.between(from, to, (qFrom, qTo, question) => {
      if (answerAgain(state, question, qFrom, qTo) !== question.answer) {
        spans.push(widenToBlocks(syntaxTree(state), lines, qFrom, qTo, false));
      }
    });
  }
  return mergeSpans(spans);
}

function treeChanged(startState: EditorState, state: EditorState): boolean {
  return syntaxTree(startState) !== syntaxTree(state);
}

function hasEffect(tr: Transaction | readonly Transaction[], feature: string): boolean {
  const list = Array.isArray(tr) ? tr : [tr as Transaction];
  for (const t of list) {
    for (const e of t.effects) {
      if ((e.is(featureFaultEffect) || e.is(redrawFeatureEffect)) && e.value === feature) return true;
      if (e.is(settingsChangedEffect)) return true;
    }
  }
  return false;
}

/** Whatever, besides the reveal answers, makes a feature draw again. */
function mustRebuild(startState: EditorState, state: EditorState, docChanged: boolean): boolean {
  return (
    docChanged ||
    getMode(startState) !== getMode(state) ||
    isRichEnabled(startState) !== isRichEnabled(state) ||
    treeChanged(startState, state)
  );
}

interface InlineSource {
  feature: string;
  build: InlineBuild;
  reads?: ((state: EditorState) => string) | undefined;
  placed?: ((state: EditorState, node: SyntaxNode) => string) | undefined;
}

interface BlockSource {
  feature: string;
  field: StateField<Drawn>;
  inline: boolean;
}

/** Every inline feature's builder, so they can also be run without a view. */
export const inlineSources = Facet.define<InlineSource>();
/** Every block feature's field. */
export const blockSources = Facet.define<BlockSource>();

interface InlineFeatureOptions {
  /**
   * What the build reads from beyond the text it draws (link definitions anywhere in the file,
   * the order of footnotes), as a key that changes when that does. A line draws again on every
   * change; inline content drawn outside the lines (`inlineDrawing`) is drawn again when a key
   * changes: all of it, or with `placed`, the content whose `placed` key changed. Keep it cheap:
   * it is asked after every change while such content is drawn.
   */
  reads?(state: EditorState): string;
  /**
   * What the build reads of where `node` stands in the file, as a key, empty when nothing: a
   * note's number. Inline content kept by its text (a table's rows) is kept by this too
   * (`placeKey`), so two equal texts in different places never share a drawing that differs
   * between them. When given, it holds everything the build reads for `node` beyond its text,
   * so that a change to `reads` draws again only the content whose key changed; and it is empty
   * only for a node that holds nothing it reads for, which its text alone can change.
   */
  placed?(state: EditorState, node: SyntaxNode): string;
}

/**
 * An inline feature: a view plugin whose `build` walks the visible part of the tree and adds
 * marks, hidden ranges and inline widgets that stay within a line. It draws again on every
 * change to the document, the viewport, the selection, the mode or the tree, and on
 * `redrawFeatureEffect.of(feature)`. The same build draws inline content shown outside the
 * lines, such as a table's cells (`inlineDrawing`).
 */
export function inlineFeature(feature: string, build: InlineBuild, options: InlineFeatureOptions = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      drawn: Drawn;
      constructor(readonly view: EditorView) {
        this.drawn = this.draw();
      }
      draw(): Drawn {
        const ranges = this.view.visibleRanges;
        const from = ranges.length ? ranges[0]!.from : this.view.viewport.from;
        const to = ranges.length ? ranges[ranges.length - 1]!.to : this.view.viewport.to;
        return drawRange(feature, build as (d: Collector) => void, this.view.state, from, to, 'inline', this.view);
      }
      update(update: ViewUpdate): void {
        if (
          mustRebuild(update.startState, update.state, update.docChanged) ||
          update.viewportChanged ||
          revealSelection(update.startState) !== revealSelection(update.state) ||
          hasEffect(update.transactions, feature)
        ) {
          this.drawn = this.draw();
        }
      }
    },
    {
      decorations: (p) => p.drawn.decorations,
      provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.drawn.atomic ?? RangeSet.empty),
    },
  );
  return [plugin, inlineSources.of({ feature, build, reads: options.reads, placed: options.placed })];
}

// ---------------------------------------------------------------------------
// Inline content drawn outside the lines

/**
 * Every inline feature's decorations over some inline content, for a feature that shows that
 * content outside the editor's lines (a table's cells): one set per inline feature, in
 * precedence order (empty for one that drew nothing or is off), positions counted from the base
 * `inlineDrawing` was given. `inlineDom` (render/inlineDom.ts) makes it into DOM as CodeMirror
 * makes a line.
 */
export type InlineDrawing = readonly DecorationSet[];

/** Whether two inline drawings of one text draw alike: the same decorations, set by set, at the same places. */
export function sameDrawing(a: InlineDrawing, b: InlineDrawing): boolean {
  if (a.length !== b.length) return false;
  return a.every((set, i) => {
    const other = b[i]!;
    if (set === other) return true;
    if (set.size !== other.size) return false;
    const there = other.iter();
    for (const here = set.iter(); here.value; here.next(), there.next()) {
      const value = there.value;
      if (!value || here.from !== there.from || here.to !== there.to) return false;
      if (here.value !== value && !(here.value.constructor === value.constructor && here.value.eq(value))) return false;
    }
    return true;
  });
}

/**
 * The inline features' drawing of the inline content in `nodes` (each a node that holds inline
 * content, such as a `TableCell`, a table's row or a `Paragraph`), as a line draws it with nothing
 * revealed, at the state's own positions. A module a build waits for draws `owner` again once it
 * has loaded.
 */
export function inlineDrawing(state: EditorState, owner: string, nodes: readonly SyntaxNode[]): InlineDrawing {
  const ctx = state.facet(panelContext);
  if (!ctx || !nodes.length) return [];
  let from = nodes[0]!.from;
  let to = nodes[0]!.to;
  for (const node of nodes) {
    from = Math.min(from, node.from);
    to = Math.max(to, node.to);
  }
  const sets: DecorationSet[] = [];
  for (const source of state.facet(inlineSources)) {
    const collector = new Collector(state, ctx, source.feature, from, to, 'outside', null, nodes, owner);
    try {
      if (!drawsNothing(ctx, state, source.feature)) source.build(collector);
    } catch (error) {
      reportFault(ctx, source.feature, 'build', error);
      collector.inline.length = 0;
    }
    sets.push(
      collector.inline.length
        ? Decoration.set(
            collector.inline.map((r) => r.value.range(r.from, r.to)),
            true,
          )
        : Decoration.none,
    );
  }
  return sets;
}

/**
 * What a state holding one part of a file in a text of its own (a grid table's cell, drawn by
 * an editor state of its own) knows of the file: the file's state, from which what the part's
 * inline content reads beyond its text is read (link definitions, footnote numbers,
 * abbreviations), and where the part's text lies in the file, line by line.
 */
export interface FilePart {
  readonly state: EditorState;
  /** Where `pos`, a position in the part's text, lies in the file. */
  at(pos: number): number;
  /** The stretches of the file that [from, to] of the part's text covers. */
  spans(from: number, to: number): Span[];
}

/** The file a state holds a part of (`FilePart`), or null for a state that holds a file of its own. */
export const filePart = Facet.define<FilePart, FilePart | null>({ combine: (parts) => parts[0] ?? null });

/** The state of the file `state` holds a part of, or `state` itself when it holds a file of its own. */
export function fileState(state: EditorState): EditorState {
  return state.facet(filePart)?.state ?? state;
}

/** For each text node of an inline drawing made into DOM, the source offset of each caret position in it. */
const textOrigins = new WeakMap<globalThis.Text, readonly number[]>();

/** For a non-text element inside an inline drawing (such as a checkbox), its source span. */
const elementOrigins = new WeakMap<Element, { from: number; to: number }>();

/** Records where each caret position of `text`, a text node of an inline drawing, stands in its source. */
export function recordOrigins(text: globalThis.Text, origins: readonly number[]): void {
  textOrigins.set(text, origins);
}

/** Records the source span of a non-text element inside an inline drawing, counted from its holder's start. */
export function recordElementOrigin(element: Element, from: number, to: number): void {
  elementOrigins.set(element, { from, to });
}

/** For a text node of an inline drawing: the source offset of each caret position in it (0 to its length). */
export function originsOf(text: globalThis.Text): readonly number[] | undefined {
  return textOrigins.get(text);
}

/** For each element that holds an inline drawing, where in the document its origins count from. */
const drawingStarts = new WeakMap<Element, () => number | null>();

/**
 * Says that the origins of the text in `element`, an inline drawing's holder (a table's cell),
 * count from the document position `start` gives when asked, null when it has none.
 */
export function setDrawingStart(element: Element, start: () => number | null): void {
  drawingStarts.set(element, start);
}

/**
 * Where in the document the text `node` draws comes from, when it lies in an inline drawing
 * outside the lines: from its first character to the end of its last. Null otherwise, or when
 * it draws no text.
 */
export function drawnSpan(node: Node): { from: number; to: number } | null {
  let holder = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (holder && !drawingStarts.has(holder)) holder = holder.parentElement;
  if (!holder) return null;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const own = elementOrigins.get(node as Element);
    if (own) {
      const start = drawingStarts.get(holder)!();
      return start === null ? null : { from: start + own.from, to: start + own.to };
    }
  }
  const texts: globalThis.Text[] = [];
  if (node.nodeType === Node.TEXT_NODE) texts.push(node as globalThis.Text);
  else {
    const walker = node.ownerDocument!.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text as globalThis.Text);
  }
  const known = texts.filter((t) => textOrigins.has(t));
  const first = known[0];
  const last = known[known.length - 1];
  const start = first && last ? drawingStarts.get(holder)!() : null;
  if (start === null || !first || !last) return null;
  return { from: start + textOrigins.get(first)![0]!, to: start + textOrigins.get(last)![last.length]! };
}

let lastEpoch = 0;

/**
 * Counts the transactions that can change how inline content draws with the same text: the
 * settings, the mode, the size limit, a feature's fault, and a redraw asked for a feature that
 * draws inline content (host answers that arrived, a module that loaded). Every state's count is
 * new, so counts never meet across editors.
 */
const inlineEpoch = StateField.define<number>({
  create: () => ++lastEpoch,
  update(value, tr) {
    if (
      tr.reconfigured ||
      getMode(tr.startState) !== getMode(tr.state) ||
      isRichEnabled(tr.startState) !== isRichEnabled(tr.state)
    )
      return ++lastEpoch;
    for (const e of tr.effects) {
      if (e.is(settingsChangedEffect) || e.is(featureFaultEffect)) return ++lastEpoch;
      if (e.is(redrawFeatureEffect) && drawsInline(tr.state, e.value)) return ++lastEpoch;
    }
    return value;
  },
});

/** Whether `feature` is an inline feature, or a block feature that shows inline content outside the lines. */
function drawsInline(state: EditorState, feature: string): boolean {
  return (
    state.facet(inlineSources).some((s) => s.feature === feature) ||
    state.facet(blockSources).some((s) => s.inline && s.feature === feature)
  );
}

/**
 * Marks a feature draws over a line's text from state of its own, not from the syntax tree (a
 * problem's underline, a find match, the mark of a line another program changed), which inline
 * content drawn outside the lines shows too. `marks` gives them over [from, to] at document
 * positions: mark decorations for text and line decorations for a line; `changed` says whether
 * a transaction changes them.
 */
export interface MarkSource {
  marks(state: EditorState, from: number, to: number): DecorationSet;
  changed(tr: Transaction): boolean;
}

/** Every feature's `MarkSource`. A block build that drew their marks (`BlockDraw.marks`) draws again where they change. */
export const markSources = Facet.define<MarkSource>();

function marksChanged(tr: Transaction): boolean {
  return tr.state.facet(markSources).some((source) => source.changed(tr));
}

/** Every `MarkSource`'s marks over [from, to], one set each, at document positions. */
export function sourceMarks(state: EditorState, from: number, to: number): DecorationSet[] {
  return state.facet(markSources).map((source) => source.marks(state, from, to));
}

/** What every inline feature reads of where `node` stands (`InlineFeatureOptions.placed`), as one key. */
export function placeKey(state: EditorState, node: SyntaxNode): string {
  let key = '';
  for (const source of state.facet(inlineSources)) {
    const placed = source.placed?.(state, node);
    if (placed) key += `\u0000${source.feature}:${placed}`;
  }
  return key;
}

const inlineKeys = new WeakMap<EditorState, string>();
const placedReadsKeys = new WeakMap<EditorState, string>();

/**
 * A key that changes whenever inline content drawn outside the lines may draw differently with
 * the same text and the same `placeKey`: the count of `inlineEpoch` and what each inline
 * feature with no `placed` `reads`. Kept per state.
 */
export function inlineKey(state: EditorState): string {
  let key = inlineKeys.get(state);
  if (key === undefined) {
    key = String(state.field(inlineEpoch, false) ?? 0);
    for (const source of state.facet(inlineSources))
      if (source.reads && !source.placed) key += `\u0000${source.reads(state)}`;
    inlineKeys.set(state, key);
  }
  return key;
}

/** What the inline features with `placed` `reads`, as one key: when it changes, placed content is looked at again. */
function placedReadsKey(state: EditorState): string {
  let key = placedReadsKeys.get(state);
  if (key === undefined) {
    key = '';
    for (const source of state.facet(inlineSources))
      if (source.reads && source.placed) key += `\u0000${source.reads(state)}`;
    placedReadsKeys.set(state, key);
  }
  return key;
}

/**
 * A run of top-level blocks drawn as one (`BlockFeatureOptions.linked`), as a range of a
 * `RangeSet`. `key` is what else decides how the whole run is drawn (a wrapper's alignment).
 */
export class LinkedRun extends RangeValue {
  constructor(readonly key: string) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other instanceof LinkedRun && other.key === this.key;
  }
}

export interface BlockFeatureOptions {
  /**
   * Runs of top-level blocks whose drawing depends on each other (an HTML wrapper's two tag
   * lines and what lies between), a pure function of the state's document and tree; a set
   * mapped through each change while the runs stay what they are, so comparing costs nothing.
   * When one appears, disappears or changes its extent or key, or a reveal answer asked inside
   * one flips, the feature draws all of it again; an edit inside one draws only what it touched.
   */
  linked?(state: EditorState): RangeSet<LinkedRun>;
  /**
   * The feature shows inline content outside the lines (`inlineDrawing`): while it has drawn
   * anything, it draws everything again when `inlineKey` changes, and what it asked
   * `placeKey` or `marks` for where their answers change.
   */
  inline?: boolean;
}

/** `spans` with every run of the `runs` sets that one of them touches added, whole. */
function withLinks(spans: Span[], runs: readonly RangeSet<LinkedRun>[], state: EditorState): Span[] {
  const lines = linesOf(state.doc);
  const tree = syntaxTree(state);
  const touched: Span[] = [];
  for (const set of runs)
    for (const span of spans) set.between(span.from, span.to, (from, to) => void touched.push({ from, to }));
  if (!touched.length) return spans;
  return mergeSpans([...spans, ...touched.map((l) => widenToBlocks(tree, lines, l.from, l.to, false))]);
}

/** Where the runs of `before` (as `tr` maps them) and of `after` differ, each widened to every run it touches. */
function changedLinks(before: RangeSet<LinkedRun>, after: RangeSet<LinkedRun>, tr: Transaction): Span[] {
  const differ: Span[] = [];
  RangeSet.compare([before], [after], tr.changes, {
    compareRange: (from, to) => void differ.push({ from, to }),
    comparePoint: (from, to) => void differ.push({ from, to }),
  });
  if (!differ.length) return [];
  return withLinks(differ, [tr.docChanged ? before.map(tr.changes) : before, after], tr.state);
}

function hasDrawn(drawn: Drawn): boolean {
  return drawn.decorations.size > 0 || drawn.inline.size > 0 || drawn.lineClasses.size > 0;
}

/**
 * A block feature: a state field feeding the editor's decorations, for line classes, block
 * widgets, hidden whole lines and anything that changes height.
 *
 * `build` first sees the whole document. After an edit (or as the tree grows) it sees only
 * the top-level blocks that changed, with one neighbor each side, and what it drew before
 * is kept everywhere else; so what it draws for a block may depend on that block, the blocks
 * holding it and its neighbors, never on blocks further away, unless the feature dispatches
 * `redrawFeatureEffect` when that further thing changes, or names it in `options.linked`. It
 * runs over everything again when the mode, the size limit or the settings change, or on
 * `redrawFeatureEffect.of(feature)`. A cursor move draws again only the blocks where the
 * answer to a reveal question it asked through `d` flipped.
 */
export function blockFeature(feature: string, build: BlockBuild, options: BlockFeatureOptions = {}): Extension {
  const draw = build as (d: Collector) => void;
  const field = StateField.define<Drawn>({
    create(state) {
      return drawRange(feature, draw, state, 0, state.doc.length, 'block');
    },
    update(value, tr) {
      const state = tr.state;
      const start = tr.startState;
      if (
        tr.reconfigured ||
        getMode(start) !== getMode(state) ||
        isRichEnabled(start) !== isRichEnabled(state) ||
        hasEffect(tr, feature) ||
        (options.inline && hasDrawn(value) && inlineKey(start) !== inlineKey(state))
      ) {
        return drawRange(feature, draw, state, 0, state.doc.length, 'block');
      }
      const ctx = state.facet(panelContext);
      if (!ctx || drawsNothing(ctx, state, feature)) return nothingDrawn;
      let current = value;
      let spans: Span[] = [];
      if (tr.docChanged || treeChanged(start, state)) {
        const damage = docDamage(tr);
        if (damage === null) return drawRange(feature, draw, state, 0, state.doc.length, 'block');
        if (tr.docChanged) {
          current = {
            decorations: value.decorations.map(tr.changes),
            lineClasses: value.lineClasses.map(tr.changes),
            inline: value.inline.map(tr.changes),
            atomic: value.atomic.map(tr.changes),
            questions: value.questions.map(tr.changes),
            placed: value.placed.map(tr.changes),
            marked: value.marked.map(tr.changes),
          };
        }
        spans = damage;
        if (options.linked) {
          const changed = changedLinks(options.linked(start), options.linked(state), tr);
          if (changed.length) spans = mergeSpans([...spans, ...changed]);
        }
      }
      if (options.inline && current.placed.size && placedReadsKey(start) !== placedReadsKey(state)) {
        // What a feature reads of where a node stands changed (a note's number, which a grown
        // tree changes often): only the nodes whose key moved are drawn again.
        const moved = movedSpans(current.placed, state);
        if (moved.length) spans = mergeSpans([...spans, ...moved]);
      }
      if (current.marked.size && marksChanged(tr)) {
        // Find, a problem or the outside-change mark changed: only the content whose marks changed is drawn again.
        const remarked = remarkedSpans(current.marked, state);
        if (remarked.length) spans = mergeSpans([...spans, ...remarked]);
      }
      if (revealSelection(start) !== revealSelection(state) || tr.docChanged) {
        let flipped = flippedSpans(current.questions, tr);
        if (flipped.length && options.linked) flipped = withLinks(flipped, [options.linked(state)], state);
        if (flipped.length) spans = mergeSpans([...spans, ...flipped]);
      }
      if (spans.length === 0) return current;
      return runPartial(feature, draw, state, current, spans);
    },
    provide: (f) => [
      EditorView.decorations.from(f, (drawn) => drawn.decorations),
      EditorView.decorations.from(f, (drawn) => drawn.lineClasses),
      EditorView.decorations.of((view) => view.state.field(f).inline),
      EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    ],
  });
  return [field, blockSources.of({ feature, field, inline: options.inline === true })];
}

// ---------------------------------------------------------------------------
// A state with no view

/**
 * `state` with its syntax tree parsed to the end (a fresh state is parsed only about 3,000
 * characters in), for a state with no view to parse it in the background: a grid table's cell.
 */
export function withFullTree(state: EditorState, timeoutMs = 10_000): EditorState {
  if (syntaxTreeAvailable(state)) return state;
  ensureSyntaxTree(state, state.doc.length, timeoutMs);
  return state.update({}).state;
}
