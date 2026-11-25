// Outside-change mark: the lines another program changed are outlined, each until it has been on
// screen, and the outline then fades over FADE_STEPS steps. Deleted text shows nothing.
//
// The outline is drawn in a layer above the text, around each marked line or table row, or what
// stands for lines no line of their own draws (a diagram, a folded callout's head), its edges in
// the leading and the margin beside the text column: it lays nothing under any text, and changes
// no text, selection or line height. Its color is the theme's for inserted text, made to stand
// out from the page (`markColor`), and is read again when the theme changes.
// Which updates are from outside, and where their text now stands: src/panel/outsideChanges.ts.
// `tandemMarkdown.outsideChanges.highlight` turns it off.

import {
  MapMode,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Text,
  type Transaction,
} from '@codemirror/state';
import {
  BlockType,
  Decoration,
  EditorView,
  ViewPlugin,
  layer,
  type DecorationSet,
  type LayerMarker,
  type ViewUpdate,
} from '@codemirror/view';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { changedLineStarts, insertedSpans, receivedChanges } from '../outsideChanges';
import { tabShownField } from '../tabShown';
import { contrast, cssColor, mix, over, parseColor, type Rgba } from '../theme/contrast';
import { onThemeChange } from '../theme/themeChanges';
import { markSources } from './framework';
import { layerBase } from './layers';
import type { Span } from './lines';

/**
 * The fade's steps and how long each lasts. Each step is a CSS transition between step
 * classes, so an outline drawn again mid-fade picks up where it was.
 */
export const FADE_STEPS = 8;
const FADE_STEP_MS = 500;

/**
 * The lines an update from outside changed in this transaction, as line starts in its new
 * document. Empty for a transaction that applies no update from outside.
 */
function outsideLines(tr: Transaction): number[] {
  if (!tr.docChanged) return [];
  const ranges = receivedChanges(tr)
    .filter((u) => u.outside)
    .flatMap(insertedSpans);
  return ranges.length === 0 ? [] : changedLineStarts(tr.state.doc, ranges);
}

// ---------------------------------------------------------------------------
// The marked lines

/** A line another program changed: where it starts, and the fade steps it has passed on screen, 0 to FADE_STEPS - 1. */
interface MarkedLine {
  from: number;
  age: number;
}

interface MarkState {
  /** By line start, one entry a line. */
  lines: readonly MarkedLine[];
  decorations: DecorationSet;
}

/**
 * One fade step has passed for the marked lines that start in the effect's ranges, the parts of
 * the note on screen (dispatched every FADE_STEP_MS by the fader below; tests dispatch it).
 */
export const fadeStep = StateEffect.define<readonly Span[]>();

const LINE = Array.from({ length: FADE_STEPS }, (_, age) => Decoration.line({ class: `tm-outside tm-outside-${age}` }));

function enabled(state: EditorState): boolean {
  return state.facet(panelContext)?.settings.outsideHighlight !== false;
}

/** `lines` sorted by start, one entry a line: of two at one start, the one with fewer steps passed. */
function byLine(lines: Iterable<MarkedLine>): MarkedLine[] {
  const ages = new Map<number, number>();
  for (const { from, age } of lines) ages.set(from, Math.min(age, ages.get(from) ?? age));
  return [...ages].sort(([a], [b]) => a - b).map(([from, age]) => ({ from, age }));
}

/** Marked lines carried through an edit; a line whose start was deleted around is dropped. */
function mapLines(lines: readonly MarkedLine[], doc: Text, changes: ChangeDesc): MarkedLine[] {
  const out: MarkedLine[] = [];
  for (const { from, age } of lines) {
    const pos = changes.mapPos(from, -1, MapMode.TrackDel);
    if (pos !== null) out.push({ from: doc.lineAt(pos).from, age });
  }
  return byLine(out);
}

function build(lines: readonly MarkedLine[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, age } of lines) builder.add(from, from, LINE[age]!);
  return builder.finish();
}

export const outsideMarkField = StateField.define<MarkState>({
  create: () => ({ lines: [], decorations: Decoration.none }),
  update(value, tr) {
    let lines = value.lines;
    let changed = false;
    if (tr.docChanged && lines.length > 0) {
      lines = mapLines(lines, tr.state.doc, tr.changes);
      changed = true;
    }
    for (const e of tr.effects) {
      if (!e.is(fadeStep)) continue;
      const seen = (at: number) => e.value.some((r) => at >= r.from && at <= r.to);
      lines = lines.map((l) => (seen(l.from) ? { from: l.from, age: l.age + 1 } : l)).filter((l) => l.age < FADE_STEPS);
      changed = true;
    }
    if (tr.docChanged && enabled(tr.startState)) {
      const fresh = outsideLines(tr);
      if (fresh.length > 0) {
        // A line changed again starts its fade again.
        lines = byLine([...lines, ...fresh.map((from) => ({ from, age: 0 }))]);
        changed = true;
      }
    }
    return changed ? { lines, decorations: build(lines) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

// ---------------------------------------------------------------------------
// The outline's color

/**
 * The outline's least contrast with the page: what WCAG asks of body text, above its 3:1 for a
 * mark a person needs to see, since the outline is all that shows the change.
 */
const MARK_FLOOR = 4.5;
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
/** Halvings in a search for the color a rule allows: within 1/65536 of it. */
const SEARCH_STEPS = 16;

/** The theme's colors the outline is made from, as the page draws them. */
export interface ThemeColors {
  page: Rgba;
  text: Rgba;
  /** The theme's color for an inserted line; null where the page gives none. */
  inserted: Rgba | null;
  /** The theme's border for inserted text; null where it gives none, as only high contrast themes do. */
  border: Rgba | null;
}

/** For `holds` true from 0 up to some point in [0, 1] and false after it: the last value it holds for. */
function lastHolding(holds: (t: number) => boolean): number {
  if (holds(1)) return 1;
  let [low, high] = [0, 1];
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const middle = (low + high) / 2;
    if (holds(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * The outline's color in a theme, opaque and in whole channels. It starts from the theme's
 * border for inserted text, else its inserted-line color made opaque, else its text color; it is
 * darkened on a light page, or lightened on a dark one, as far as it takes to stand out from the
 * page by MARK_FLOOR.
 */
export function markColor({ page: drawn, text, inserted, border }: ThemeColors): Rgba {
  // Taken as opaque, as every built-in theme's editor background is.
  const page = { ...drawn, a: 1 };
  const start = { ...(border ?? inserted ?? over(text, page)), a: 1 };
  const away = contrast(BLACK, page) > contrast(WHITE, page) ? BLACK : WHITE;
  // Whole channels, as `cssColor` writes them, so the color as written keeps MARK_FLOOR.
  const at = (t: number) => {
    const { r, g, b } = mix(start, away, t);
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: 1 };
  };
  return at(1 - lastHolding((u) => contrast(at(1 - u), page) >= MARK_FLOOR));
}

/**
 * The colors the outline is made from, as the page around `view` draws them; null while the
 * editor has no ground of its own yet (before the panel's styles apply) or is not drawn. The
 * inserted-line color is `--tm-inserted` (theme/panel.css): the theme's, or where the page gives
 * none, the one VS Code gives every theme that is not high contrast; a high contrast theme gives
 * the border, which `markColor` takes first.
 */
function drawnColors(view: EditorView): ThemeColors | null {
  const editor = getComputedStyle(view.dom);
  const page = parseColor(editor.backgroundColor);
  const text = parseColor(editor.color);
  if (!page || !text || page.a === 0) return null;
  const color = (property: string) => parseColor(editor.getPropertyValue(property));
  return {
    page,
    text,
    inserted: color('--tm-inserted'),
    border: color('--vscode-diffEditor-insertedTextBorder'),
  };
}

/** Reads the page's colors and gives the outline its own from them (`markColor`), in a measure cycle. */
function measureColors(view: EditorView): void {
  view.requestMeasure({
    key: measureColors,
    read: () => {
      const colors = drawnColors(view);
      return colors && markColor(colors);
    },
    write: (color) => {
      if (color) view.dom.style.setProperty('--tm-outside-mark', cssColor(color));
    },
  });
}

// ---------------------------------------------------------------------------
// The fade

/**
 * The part of the note in the panel's view, as a range of the document; null while the page is
 * hidden (VS Code's window minimized, say), while the tab is not shown (`tabShownField`, which the
 * host keeps, since VS Code hides a tab kept behind another with a style on its own page that this
 * page cannot see), or while the view has no height.
 */
function onScreen(view: EditorView): Span | null {
  const doc = view.dom.ownerDocument;
  if (doc.visibilityState !== 'visible' || !view.state.field(tabShownField)) return null;
  const rect = view.scrollDOM.getBoundingClientRect();
  if (rect.height <= 0) return null;
  const top = view.lineBlockAtHeight(Math.max(0, rect.top - view.documentTop));
  const bottom = view.lineBlockAtHeight(Math.max(0, rect.bottom - view.documentTop));
  return { from: top.from, to: bottom.to };
}

/**
 * Moves the fade of the marked lines in view one step every FADE_STEP_MS while any line is
 * marked, and stops when none is: a line marked out of view keeps its outline until it has been
 * in the panel's view (`onScreen`). Reads the page's colors when the panel starts and whenever
 * VS Code changes the theme.
 */
const fader = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly stopWatching: () => void;
    constructor(private readonly view: EditorView) {
      measureColors(view);
      this.stopWatching = onThemeChange(view.dom.ownerDocument, () => measureColors(view));
      this.follow();
    }
    update(update: ViewUpdate): void {
      if (update.state.field(outsideMarkField) !== update.startState.field(outsideMarkField)) this.follow();
    }
    private follow(): void {
      const busy = this.view.state.field(outsideMarkField).lines.length > 0;
      if (busy && this.timer === null) {
        this.timer = setInterval(() => this.step(), FADE_STEP_MS);
      } else if (!busy && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
    private step(): void {
      const seen = onScreen(this.view);
      if (!seen) return;
      const lines = this.view.state.field(outsideMarkField).lines;
      if (lines.some((l) => l.from >= seen.from && l.from <= seen.to))
        this.view.dispatch({ effects: fadeStep.of([seen]) });
    }
    destroy(): void {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.stopWatching();
    }
  },
);

// ---------------------------------------------------------------------------
// The outline

/**
 * The outline's sides, in the margin, and its top and bottom, which lie between lines of text:
 * two code lines leave less than 2 px between their text. Then how far it stands out past the
 * line's sides. In CSS pixels.
 */
const OUTLINE_SIDE_PX = 2;
const OUTLINE_EDGE_PX = 1;
const OUTLINE_OUTSET_PX = 6;
/** The outline's corner radius, a code block's (panel.css). */
const OUTLINE_RADIUS_PX = 3;

/** The fade step an element is marked at, from its step class; null for one not marked. */
function ageOf(element: Element): number | null {
  for (let age = 0; age < FADE_STEPS; age++) if (element.classList.contains(`tm-outside-${age}`)) return age;
  return null;
}

/**
 * The outline around a run of marked lines, or table rows, at one step of the fade. It keeps its
 * element while the run's first line or row keeps its own, so its steps fade as the line's do.
 */
class Outline implements LayerMarker {
  constructor(
    readonly around: Element,
    readonly age: number,
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof Outline &&
      other.around === this.around &&
      other.age === this.age &&
      other.left === this.left &&
      other.top === this.top &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  draw(): HTMLElement {
    const outline = this.around.ownerDocument.createElement('div');
    this.place(outline);
    return outline;
  }

  update(outline: HTMLElement, previous: LayerMarker): boolean {
    if (!(previous instanceof Outline) || previous.around !== this.around) return false;
    this.place(outline);
    return true;
  }

  private place(outline: HTMLElement): void {
    outline.className = `tm-outside-outline tm-outside-${this.age}`;
    const s = outline.style;
    s.left = `${this.left}px`;
    s.top = `${this.top}px`;
    s.width = `${this.width}px`;
    s.height = `${this.height}px`;
  }
}

/**
 * For each marked line in view that no line of its own draws, what stands for it on screen, with
 * the fewest fade steps any of the lines it stands for has passed: the block drawn in the line's
 * place (a diagram, front matter's table), or for a line hidden away, the line or block that its
 * run of hidden lines follows (a folded callout's head, a folded <details>'s summary). Hidden lines
 * that follow a blank line begin a block of their own that shows nothing (an HTML comment in Rich
 * view), and nothing stands for them. A block that shows marks inside it, as a table does on its
 * rows, stands for nothing: its rows are outlined.
 */
function standIns(view: EditorView, lines: readonly MarkedLine[]): Map<Element, number> {
  const out = new Map<Element, number>();
  const { doc } = view.state;
  const { from: viewFrom, to: viewTo } = view.viewport;
  // The content's lines and the blocks drawn in the place of whole lines, by where each starts.
  let drawn: { lines: Map<number, Element>; blocks: Map<number, Element> } | null = null;
  const drawnAt = (pos: number, line: boolean): Element | undefined => {
    if (!drawn) {
      drawn = { lines: new Map(), blocks: new Map() };
      // CodeMirror's own position for each, not the first character a drawing shows (`posOf`).
      for (const child of view.contentDOM.children)
        (child.classList.contains('cm-line') ? drawn.lines : drawn.blocks).set(view.posAtDOM(child), child);
    }
    return (line ? drawn.lines : drawn.blocks).get(pos);
  };
  for (const { from, age } of lines) {
    if (from < viewFrom || from > viewTo) continue;
    let block = view.lineBlockAt(from);
    if (block.type !== BlockType.WidgetRange) continue;
    if (block.height === 0) {
      while (block.type === BlockType.WidgetRange && block.height === 0 && block.from > 0)
        block = view.lineBlockAt(block.from - 1);
      if (block.height === 0) continue;
      if (block.type !== BlockType.WidgetRange && doc.sliceString(block.from, block.to).trim() === '') continue;
    }
    const element =
      block.type === BlockType.WidgetRange ? drawnAt(block.from, false) : drawnAt(doc.lineAt(block.from).from, true);
    if (!element || element.querySelector('.tm-outside')) continue;
    out.set(element, Math.min(age, out.get(element) ?? age));
  }
  return out;
}

/**
 * An outline around each run of marked lines in view, at one step, around each run of table
 * rows with marked cells, and around what stands for marked lines that no line of their own
 * draws (`standIns`): around a line's text and padding, not the gap above it, or a block's whole
 * box, and OUTLINE_OUTSET_PX past its sides, into the margin.
 */
function outlines(view: EditorView): Outline[] {
  const { lines } = view.state.field(outsideMarkField);
  if (lines.length === 0) return [];
  const content = view.contentDOM;
  // What each outline goes around, with the fewest fade steps its lines have passed.
  const around = new Map<Element, number>();
  const add = (element: Element, age: number) => around.set(element, Math.min(age, around.get(element) ?? age));
  for (const marked of content.querySelectorAll('.tm-outside')) {
    const age = ageOf(marked);
    if (age !== null) add(marked.parentElement === content ? marked : (marked.closest('tr') ?? marked), age);
  }
  for (const [element, age] of standIns(view, lines)) add(element, age);
  const base = layerBase(view);
  const boxes: { around: Element; age: number; left: number; right: number; top: number; bottom: number }[] = [];
  for (const [element, age] of around) {
    const rect = element.getBoundingClientRect();
    // A line's gap above it is its top border.
    const line = element.parentElement === content && element.classList.contains('cm-line');
    const top = (rect.top - base.top) / view.scaleY + (line ? element.clientTop : 0);
    const height = line ? element.clientHeight : rect.height / view.scaleY;
    const left = (rect.left - base.left) / view.scaleX - OUTLINE_OUTSET_PX;
    const right = (rect.right - base.left) / view.scaleX + OUTLINE_OUTSET_PX;
    boxes.push({ around: element, age, left, right, top, bottom: top + height });
  }
  boxes.sort((a, b) => a.top - b.top);
  const out: Outline[] = [];
  let run: (typeof boxes)[number] | null = null;
  // The top and bottom edges lie on the run's first and last line boundaries, in the leading of
  // the lines on both sides.
  const half = OUTLINE_EDGE_PX / 2;
  const close = () => {
    if (!run) return;
    out.push(
      new Outline(run.around, run.age, run.left, run.top - half, run.right - run.left, run.bottom - run.top + 2 * half),
    );
  };
  for (const box of boxes) {
    // One outline for lines one under the other, at one step and of one width.
    const joins =
      run &&
      run.age === box.age &&
      Math.abs(run.left - box.left) < 0.5 &&
      Math.abs(run.right - box.right) < 0.5 &&
      Math.abs(run.bottom - box.top) < 0.5;
    if (joins) run!.bottom = box.bottom;
    else {
      close();
      run = { ...box };
    }
  }
  close();
  return out;
}

function outlinesMove(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.startState.field(outsideMarkField) !== update.state.field(outsideMarkField)
  );
}

// ---------------------------------------------------------------------------
// The styles

/**
 * The outline at each step: full at the first, nothing at the last, each step fading from the one
 * before. With reduced motion asked for, it stays full and goes at once when its last step ends.
 */
function stepStyles(): Record<string, Record<string, string | Record<string, string>>> {
  const out: Record<string, Record<string, string | Record<string, string>>> = {};
  const still: Record<string, Record<string, string>> = {};
  for (let age = 0; age < FADE_STEPS; age++) {
    const strength = (FADE_STEPS - 1 - age) / (FADE_STEPS - 1);
    const selector = `.tm-outside-outlines .tm-outside-${age}`;
    out[`& ${selector}`] = {
      opacity: `${Math.round(strength * 1000) / 1000}`,
      transition: age === 0 ? 'none' : `opacity ${FADE_STEP_MS}ms linear`,
    };
    // Inside an at-rule a selector takes no `&`: the theme scopes it as it scopes a plain one.
    still[selector] = { opacity: '1', transition: 'none' };
  }
  out['@media (prefers-reduced-motion: reduce)'] = still;
  return out;
}

export const outsideMark: Feature = {
  id: 'outsideMark',
  extension: () => [
    outsideMarkField,
    tabShownField,
    fader,
    layer({ above: true, class: 'tm-outside-outlines', update: outlinesMove, markers: outlines }),
    // A table's row stands for its line: its cells take the line's classes, which place the outline.
    markSources.of({
      marks: (state) => state.field(outsideMarkField).decorations,
      changed: (tr) => tr.startState.field(outsideMarkField) !== tr.state.field(outsideMarkField),
    }),
    EditorView.baseTheme({
      // Until the page's colors are read (`measureColors`), the outline shows nothing.
      '&': { '--tm-outside-mark': 'transparent' },
      '& .tm-outside-outlines .tm-outside-outline': {
        boxSizing: 'border-box',
        border: `${OUTLINE_EDGE_PX}px solid var(--tm-outside-mark)`,
        borderLeftWidth: `${OUTLINE_SIDE_PX}px`,
        borderRightWidth: `${OUTLINE_SIDE_PX}px`,
        borderRadius: `${OUTLINE_RADIUS_PX}px`,
        pointerEvents: 'none',
      },
      ...stepStyles(),
    }),
  ],
};
