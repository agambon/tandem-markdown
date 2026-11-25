// Inline content drawn outside the editor's lines, such as a table's cells: the inline
// features' decorations over it (`inlineDrawing` in framework.ts) made into DOM as CodeMirror
// makes a line. Marks nest by precedence, a replaced range is drawn as its widget or left out,
// and the rest is text. Each text node records where its characters come from in the source
// (`originsOf` in framework.ts), so a click on the drawing can be placed in the source.
//
// Such content never reveals its marks. A mark whose spec names a class as `whenHidden` (find's
// current match) and whose text the drawing hides wholly, as a link's address, marks with that
// class the visible text nearest it instead (`nearestVisible`), as find does in Rich view's lines.

import { RangeSet, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView } from '@codemirror/view';
import { recordOrigins, RichWidget, type InlineDrawing } from './framework';

/** What `inlineDom` made: the nodes, and each widget drawn among them with its element. */
interface DrawnInline {
  nodes: Node[];
  widgets: [HTMLElement, RichWidget][];
}

/** The mark decoration each element `inlineDom` made for a mark stands for. */
const markOf = new WeakMap<Node, Decoration>();

function markElement(doc: Document, mark: Decoration): HTMLElement {
  const spec = mark.spec as { class?: string; attributes?: Record<string, string>; tagName?: string };
  const element = doc.createElement(spec.tagName ?? 'span');
  if (spec.class) element.className = spec.class;
  for (const [name, value] of Object.entries(spec.attributes ?? {})) element.setAttribute(name, value);
  markOf.set(element, mark);
  return element;
}

/** Text nodes inside a widget's element stand for the whole of [from, to]. */
function originsInWidget(element: HTMLElement, from: number, to: number): void {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.length;
    // A caret in the first half stands before the source, one in the second half after it.
    recordOrigins(
      node,
      Array.from({ length: length + 1 }, (_, k) => (k * 2 <= length ? from : to)),
    );
  }
}

/** How far either side of a hidden range the text nearest it is looked for. */
export const NEAR_WINDOW = 400;
/** The longest word `nearestVisible` marks. */
const NEAR_WORD_MAX = 40;

/** A range a drawing hides, or draws a widget in place of. */
export interface Covered {
  from: number;
  to: number;
  widget: boolean;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * When the whole of [from, to] is hidden (and no widget stands for it), the span of visible
 * text nearest it: the word just before it on its line, else the word just after, else the
 * nearer of the two in the document. Null when some of it shows, or a widget shows it.
 */
export function nearestVisible(
  doc: { length: number; sliceString(from: number, to: number): string },
  hidden: readonly Covered[],
  from: number,
  to: number,
): { from: number; to: number } | null {
  if (to <= from) return null;
  const spans = hidden.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from);
  // Some of the match shows: CodeMirror's own match mark is on that part.
  let reach = from;
  for (const span of spans) {
    if (span.to <= reach) continue;
    if (span.from > reach) break;
    reach = span.to;
    if (reach >= to) break;
  }
  if (reach < to) return null;
  // A widget drawn in its place shows it (a table, a code block's header).
  if (spans.some((s) => s.widget && s.from < to && s.to > from)) return null;

  const winFrom = Math.max(0, from - NEAR_WINDOW);
  const winTo = Math.min(doc.length, to + NEAR_WINDOW);
  const text = doc.sliceString(winFrom, winTo);
  const at = (pos: number) => text[pos - winFrom] ?? '';
  const visible = (pos: number) => !spans.some((s) => pos >= s.from && pos < s.to);

  // The nearest visible word character each way; failing that, any visible character.
  const scan = (start: number, end: number, step: 1 | -1): number => {
    let any = -1;
    for (let p = start; step > 0 ? p < end : p >= end; p += step) {
      if (!visible(p) || isSpace(at(p))) continue;
      if (isWordChar(at(p))) return p;
      if (any < 0) any = p;
    }
    return any;
  };
  const back = scan(from - 1, winFrom, -1);
  const forward = scan(to, winTo, 1);
  if (back < 0 && forward < 0) return null;
  const sameLine = (a: number, b: number) =>
    !text.slice(Math.min(a, b) - winFrom, Math.max(a, b) - winFrom).includes('\n');
  let pick: number;
  if (back >= 0 && sameLine(back, from)) pick = back;
  else if (forward >= 0 && sameLine(to, forward)) pick = forward;
  else if (back < 0) pick = forward;
  else if (forward < 0) pick = back;
  else pick = from - back <= forward - to ? back : forward;

  let start = pick;
  let end = pick + 1;
  if (isWordChar(at(pick))) {
    while (start > winFrom && end - start < NEAR_WORD_MAX && visible(start - 1) && isWordChar(at(start - 1))) start--;
    while (end < winTo && end - start < NEAR_WORD_MAX && visible(end) && isWordChar(at(end))) end++;
  }
  return { from: start, to: end };
}

/**
 * Marks of the class each mark over [from, to] names as `whenHidden`, over the visible text
 * nearest it, for each such mark whose text there `drawing` hides wholly.
 */
function nearMarks(drawing: InlineDrawing, text: string, from: number, to: number): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const doc = { length: text.length, sliceString: (s: number, e: number) => text.slice(s, e) };
  let covered: Covered[] | null = null;
  /** What the drawing hides or replaces; outside [from, to] is not this content's, so nothing there shows in it. */
  const hidden = (): Covered[] => {
    if (covered) return covered;
    covered = [
      { from: 0, to: from, widget: false },
      { from: to, to: text.length, widget: false },
    ];
    for (const set of drawing)
      set.between(from, to, (f, t, deco) => {
        if ((deco as Decoration & { point: boolean }).point && t > f)
          covered!.push({ from: f, to: t, widget: !!deco.spec.widget });
      });
    return covered;
  };
  for (const set of drawing) {
    set.between(from, to, (a, b, deco) => {
      const near = (deco.spec as { whenHidden?: string }).whenHidden;
      const at = near ? nearestVisible(doc, hidden(), Math.max(a, from), Math.min(b, to)) : null;
      if (near && at) marks.push(Decoration.mark({ class: near }).range(at.from, at.to));
    });
  }
  return marks.length ? Decoration.set(marks, true) : Decoration.none;
}

/**
 * DOM for [from, to] of `text` as `drawing` draws it (positions in both counted alike). The origin
 * of a position is `origin(pos)`, by default its offset from `from`. Widgets are drawn with
 * `view`; the caller destroys them when their elements leave the page.
 */
export function inlineDom(
  view: EditorView,
  drawing: InlineDrawing,
  text: string,
  from: number,
  to: number,
  origin: (pos: number) => number = (pos) => pos - from,
): DrawnInline {
  const doc = view.dom.ownerDocument;
  const root = doc.createDocumentFragment();
  const widgets: [HTMLElement, RichWidget][] = [];

  // As CodeMirror nests marks in a line: the last active mark outermost, reusing one still open.
  const parentFor = (active: readonly Decoration[], openStart: number): ParentNode => {
    let parent: ParentNode = root;
    for (let i = active.length - 1; i >= 0; i--) {
      const mark = active[i]!;
      const last = parent.lastChild;
      if (openStart > 0 && last && markOf.get(last)?.eq(mark)) {
        parent = last as HTMLElement;
        openStart--;
      } else {
        const element = markElement(doc, mark);
        parent.appendChild(element);
        parent = element;
        openStart = 0;
      }
    }
    return parent;
  };

  RangeSet.spans([...drawing, nearMarks(drawing, text, from, to)], from, to, {
    span(start, end, active, openStart) {
      const node = doc.createTextNode(text.slice(start, end));
      recordOrigins(
        node,
        Array.from({ length: end - start + 1 }, (_, k) => origin(start + k)),
      );
      parentFor(active, openStart).appendChild(node);
    },
    point(start, end, deco, active, openStart) {
      const widget = deco.spec.widget as unknown;
      // A hidden range draws nothing; a widget that began before `from` is drawn already.
      if (!(widget instanceof RichWidget) || openStart > active.length) return;
      const element = widget.toDOM(view);
      originsInWidget(element, origin(start), origin(end));
      widgets.push([element, widget]);
      parentFor(active, openStart).appendChild(element);
    },
  });
  return { nodes: [...root.childNodes], widgets };
}

/**
 * The text a reader takes from [from, to] of `doc` as `drawing` draws it: what shows, with a
 * widget read as its `plainText`. For a name or a card that shows no drawing.
 */
export function inlineText(
  drawing: InlineDrawing,
  doc: { sliceString(from: number, to: number): string },
  from: number,
  to: number,
): string {
  let out = '';
  RangeSet.spans(drawing, from, to, {
    span(start, end) {
      out += doc.sliceString(start, end);
    },
    point(_start, _end, deco, active, openStart) {
      const widget = deco.spec.widget as unknown;
      if (widget instanceof RichWidget && openStart <= active.length) out += widget.plainText;
    },
  });
  return out;
}
