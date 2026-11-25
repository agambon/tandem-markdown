// A drawn block: a block of the document shown as a drawing that looks nothing like its source
// (a math block, a block of HTML), built once for every kind (docs/ARCHITECTURE.md, "Drawn
// blocks"). A block feature calls `drawBlock` for each one; a `DrawnKind` says how to draw it.
//
// Closed, the drawing stands in place of the block's lines; a click on it leaves the cursor
// where it is. The pencil at its corner (Rich editor), or the cursor moved into the block,
// opens it: the source shows as code with the drawing beneath, drawn again DRAW_PAUSE_MS after
// the typing stops. Then the pencil is a check mark that closes it, as do Escape, a click on
// the drawing and the cursor leaving it. Rich view has no pencil and never opens a block.
//
// Against a hang: a block longer than its kind's limit, or one whose drawing was under way when
// the page last went away (`SESSION_MARK`), shows as code with a "Draw anyway" button.

import { syntaxTree } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, type WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { errorMessage } from '../../core/errors';
import { panelContext, type PanelContext } from '../context';
import { getMode } from '../modes';
import type { OnDemand } from '../onDemand';
import { iconButton } from '../ui/dom';
import { keyName, type KeyBinding } from '../ui/keys';
import { codeLines } from './code';
import { leaveSelectionOnClick, posOf, redrawFeatureEffect, RichWidget, type BlockDraw } from './framework';
import { BLOCK_INDENT, blockLayoutClasses } from './layout';
import type { BlockEntry, Span } from './lines';
import { LruCache } from './lruCache';

/**
 * A drawing, or what is wrong with the source. `controls` are buttons that act on the drawing,
 * shown at the frame's corner under the pencil while it is the drawing in place. `dispose` frees
 * what the drawing holds (a watch of the host's answers, an embedded note's editor) once another
 * replaces it or it leaves the page.
 */
export type Drawing = { node: Node; controls?: readonly HTMLElement[]; dispose?(): void } | { error: string };

export interface DrawnKind<Given = void> {
  /** What a drawing is, for a screen reader: "Math". */
  readonly name: string;
  /**
   * What a drawing is as a sentence names it, in the guide's words: "a math block"
   * (src/panel/announce/). None for a grid table, which the sentences read from the tree as a table.
   */
  readonly sentenceName?: string;
  /** A class for this kind's frame, beside `tm-drawn`, for its own spacing. */
  readonly frameClass?: string;
  /** The pencil's label while the block is closed: "Edit the math". */
  readonly editLabel: string;
  /** Its label while the block is open, when it closes the block: "Done editing the math". */
  readonly doneLabel: string;
  /** A block whose text is longer than this shows as code with a "Draw anyway" button. */
  readonly limit: number;
  /** The height, in pixels, kept for a drawing never measured before it is made. */
  readonly estimate: number;
  /** The library that draws it, loaded on first use; none when it needs none. */
  readonly library?: OnDemand<unknown>;
  /**
   * `source` drawn for `view`, or what is wrong with it, with what the build gave beside the text
   * (`drawBlock`). Called only once its library has loaded; throws nothing.
   */
  draw(source: string, view: EditorView, given: Given): Drawing | Promise<Drawing>;
}

/** How long typing in an open block must pause before its drawing is made again. */
export const DRAW_PAUSE_MS = 400;

/** The session-storage key that holds the block being drawn while it is drawn. */
const SESSION_MARK = 'tm-drawing';

/** The key that closes an open block, as the pencil's tooltip names it. */
const CLOSE_KEY: KeyBinding = { key: 'escape' };

/** What a click inside a drawing acts on itself, so the click does not close the block. */
const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label';

/** Blocks whose drawing was under way when the page last went away, by key. */
const suspects = new Set<string>();
try {
  const left = sessionStorage.getItem(SESSION_MARK);
  if (left) suspects.add(left);
  sessionStorage.removeItem(SESSION_MARK);
} catch {
  // No session storage (tests, or storage turned off): no block is held back.
}

/** Blocks the user asked to draw anyway, per panel. */
const forced = new WeakMap<PanelContext, Set<string>>();

function forcedIn(ctx: PanelContext): Set<string> {
  let set = forced.get(ctx);
  if (!set) forced.set(ctx, (set = new Set()));
  return set;
}

/** A short hash of `text`, FNV-1a over its UTF-16 code units, with the length. */
function keyOf(kind: DrawnKind<unknown>, text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${kind.name}:${text.length}:${(hash >>> 0).toString(36)}`;
}

/** Drawing heights kept. */
const CACHE_SIZE = 500;
/** The height each drawing was last drawn at, by key, so a drawing not yet made keeps its place. */
const heights = new LruCache<string, number>(CACHE_SIZE);

function rememberHeight(key: string, height: number): void {
  if (!(height > 0)) return;
  heights.set(key, height);
}

/** Draws `source` with the session mark set while it is drawn. */
async function drawMarked(
  kind: DrawnKind<unknown>,
  key: string,
  source: string,
  given: unknown,
  view: EditorView,
): Promise<Drawing> {
  setMark(key);
  try {
    return await kind.draw(source, view, given);
  } catch (error) {
    return { error: errorMessage(error) };
  } finally {
    setMark(null);
  }
}

function setMark(key: string | null): void {
  try {
    if (key) sessionStorage.setItem(SESSION_MARK, key);
    else sessionStorage.removeItem(SESSION_MARK);
  } catch {
    // No session storage: the guard is not kept.
  }
}

/** What one drawing's element shows and is waiting for. */
interface Shown {
  kind: DrawnKind<unknown>;
  key: string;
  source: string;
  /** What the build gave beside `source`. */
  given: unknown;
  /** The text waiting to be drawn after the pause, and what was given beside it. */
  pending: { source: string; given: unknown } | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bumped by every drawing started, so a slow one cannot replace a later one. */
  generation: number;
  /** Frees what the drawing in place holds. */
  dispose: (() => void) | null;
}

const shown = new WeakMap<HTMLElement, Shown>();

/**
 * Fills `frame` with the drawing of `state.source`, keeping the last good drawing on a mistake.
 * The frame is `aria-busy` until the drawing or the mistake shows, and `tm-drawn-waiting`
 * while it has nothing to show yet.
 */
function fill(view: EditorView, frame: HTMLElement, state: Shown): void {
  const generation = ++state.generation;
  const { kind, key, source, given } = state;
  const body = frame.querySelector<HTMLElement>('.tm-drawn-body')!;
  frame.setAttribute('aria-busy', 'true');
  if (!body.hasChildNodes()) frame.classList.add('tm-drawn-waiting');
  const show = (drawing: Drawing) => {
    if (generation !== state.generation) {
      if ('node' in drawing) drawing.dispose?.();
      return;
    }
    const message = frame.querySelector<HTMLElement>('.tm-drawn-error')!;
    // The drawing, or the mistake beside the last good drawing (with none yet, the message alone).
    if ('node' in drawing) {
      state.dispose?.();
      state.dispose = drawing.dispose ?? null;
      body.replaceChildren(drawing.node);
      message.textContent = '';
    } else {
      message.textContent = drawing.error;
    }
    // A drawing's buttons act on that drawing: none beside a mistake, though the last good drawing stays.
    setControls(frame, 'node' in drawing ? (drawing.controls ?? []) : []);
    frame.classList.toggle('tm-drawn-failed', !('node' in drawing));
    frame.classList.remove('tm-drawn-waiting');
    frame.removeAttribute('aria-busy');
    body.style.minHeight = '';
    // A frame CodeMirror has set aside for the moment is measured when it is back.
    if (!frame.isConnected) return;
    view.requestMeasure({
      read: () => body.getBoundingClientRect().height,
      write: (height) => {
        if ('node' in drawing) rememberHeight(key, height);
      },
    });
  };
  if (kind.library && kind.library.loaded() === undefined) {
    kind.library.load().then(
      () => {
        if (generation === state.generation) fill(view, frame, state);
      },
      (error: unknown) => {
        view.state.facet(panelContext)?.log('error', `Could not load what draws ${kind.name}`, error);
        show({ error: `${kind.name} could not be drawn: what draws it did not load.` });
      },
    );
    return;
  }
  void drawMarked(kind, key, source, given, view).then(show);
}

/** Puts `controls` at the corner of `frame`, in place of the ones there. */
function setControls(frame: HTMLElement, controls: readonly HTMLElement[]): void {
  frame.querySelector(':scope > .tm-drawn-controls')?.remove();
  if (!controls.length) return;
  const holder = frame.ownerDocument.createElement('div');
  holder.className = 'tm-drawn-controls';
  holder.append(...controls);
  frame.appendChild(holder);
}

/** The pencil at a drawing's corner: whether its block is open, and what a press does. */
interface Pencil {
  open: boolean;
  press(): void;
}

/**
 * The frame every drawing sits in: the drawing, a line for a mistake, and the pencil when there
 * is one. A drawing wider than the page scrolls inside its body, so the pencil, which belongs
 * to the frame, stays at the corner.
 */
function frameFor(
  view: EditorView,
  kind: DrawnKind<unknown>,
  key: string,
  pencil: Pencil | null,
  layout: string,
): HTMLElement {
  const doc = view.dom.ownerDocument;
  const frame = doc.createElement('div');
  const parts = ['tm-drawn'];
  if (kind.frameClass) parts.push(kind.frameClass);
  if (layout) parts.push(layout);
  frame.className = parts.join(' ');
  frame.setAttribute('role', 'group');
  frame.setAttribute('aria-label', kind.name);
  const body = doc.createElement('div');
  body.className = 'tm-drawn-body';
  const known = heights.get(key);
  body.style.minHeight = `${known ?? kind.estimate}px`;
  const message = doc.createElement('div');
  message.className = 'tm-drawn-error';
  message.setAttribute('role', 'status');
  frame.append(body, message);
  if (pencil) {
    const button = iconButton(doc, {
      icon: pencil.open ? 'check' : 'edit',
      label: pencil.open ? `${kind.doneLabel} (${keyName(CLOSE_KEY)})` : kind.editLabel,
      className: 'tm-drawn-edit',
      keepFocus: true,
    });
    button.classList.add('tm-stop');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      pencil.press();
    });
    frame.appendChild(button);
  }
  return frame;
}

/** What a block widget draws, as a sentence names it ("a diagram"); null for a widget that is no drawing, or has no such name. */
export function drawingName(widget: WidgetType | null): string | null {
  return widget instanceof DrawingWidget ? (widget.kind.sentenceName ?? null) : null;
}

abstract class DrawingWidget extends RichWidget {
  protected readonly key: string;

  constructor(
    source: string,
    readonly kind: DrawnKind<unknown>,
    readonly text: string,
    /** What the build gave beside `text`, which holds a key of it: two drawings of one text are alike. */
    readonly given: unknown,
  ) {
    super(source);
    this.key = keyOf(kind, text);
  }

  override get estimatedHeight(): number {
    return heights.get(this.key) ?? this.kind.estimate;
  }

  protected start(view: EditorView, frame: HTMLElement): void {
    const state: Shown = {
      kind: this.kind,
      key: this.key,
      source: this.text,
      given: this.given,
      pending: null,
      timer: null,
      generation: 0,
      dispose: null,
    };
    shown.set(frame, state);
    fill(view, frame, state);
  }

  override destroy(dom: HTMLElement): void {
    const state = shown.get(dom);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    // A drawing still being made is dropped when it arrives.
    state.generation++;
    state.dispose?.();
    state.dispose = null;
    shown.delete(dom);
  }

  /** Clicks on the drawing stay with it: they do not move the cursor. */
  override ignores(): boolean {
    return true;
  }
}

/** The drawing in place of a closed block's lines; with a pencil that opens it when `opens`. */
class ClosedDrawing extends DrawingWidget {
  constructor(
    source: string,
    kind: DrawnKind<unknown>,
    text: string,
    given: unknown,
    readonly opens: boolean,
    readonly layout: string,
  ) {
    super(source, kind, text, given);
  }

  override sameAs(other: ClosedDrawing): boolean {
    return (
      other.kind === this.kind && other.text === this.text && other.opens === this.opens && other.layout === this.layout
    );
  }

  draw(view: EditorView): HTMLElement {
    const pencil = this.opens ? { open: false, press: () => openBlock(view, frame) } : null;
    const frame = frameFor(view, this.kind, this.key, pencil, this.layout);
    leaveSelectionOnClick(view, frame);
    this.start(view, frame);
    return frame;
  }
}

/** Puts the cursor at the start of the block drawn in `frame`, which opens it, and focuses the editor. */
function openBlock(view: EditorView, frame: HTMLElement): void {
  const at = posOf(view, frame);
  if (at === null) return;
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select' });
  view.focus();
}

/**
 * The drawing beneath an open block's source. It keeps its element while the source is typed
 * in. A click on it closes the block, and so does its pencil when `closable`.
 */
class OpenDrawing extends DrawingWidget {
  constructor(
    source: string,
    kind: DrawnKind<unknown>,
    text: string,
    given: unknown,
    readonly closable: boolean,
    readonly layout: string,
  ) {
    super(source, kind, text, given);
  }

  override sameAs(other: OpenDrawing): boolean {
    return (
      other.kind === this.kind &&
      other.text === this.text &&
      other.closable === this.closable &&
      other.layout === this.layout
    );
  }

  draw(view: EditorView): HTMLElement {
    const pencil = this.closable ? { open: true, press: () => closeAt(view, frame) } : null;
    const frame = frameFor(view, this.kind, this.key, pencil, this.layout);
    frame.classList.add('tm-drawn-open');
    frame.addEventListener('click', (event) => {
      // A click the drawing acted on itself (a link it followed) leaves the block open.
      if (event.defaultPrevented) return;
      if (event.target instanceof Element && !event.target.closest(INTERACTIVE)) closeAt(view, frame);
    });
    this.start(view, frame);
    return frame;
  }

  /** The source changed: draw it again once the typing pauses. */
  override redraw(dom: HTMLElement, view: EditorView): boolean {
    const state = shown.get(dom);
    if (!state || state.kind !== this.kind) return false;
    if ((dom.querySelector(':scope > .tm-drawn-edit') !== null) !== this.closable) return false;
    state.pending = { source: this.text, given: this.given };
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.pending === null || !dom.isConnected) return;
      state.source = state.pending.source;
      state.given = state.pending.given;
      state.key = keyOf(state.kind, state.source);
      state.pending = null;
      fill(view, dom, state);
    }, DRAW_PAUSE_MS);
    return true;
  }
}

/** Whether the line ending at `lineEnd` has an open block's drawing beneath it. */
function openDrawingAfter(view: EditorView, lineEnd: number): boolean {
  const { type } = view.lineBlockAt(lineEnd);
  return Array.isArray(type) && type.some((part) => part.widget instanceof OpenDrawing);
}

/**
 * The lines of the open block that `pos` is in: the innermost block node around `pos`'s line
 * whose last line has an open drawing beneath it. Null when `pos` is in no open block. The
 * markdown tree alone is climbed, not a language mounted in a block (HTML, a fence's code).
 */
function openBlockAt(view: EditorView, pos: number): Span | null {
  const { doc } = view.state;
  const line = doc.lineAt(pos);
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolve(line.to, -1); node; node = node.parent) {
    if (node.type.isTop) break;
    if (!node.type.is('Block')) continue;
    const last = doc.lineAt(node.to);
    if (openDrawingAfter(view, last.to)) return { from: doc.lineAt(node.from).from, to: last.to };
  }
  return null;
}

/**
 * Closes the open block whose lines are `block` by putting the cursor just outside it: at the
 * start of the line after it, or, when it ends the document, at the end of the line before it.
 * The page is not scrolled unless the cursor would leave the window. False when the block is
 * the whole document.
 */
function closeBlock(view: EditorView, block: Span): boolean {
  const { doc } = view.state;
  const at = block.to < doc.length ? block.to + 1 : block.from > 0 ? block.from - 1 : -1;
  if (at < 0) return false;
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select' });
  view.focus();
  return true;
}

/**
 * Where the first line of the block drawn in the frame holding `element` starts, found when
 * asked; null when the frame is not in the editor. An open block's drawing stands beneath its
 * last line.
 */
export function drawnBlockStart(view: EditorView, element: Element): number | null {
  const frame = element.closest('.tm-drawn');
  const at = frame ? posOf(view, frame) : null;
  if (at === null || !frame) return null;
  return frame.classList.contains('tm-drawn-open') ? (openBlockAt(view, at)?.from ?? null) : at;
}

/** Closes the open block drawn in `frame`. */
function closeAt(view: EditorView, frame: HTMLElement): void {
  const at = posOf(view, frame);
  const block = at === null ? null : openBlockAt(view, at);
  if (block) closeBlock(view, block);
}

/** Escape with the cursor in an open block closes it. */
function closeFromKeyboard(view: EditorView): boolean {
  const { state } = view;
  if (getMode(state) !== 'edit' || state.selection.ranges.length !== 1) return false;
  const block = openBlockAt(view, state.selection.main.head);
  return block !== null && closeBlock(view, block);
}

/** Beneath a block shown as code because of a limit: why, and a button that draws it anyway. */
class DrawAnyway extends RichWidget {
  constructor(
    source: string,
    readonly kind: DrawnKind<unknown>,
    readonly key: string,
    readonly reason: string,
    readonly layout: string,
  ) {
    super(source);
  }

  override sameAs(other: DrawAnyway): boolean {
    return (
      other.kind === this.kind && other.key === this.key && other.reason === this.reason && other.layout === this.layout
    );
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const bar = doc.createElement('div');
    bar.className = this.layout ? `tm-drawn-held ${this.layout}` : 'tm-drawn-held';
    const text = doc.createElement('span');
    text.textContent = this.reason;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'tm-drawn-anyway tm-stop';
    button.textContent = 'Draw anyway';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const ctx = this.ctx ?? view.state.facet(panelContext);
      if (!ctx) return;
      suspects.delete(this.key);
      forcedIn(ctx).add(this.key);
      view.dispatch({ effects: redrawFeatureEffect.of(this.feature) });
    });
    bar.append(text, button);
    return bar;
  }

  override ignores(): boolean {
    return true;
  }
}

/** The source lines of a block, shown as code. */
function sourceLines(d: BlockDraw, block: BlockEntry, fences: boolean): void {
  const fenceLines = fences ? [block.firstLine, block.lastLine] : [];
  codeLines(d, block.firstLine, block.lastLine, 'tm-drawn-source', fenceLines);
}

/**
 * Draws `block` as a drawing of `text` by `kind`: closed, open or held back by a limit. For a
 * block feature's build; `fences` says the block's first and last lines are its delimiters
 * (`$$`, a fence), shown faded while it is open. `given` goes to the kind's `draw` beside the
 * text: what the drawing reads that the text does not hold (the state it was built in), of
 * which the text holds a key, so that drawings of one text are alike.
 */
export function drawBlock(d: BlockDraw, block: BlockEntry, kind: DrawnKind, text: string, fences: boolean): void;
export function drawBlock<Given>(
  d: BlockDraw,
  block: BlockEntry,
  kind: DrawnKind<Given>,
  text: string,
  fences: boolean,
  given: Given,
): void;
export function drawBlock(
  d: BlockDraw,
  block: BlockEntry,
  kind: DrawnKind<unknown>,
  text: string,
  fences: boolean,
  given?: unknown,
): void {
  const source = d.doc.sliceString(block.from, block.to);
  const key = keyOf(kind, text);
  const layout = blockLayoutClasses(block);
  if (!forcedIn(d.ctx).has(key)) {
    const reason =
      text.length > kind.limit
        ? `Not drawn: longer than ${kind.limit.toLocaleString('en')} characters.`
        : suspects.has(key)
          ? 'Not drawn: drawing it was under way when this tab last stopped.'
          : null;
    if (reason) {
      sourceLines(d, block, fences);
      d.blockWidget(block.to, new DrawAnyway(source, kind, key, reason, layout), 1);
      return;
    }
  }
  const editable = d.mode === 'edit' && !d.ctx.doc.readOnly;
  if (d.mode === 'edit' && d.blockRevealed(block.from, block.to)) {
    sourceLines(d, block, fences);
    // A block that is the whole document has nowhere outside it for the cursor to go.
    const whole = d.lines.start(block.firstLine) === 0 && d.lines.end(block.lastLine) === d.doc.length;
    d.blockWidget(block.to, new OpenDrawing(source, kind, text, given, editable && !whole, layout), 1);
    return;
  }
  d.replaceLines(block.from, block.to, new ClosedDrawing(source, kind, text, given, editable, layout));
}

/**
 * Up or Down from the line beside a widget that stands in for whole lines and that `accepts`:
 * CodeMirror's own motion steps over such a widget. This puts the cursor at its edge instead,
 * which reveals what it stands for. Lines hidden in between with nothing in their place (a
 * folded section) are passed over, as CodeMirror passes them. False (CodeMirror moves as
 * usual) anywhere else.
 */
function stepInto(view: EditorView, forward: boolean, accepts: (widget: unknown) => boolean): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (getMode(state) !== 'edit' || state.selection.ranges.length !== 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (forward ? line.to >= state.doc.length : line.from === 0) return false;
  let beside = view.lineBlockAt(forward ? line.to + 1 : line.from - 1);
  while (!beside.widget && beside.height === 0 && (forward ? beside.to < state.doc.length : beside.from > 0))
    beside = view.lineBlockAt(forward ? beside.to + 1 : beside.from - 1);
  if (!accepts(beside.widget)) return false;
  const next = view.moveVertically(range, forward);
  if (forward ? next.head <= line.to : next.head >= line.from) return false;
  view.dispatch({
    selection: { anchor: forward ? beside.from : beside.to },
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}

/**
 * Up and Down that step onto the lines a widget accepted by `accepts` stands for, instead of
 * over them, so the cursor can reach lines that are hidden until it is on them.
 */
export function stepOntoKeys(accepts: (widget: unknown) => boolean): Extension {
  return Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: (view) => stepInto(view, true, accepts) },
      { key: 'ArrowUp', run: (view) => stepInto(view, false, accepts) },
    ]),
  );
}

/** The keys that open a drawing from beside it and close an open one; every feature that draws them adds this. */
export const drawnBlockKeys = [
  stepOntoKeys((widget) => widget instanceof ClosedDrawing),
  // Below the base keymap, whose Escape first reduces several ranges, or a selected range, to
  // a cursor, and below the find box's Escape.
  keymap.of([{ key: 'Escape', run: closeFromKeyboard }]),
];

/** The look of a small button at a drawing's corner: the pencil that opens its source, and a drawing's own controls. */
export const CORNER_BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  padding: '0',
  border: 'none',
  borderRadius: '3px',
  background: 'none',
  color: 'var(--tm-faded)',
  cursor: 'pointer',
};

/** The look of a corner button (`CORNER_BUTTON`) under the pointer. */
export const CORNER_BUTTON_HOVER = { background: 'var(--tm-button2-bg)', color: 'var(--tm-fg)' };

/** The styles of drawn blocks; every feature that draws them adds this. */
export const drawnBlockTheme = EditorView.baseTheme({
  '& .cm-content .tm-drawn': {
    position: 'relative',
    boxSizing: 'border-box',
    padding: '0 28px',
    paddingLeft: `calc(${BLOCK_INDENT} + 28px)`,
  },
  // The padding is inside what scrolls, so a drawing's parts that reach a little past its box
  // (KaTeX's struts) are not cut off.
  '& .cm-content .tm-drawn-body': {
    boxSizing: 'border-box',
    padding: '8px 4px',
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  '& .cm-content .tm-drawn-open': { borderTop: '1px dashed var(--tm-border)' },
  '& .cm-content .tm-drawn-waiting .tm-drawn-body': { background: 'var(--tm-code-bg)', borderRadius: '3px' },
  '& .cm-content .tm-drawn-error': { color: 'var(--tm-error)', fontSize: '0.85em', fontFamily: 'var(--tm-ui-font)' },
  '& .cm-content .tm-drawn-error:empty': { display: 'none' },
  '& .cm-content .tm-drawn-edit': { position: 'absolute', top: '4px', right: '2px' },
  // A drawing's own buttons stand at the corner, under the pencil when there is one.
  '& .cm-content .tm-drawn-controls': {
    position: 'absolute',
    top: '4px',
    right: '2px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  '& .cm-content .tm-drawn-edit ~ .tm-drawn-controls': { top: '30px' },
  '& .cm-content .tm-drawn-edit, & .cm-content .tm-drawn-control': CORNER_BUTTON,
  '& .cm-content .tm-drawn-edit:hover, & .cm-content .tm-drawn-control:hover': CORNER_BUTTON_HOVER,
  '& .cm-content .tm-drawn-held': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 0 8px',
    paddingLeft: BLOCK_INDENT,
    color: 'var(--tm-faded)',
    fontFamily: 'var(--tm-ui-font)',
    fontSize: '0.85em',
  },
  '& .cm-content .tm-drawn-anyway': {
    font: 'inherit',
    padding: '1px 8px',
    border: 'none',
    borderRadius: '2px',
    background: 'var(--tm-button2-bg)',
    color: 'var(--tm-button2-fg)',
    cursor: 'pointer',
  },
  '& .cm-content .tm-drawn-anyway:hover': { background: 'var(--tm-button2-hover-bg)' },
  '& .cm-content .tm-drawn-edit:focus-visible, & .cm-content .tm-drawn-control:focus-visible, & .cm-content .tm-drawn-anyway:focus-visible':
    {
      outline: '1px solid var(--tm-focus)',
      outlineOffset: '1px',
    },
});
