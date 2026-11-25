// HTML blocks, drawn as a browser draws them (docs/ARCHITECTURE.md, "HTML blocks"). A
// wrapper (`<details>` ... `</details>` around markdown) has its tag lines hidden, shown faded
// while the cursor is on them, and what lies between drawn and edited as anywhere: a <details>
// folds under its summary as its `open` says, a click folding it on the page, never in the
// file; `align` and <center> align the lines between. Any other block a browser would show is
// a drawn block (render/drawnBlock.ts) of the HTML door's nodes. A block that shows nothing is
// removed in Rich view and faded in Rich editor; tag-shaped text that names no element stays as
// typed; HTML that leaves elements open for later blocks, and every block in a workspace VS
// Code does not trust, shows as code. Wrappers among top-level blocks are kept in
// `wrapperIndex` and named to the framework as linked runs.

import { syntaxTree } from '@codemirror/language';
import { RangeSet, RangeValue, StateField, type EditorState, type Range } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import {
  pairWrappers,
  readHtmlBlock,
  readTags,
  type Align,
  type HtmlBlock,
  type TagBlock,
  type Wrapper,
} from '../html/blocks';
import { door } from '../html/load';
import { syntaxOn } from '../syntax';
import { docDamage } from './damage';
import { drawBlock, drawnBlockKeys, drawnBlockTheme, stepOntoKeys, type DrawnKind } from './drawnBlock';
import { chevron, foldTheme, foldTurned, turnedFolds, turnFold } from './folds';
import { blockFeature, posOf, RichWidget, type BlockDraw, LinkedRun } from './framework';
import { bringToLife, drawingOptions } from './htmlDrawing';
import { BLOCK_INDENT, hideWithGap } from './layout';
import { isBlankLine, type BlockEntry } from './lines';

const FEATURE = 'htmlBlocks';

/** An HTML block longer than this shows as code with a "Draw anyway" button. */
const HTML_LIMIT = 100_000;
/** The height kept for an HTML drawing never measured: about two lines. */
const HTML_ESTIMATE = 48;
/** A summary longer than this shows as code with a "Draw anyway" button. */
const SUMMARY_LIMIT = 10_000;
/** The height kept for a summary never measured: one line. */
const SUMMARY_ESTIMATE = 26;
/** What a browser shows as the summary of a <details> that has none. */
const DEFAULT_SUMMARY = 'Details';

// ---------------------------------------------------------------------------
// The wrappers among top-level blocks

/** A top-level HTML block that opens, closes, or supplies a standalone summary for a wrapper. */
class TagValue extends RangeValue {
  constructor(
    readonly shape: HtmlBlock,
    readonly summaryText = '',
  ) {
    super();
  }

  override eq(other: RangeValue): boolean {
    return other instanceof TagValue && this.summaryText === other.summaryText && sameShape(other.shape, this.shape);
  }
}

function sameShape(a: HtmlBlock, b: HtmlBlock): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'closer' && b.kind === 'closer') return a.name === b.name;
  if (a.kind === 'summary' && b.kind === 'summary') {
    return a.empty === b.empty && a.inner.from === b.inner.from && a.inner.to === b.inner.to;
  }
  if (a.kind !== 'opener' || b.kind !== 'opener') return true;
  return (
    a.name === b.name &&
    a.align === b.align &&
    a.open === b.open &&
    a.pure === b.pure &&
    a.summary?.from === b.summary?.from &&
    a.summary?.to === b.summary?.to
  );
}

/** Whether no markdown block sits strictly inside [from, to] (only blank lines or container markers). */
function noBlockBetween(state: EditorState, from: number, to: number): boolean {
  let found = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.from >= from && node.to <= to && node.type.is('Block')) {
        found = true;
        return false;
      }
      return true;
    },
  });
  return !found;
}

/**
 * The top-level tag blocks and the wrappers they make, as range sets: an edit that changes
 * no tag block maps both, which costs no more than the change, and pairs nothing again.
 */
interface WrapperIndex {
  readonly tags: RangeSet<TagValue>;
  /** Each wrapper from its opening tag block to its closing one. */
  readonly wrappers: RangeSet<LinkedRun>;
}

/** The top-level HTML blocks between `from` and `to` that open, close, or name a summary for a wrapper. */
function scanTop(state: EditorState, from: number, to: number, out: Range<TagValue>[]): void {
  for (let node = syntaxTree(state).topNode.childAfter(from - 1); node && node.from <= to; node = node.nextSibling) {
    if (node.name !== 'HTMLBlock') continue;
    const raw = state.doc.sliceString(node.from, node.to);
    const shape = readHtmlBlock(raw);
    if (shape.kind === 'opener' || shape.kind === 'closer') {
      out.push(new TagValue(shape).range(node.from, node.to));
    } else if (shape.kind === 'summary') {
      out.push(new TagValue(shape, raw.slice(shape.inner.from, shape.inner.to)).range(node.from, node.to));
    }
  }
}

/** The wrappers `tags` make, each keyed by how its opener and any standalone summary draw what it holds. */
function wrappersOf(tags: RangeSet<TagValue>, state: EditorState): RangeSet<LinkedRun> {
  const blocks: TagBlock[] = [];
  for (let cursor = tags.iter(); cursor.value; cursor.next())
    blocks.push({ from: cursor.from, to: cursor.to, shape: cursor.value.shape });
  return RangeSet.of(
    pairWrappers(blocks, (from, to) => noBlockBetween(state, from, to)).map(({ opener, closer, summary }) => {
      const { name, align, open, pure } = opener.shape;
      const sumKey = summary
        ? `${summary.from - opener.from}:${summary.to - opener.from}:${state.doc.sliceString(
            summary.from + summary.shape.inner.from,
            summary.from + summary.shape.inner.to,
          )}`
        : '';
      return new LinkedRun(`${name} ${align ?? ''} ${open} ${pure} ${sumKey}`).range(opener.from, closer.to);
    }),
    true,
  );
}

/** Whether any span in `damage` intersects the gap between an open `<details>` (without inline summary) and a following `<summary>` block. */
function touchesDetailsSummaryGap(tags: RangeSet<TagValue>, damage: readonly { from: number; to: number }[]): boolean {
  const open: { name: string; openerTo: number | null }[] = [];
  for (let cursor = tags.iter(); cursor.value; cursor.next()) {
    const shape = cursor.value.shape;
    if (shape.kind === 'opener') {
      open.push({ name: shape.name, openerTo: shape.name === 'details' && shape.summary === null ? cursor.to : null });
    } else if (shape.kind === 'summary') {
      const top = open[open.length - 1];
      if (top && top.openerTo !== null && damage.some((s) => s.from <= cursor.from && s.to >= top.openerTo!)) {
        return true;
      }
    } else if (shape.kind === 'closer') {
      let at = open.length - 1;
      while (at >= 0 && open[at]!.name !== shape.name) at--;
      if (at >= 0) open.length = at;
    }
  }
  return false;
}

function indexOf(tags: RangeSet<TagValue>, state: EditorState): WrapperIndex {
  return { tags, wrappers: wrappersOf(tags, state) };
}

const wrapperIndex = StateField.define<WrapperIndex>({
  create(state) {
    const tags: Range<TagValue>[] = [];
    scanTop(state, 0, state.doc.length, tags);
    return indexOf(RangeSet.of(tags), state);
  },
  update(value, tr) {
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) return value;
    const damage = docDamage(tr);
    if (damage === null) {
      const tags: Range<TagValue>[] = [];
      scanTop(tr.state, 0, tr.state.doc.length, tags);
      return indexOf(RangeSet.of(tags), tr.state);
    }
    // The tag blocks the change did not reach keep their reading; the rest are read again.
    const mapped = tr.docChanged ? value.tags.map(tr.changes) : value.tags;
    const before: Range<TagValue>[] = [];
    const after: Range<TagValue>[] = [];
    for (const span of damage) {
      mapped.between(span.from, span.to, (from, to, tag) => void before.push(tag.range(from, to)));
      scanTop(tr.state, span.from, span.to, after);
    }
    const same =
      before.length === after.length &&
      before.every((t, i) => t.from === after[i]!.from && t.to === after[i]!.to && t.value.eq(after[i]!.value));
    if (same && !touchesDetailsSummaryGap(mapped, damage)) {
      return { tags: mapped, wrappers: tr.docChanged ? value.wrappers.map(tr.changes) : value.wrappers };
    }
    const touched = (from: number, to: number) => damage.some((s) => from <= s.to && to >= s.from);
    const tags = same
      ? mapped
      : mapped.update({
          filter: (from, to) => !touched(from, to),
          filterFrom: damage[0]!.from,
          filterTo: damage[damage.length - 1]!.to,
          add: after,
          sort: true,
        });
    return indexOf(tags, tr.state);
  },
});

/** The top-level wrappers, for the framework (`BlockFeatureOptions.linked`). */
export function wrapperRuns(state: EditorState): RangeSet<LinkedRun> {
  return state.field(wrapperIndex, false)?.wrappers ?? RangeSet.empty;
}

/** The alignment applied by the innermost trusted HTML wrapper enclosing `pos`, or null. */
export function wrapperAlignAt(state: EditorState, pos: number): Align | null {
  if (!state.facet(panelContext)?.settings.workspaceTrusted) return null;
  if (!state.field(wrapperIndex, false)) return null;
  const enclosing = wrappersTouching(state, pos, pos).filter(
    (w) => w.opener.to < pos && pos < w.closer.from && w.opener.shape.align !== null,
  );
  if (enclosing.length === 0) return null;
  enclosing.sort((a, b) => b.opener.from - a.opener.from);
  return enclosing[0]!.opener.shape.align;
}

/** The tag block of `tags` that starts at `pos`, or with `end` ends there. */
function tagAt(tags: RangeSet<TagValue>, pos: number, end: boolean): TagBlock | null {
  let found: TagBlock | null = null;
  tags.between(pos, pos, (from, to, tag) => {
    if ((end ? to : from) === pos) found = { from, to, shape: tag.shape };
  });
  return found;
}

/** Standalone `<summary>` block right after a `<details>` opener with no blocks between them, or undefined. */
function summaryAfter(
  state: EditorState,
  tags: RangeSet<TagValue>,
  opener: Wrapper['opener'],
  closer: TagBlock,
): Wrapper['summary'] {
  if (opener.shape.name !== 'details' || opener.shape.summary !== null) return undefined;
  let found: Wrapper['summary'];
  tags.between(opener.to, closer.from, (from, to, tag) => {
    if (found || from < opener.to) return;
    if (tag.shape.kind === 'summary' && noBlockBetween(state, opener.to, from)) {
      found = { from, to, shape: tag.shape };
    }
  });
  return found;
}

/** The top-level wrappers that touch [from, to], with their two tag blocks and any standalone summary. */
function wrappersTouching(state: EditorState, from: number, to: number): Wrapper[] {
  const { tags, wrappers } = state.field(wrapperIndex);
  const out: Wrapper[] = [];
  wrappers.between(from, to, (start, end) => {
    const opener = tagAt(tags, start, false);
    const closer = tagAt(tags, end, true);
    if (opener?.shape.kind === 'opener' && closer) {
      const typedOpener = opener as Wrapper['opener'];
      const summary = summaryAfter(state, tags, typedOpener, closer);
      out.push(summary ? { opener: typedOpener, closer, summary } : { opener: typedOpener, closer });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Folding

/** Folds or unfolds the <details> whose summary is drawn at `element`. */
function toggleAt(view: EditorView, element: Element): void {
  const at = posOf(view, element);
  if (at === null) return;
  const tree = syntaxTree(view.state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolve(at, side); node; node = node.parent) {
      if (node.name !== 'HTMLBlock') continue;
      let target = node;
      if (readHtmlBlock(view.state.doc.sliceString(node.from, node.to)).kind === 'summary') {
        let prev = node.prevSibling;
        while (prev && !prev.type.is('Block')) prev = prev.prevSibling;
        if (prev?.name === 'HTMLBlock') target = prev;
      }
      const lineStart = view.state.doc.lineAt(target.from).from;
      turnFold(view, lineStart, FEATURE);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Drawings

/**
 * A drawing's text: its HTML, after a first line saying where the wrapper around it aligns it,
 * whether players are drawn, and for a summary whether its <details> is unfolded, so the
 * drawing changes when any of them does.
 */
function drawingText(html: string, align: Align | null, flag: string): string {
  return `${align ?? ''} ${flag}\n${html}`;
}

function readDrawingText(text: string): { align: Align | null; flag: string; html: string } {
  const line = text.indexOf('\n');
  const space = text.indexOf(' ');
  return {
    align: (text.slice(0, space) || null) as Align | null,
    flag: text.slice(space + 1, line),
    html: text.slice(line + 1),
  };
}

const UNFOLDED = 'open';

/** HTML a browser shows, drawn through the door. */
function htmlKind(ctx: PanelContext): DrawnKind {
  return {
    name: 'HTML',
    sentenceName: 'an HTML block',
    frameClass: 'tm-drawn-html',
    editLabel: 'Edit the HTML',
    doneLabel: 'Done editing the HTML',
    limit: HTML_LIMIT,
    estimate: HTML_ESTIMATE,
    library: door,
    draw(text) {
      const view = ctx.view();
      const { align, html } = readDrawingText(text);
      const root = view.dom.ownerDocument.createElement('div');
      root.className = align ? `tm-html-drawing tm-align-${align}` : 'tm-html-drawing';
      root.append(door.loaded()!.sanitizeHtml(html, drawingOptions(ctx)));
      return { node: root, dispose: bringToLife(view, ctx, root) };
    },
  };
}

/** The summary of a <details>, which folds and unfolds it. */
function summaryKind(ctx: PanelContext): DrawnKind {
  return {
    name: 'Details',
    sentenceName: 'a folding section',
    frameClass: 'tm-drawn-summary',
    editLabel: 'Edit the summary',
    doneLabel: 'Done editing the summary',
    limit: SUMMARY_LIMIT,
    estimate: SUMMARY_ESTIMATE,
    library: door,
    draw(text) {
      const view = ctx.view();
      const doc = view.dom.ownerDocument;
      const { align, flag, html } = readDrawingText(text);
      const open = flag === UNFOLDED;
      const head = doc.createElement('div');
      head.className = align ? `tm-details-head tm-align-${align}` : 'tm-details-head';
      const button = chevron(doc, open, 'tm-details-toggle tm-stop');
      const summary = doc.createElement('span');
      summary.className = 'tm-details-summary';
      if (html.trim()) {
        summary.append(door.loaded()!.sanitizeHtml(html, drawingOptions(ctx)));
      } else {
        summary.textContent = DEFAULT_SUMMARY;
      }
      head.append(button, summary);
      head.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('a[href]')) return;
        event.preventDefault();
        toggleAt(view, head);
      });
      return { node: head, dispose: bringToLife(view, ctx, summary) };
    },
  };
}

const kinds = new WeakMap<PanelContext, { html: DrawnKind; summary: DrawnKind }>();

function kindsOf(ctx: PanelContext): { html: DrawnKind; summary: DrawnKind } {
  let found = kinds.get(ctx);
  if (!found) kinds.set(ctx, (found = { html: htmlKind(ctx), summary: summaryKind(ctx) }));
  return found;
}

// ---------------------------------------------------------------------------
// Drawing

/** Stands in for tag lines that are hidden: no height, and the cursor steps onto them (`stepOntoKeys`). */
class HiddenTags extends RichWidget {
  override get estimatedHeight(): number {
    return 0;
  }

  draw(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('div');
    element.className = 'tm-html-hidden';
    return element;
  }

  override ignores(): boolean {
    return true;
  }
}

function codeLines(d: BlockDraw, firstLine: number, lastLine: number): void {
  for (let n = firstLine; n <= lastLine; n++) d.line(d.lines.start(n), 'tm-html');
}

/**
 * Hides a wrapper's tag lines, with the blank line after them when the line before is blank
 * too, so what follows keeps one gap; with the cursor on them (Rich editor), shows them as code.
 */
function hideTags(d: BlockDraw, firstLine: number, lastLine: number): void {
  let last = lastLine;
  const blank = (n: number) => n >= 1 && n <= d.lines.count && isBlankLine(d.lines.text(n));
  if (blank(lastLine + 1) && (firstLine === 1 || blank(firstLine - 1))) last++;
  const from = d.lines.start(firstLine);
  const to = d.lines.end(last);
  if (d.mode === 'edit' && d.blockRevealed(from, to)) codeLines(d, firstLine, lastLine);
  else d.replaceLines(from, to, new HiddenTags(d.doc.sliceString(from, to)));
}

/** A wrapper with the lines of its two tag blocks, first and last. */
interface Drawn {
  readonly wrapper: Wrapper;
  readonly openerLines: [number, number];
  readonly closerLines: [number, number];
}

/** Whether `block` holds a `<video>` or an `<audio>`. */
function holdsPlayer(d: BlockDraw, block: BlockEntry): boolean {
  return readTags(d.doc.sliceString(block.from, block.to)).tags.some(
    (tag) => !tag.closing && (tag.name === 'video' || tag.name === 'audio'),
  );
}

/** Draws one HTML block that is not a wrapper's tag block. */
function drawHtml(d: BlockDraw, block: BlockEntry, shape: HtmlBlock, align: Align | null, trusted: boolean): void {
  if (shape.kind === 'text') return;
  if (!trusted) return codeLines(d, block.firstLine, block.lastLine);
  switch (shape.kind) {
    case 'invisible':
      if (d.mode === 'view') hideWithGap(d, block);
      else codeLines(d, block.firstLine, block.lastLine);
      return;
    case 'summary':
      if (shape.empty) {
        if (d.mode === 'view') hideWithGap(d, block);
        else codeLines(d, block.firstLine, block.lastLine);
        return;
      }
      if (holdsPlayer(d, block) && !syntaxOn(d.ctx.settings, 'media'))
        return codeLines(d, block.firstLine, block.lastLine);
      return drawSource(d, block, align);
    case 'drawing':
      // A player is drawn only under `tandemMarkdown.syntax.media`; without it the block is shown as typed.
      if (holdsPlayer(d, block) && !syntaxOn(d.ctx.settings, 'media'))
        return codeLines(d, block.firstLine, block.lastLine);
      return drawSource(d, block, align);
    case 'opener':
      // Its closer is not there: one that holds more than its tag is drawn as it is, the rest is code.
      if (shape.pure) codeLines(d, block.firstLine, block.lastLine);
      else drawSource(d, block, align);
      return;
    default:
      codeLines(d, block.firstLine, block.lastLine);
  }
}

function drawSource(d: BlockDraw, block: BlockEntry, align: Align | null): void {
  const media = syntaxOn(d.ctx.settings, 'media') ? 'media' : '';
  const text = drawingText(d.doc.sliceString(block.from, block.to), align, media);
  drawBlock(d, block, kindsOf(d.ctx).html, text, false);
}

function folded(state: EditorState, shape: Extract<HtmlBlock, { kind: 'opener' }>, lineStart: number): boolean {
  if (shape.name !== 'details') return false;
  return shape.open === foldTurned(state, lineStart);
}

function draw(d: BlockDraw): void {
  const trusted = d.ctx.settings.workspaceTrusted;
  const entries = new Map<number, { block: BlockEntry; shape: HtmlBlock }>();
  /** The tag blocks inside a list item or a quote, by their parent; top-level ones are in the index. */
  const nested = new Map<string, TagBlock[]>();
  d.blocks((block) => {
    if (block.name !== 'HTMLBlock') return;
    const shape = readHtmlBlock(d.doc.sliceString(block.from, block.to));
    entries.set(block.from, { block, shape });
    if (block.top || (shape.kind !== 'opener' && shape.kind !== 'closer' && shape.kind !== 'summary')) return;
    const parent = block.node.parent!;
    const key = `${parent.name}:${parent.from}:${parent.to}`;
    const list = nested.get(key) ?? [];
    list.push({ from: block.from, to: block.to, shape });
    nested.set(key, list);
  });

  const wrappers: Wrapper[] = [];
  if (trusted) {
    wrappers.push(...wrappersTouching(d.state, d.from, d.to));
    for (const list of nested.values()) {
      wrappers.push(...pairWrappers(list, (from, to) => noBlockBetween(d.state, from, to)));
    }
    wrappers.sort((a, b) => a.opener.from - b.opener.from);
  }

  const first = d.lines.numberAt(d.from);
  const last = d.lines.numberAt(d.to);
  const lineAlign = new Map<number, Align>();
  const tagLines = new Set<number>();
  /** Lines hidden by a folded <details>, first and last. */
  const hidden: [number, number][] = [];
  const inHidden = (n: number) => hidden.some(([a, b]) => n >= a && n <= b);
  const paired = new Set<number>();

  const drawnWrappers: Drawn[] = wrappers.map((wrapper) => ({
    wrapper,
    openerLines: [
      d.lines.numberAt(wrapper.opener.from),
      d.lines.numberAt(wrapper.summary ? wrapper.summary.to : wrapper.opener.to),
    ],
    closerLines: [d.lines.numberAt(wrapper.closer.from), d.lines.numberAt(wrapper.closer.to)],
  }));
  for (const { wrapper, openerLines, closerLines } of drawnWrappers) {
    paired.add(wrapper.opener.from).add(wrapper.closer.from);
    if (wrapper.summary) paired.add(wrapper.summary.from);
    for (let n = openerLines[0]; n <= openerLines[1]; n++) tagLines.add(n);
    for (let n = closerLines[0]; n <= closerLines[1]; n++) tagLines.add(n);
    const align = wrapper.opener.shape.align;
    if (align)
      for (let n = Math.max(first, openerLines[1] + 1); n < closerLines[0] && n <= last; n++) lineAlign.set(n, align);
  }

  for (const { wrapper, openerLines, closerLines } of drawnWrappers) {
    if (inHidden(openerLines[0])) continue;
    const shape = wrapper.opener.shape;
    const opener = entries.get(wrapper.opener.from);
    const closer = entries.get(wrapper.closer.from);
    let open = true;
    if (folded(d.state, shape, d.lines.start(openerLines[0]))) {
      // Everything after the summary up to the end tag; the blank line after it keeps the gap
      // below. A selection inside unfolds it, but not the cursor on the blank line right after
      // the summary, where closing the summary's source puts it.
      const hideFrom = d.lines.start(openerLines[1] + 1);
      const hideTo = d.lines.end(closerLines[1]);
      let firstText = openerLines[1] + 1;
      while (firstText < closerLines[0] && isBlankLine(d.lines.text(firstText))) firstText++;
      open = d.blockRevealed(d.lines.start(firstText), hideTo);
      if (!open) {
        hidden.push([openerLines[1] + 1, closerLines[1]]);
        if (openerLines[1] + 1 <= last && closerLines[1] >= first) d.hideLines(hideFrom, hideTo);
      }
    }
    if (opener) {
      if (shape.name === 'details') {
        const headBlock: BlockEntry = wrapper.summary
          ? { ...opener.block, to: wrapper.summary.to, lastLine: openerLines[1] }
          : opener.block;
        const summary = wrapper.summary
          ? d.doc.sliceString(
              wrapper.summary.from + wrapper.summary.shape.inner.from,
              wrapper.summary.from + wrapper.summary.shape.inner.to,
            )
          : shape.summary
            ? d.doc.sliceString(opener.block.from + shape.summary.from, opener.block.from + shape.summary.to)
            : '';
        const text = drawingText(summary, lineAlign.get(openerLines[0]) ?? null, open ? UNFOLDED : '');
        drawBlock(d, headBlock, kindsOf(d.ctx).summary, text, false);
      } else if (shape.pure) {
        hideTags(d, openerLines[0], openerLines[1]);
      } else {
        drawSource(d, opener.block, lineAlign.get(openerLines[0]) ?? shape.align);
      }
    }
    if (closer && open) hideTags(d, closerLines[0], closerLines[1]);
  }

  for (const [from, { block, shape }] of entries) {
    if (paired.has(from) || inHidden(block.firstLine)) continue;
    drawHtml(d, block, shape, lineAlign.get(block.firstLine) ?? null, trusted);
  }
  for (const [n, align] of lineAlign)
    if (!tagLines.has(n) && !inHidden(n)) d.line(d.lines.start(n), `tm-align-${align}`);
}

export const htmlBlocks: Feature = {
  id: FEATURE,
  extension: () => [
    wrapperIndex,
    turnedFolds,
    blockFeature(FEATURE, draw, { linked: wrapperRuns }),
    drawnBlockKeys,
    stepOntoKeys((widget) => widget instanceof HiddenTags),
    drawnBlockTheme,
    foldTheme,
    EditorView.baseTheme({
      '& .cm-content .tm-html-hidden': { height: '0' },
      '& .cm-content .tm-align-left': { textAlign: 'left' },
      '& .cm-content .tm-align-center': { textAlign: 'center' },
      '& .cm-content .tm-align-right': { textAlign: 'right' },
      '& .cm-content .tm-align-justify': { textAlign: 'justify' },
      '& .cm-content .tm-drawn.tm-drawn-html': { padding: '2px 32px 2px 0', paddingLeft: BLOCK_INDENT },
      '& .cm-content .tm-drawn.tm-drawn-summary': { padding: '0 32px 0 0', paddingLeft: BLOCK_INDENT },
      '& .cm-content :is(.tm-drawn-html, .tm-drawn-summary) > .tm-drawn-body': { padding: '0' },
      '& .cm-content .tm-drawn-summary .tm-drawn-edit': { top: '0' },
      '& .cm-content .tm-details-head': {
        display: 'flex',
        alignItems: 'center',
        gap: '0.3em',
        cursor: 'pointer',
        minHeight: '1.6em',
      },
      '& .cm-content .tm-details-head.tm-align-center': { justifyContent: 'center' },
      '& .cm-content .tm-details-head.tm-align-right': { justifyContent: 'flex-end' },
      // What a browser draws, in the measurements of GitHub's stylesheet.
      '& .cm-content .tm-html-drawing': { lineHeight: '1.5', overflowWrap: 'break-word' },
      '& .cm-content .tm-html-drawing > :first-child': { marginTop: '0' },
      '& .cm-content .tm-html-drawing > :last-child': { marginBottom: '0' },
      '& .cm-content .tm-html-drawing :is(p, blockquote, ul, ol, dl, table, pre, details, figure)': {
        marginTop: '0',
        marginBottom: '16px',
      },
      '& .cm-content .tm-html-drawing :is(h1, h2, h3, h4, h5, h6)': {
        marginTop: '24px',
        marginBottom: '16px',
        fontWeight: '600',
        lineHeight: '1.25',
      },
      '& .cm-content .tm-html-drawing h1': {
        fontSize: '2em',
        paddingBottom: '0.3em',
        borderBottom: '1px solid var(--tm-border)',
      },
      '& .cm-content .tm-html-drawing h2': {
        fontSize: '1.5em',
        paddingBottom: '0.3em',
        borderBottom: '1px solid var(--tm-border)',
      },
      '& .cm-content .tm-html-drawing h3': { fontSize: '1.25em' },
      '& .cm-content .tm-html-drawing h4': { fontSize: '1em' },
      '& .cm-content .tm-html-drawing h5': { fontSize: '0.875em' },
      '& .cm-content .tm-html-drawing h6': { fontSize: '0.85em', color: 'var(--tm-faded)' },
      '& .cm-content .tm-html-drawing :is(ul, ol)': { paddingLeft: '2em' },
      '& .cm-content .tm-html-drawing blockquote': {
        margin: '0 0 16px',
        padding: '0 1em',
        color: 'var(--tm-faded)',
        borderLeft: '0.25em solid var(--tm-border)',
      },
      '& .cm-content .tm-html-drawing table': {
        borderCollapse: 'collapse',
        display: 'block',
        width: 'max-content',
        maxWidth: '100%',
        overflow: 'auto',
      },
      '& .cm-content .tm-html-drawing :is(th, td)': { padding: '6px 13px', border: '1px solid var(--tm-border)' },
      '& .cm-content .tm-html-drawing th': { fontWeight: '600' },
      '& .cm-content .tm-html-drawing :is(code, tt, kbd, samp, pre)': {
        fontFamily: 'var(--tm-mono)',
        fontSize: '0.85em',
      },
      '& .cm-content .tm-html-drawing pre': {
        padding: '16px',
        overflow: 'auto',
        background: 'var(--tm-code-bg)',
        borderRadius: '6px',
      },
      '& .cm-content .tm-html-drawing :not(pre) > code': {
        padding: '0.2em 0.4em',
        background: 'var(--tm-code-bg)',
        borderRadius: '6px',
      },
      '& .cm-content .tm-html-drawing kbd': {
        padding: '0.15em 0.35em',
        border: '1px solid var(--tm-border)',
        borderBottomWidth: '2px',
        borderRadius: '4px',
        background: 'var(--tm-widget-bg)',
      },
      '& .cm-content .tm-html-drawing hr': {
        height: '0.25em',
        margin: '24px 0',
        padding: '0',
        border: '0',
        background: 'var(--tm-hr)',
      },
      '& .cm-content .tm-html-drawing mark': { background: 'var(--tm-highlight-bg)', color: 'inherit' },
      '& .cm-content .tm-html-drawing summary': { cursor: 'pointer' },
      '& .cm-content .tm-html-drawing figure': { margin: '0 0 16px' },
      '& .cm-content .tm-html-drawing figcaption': { color: 'var(--tm-faded)', fontSize: '0.9em' },
      '& .cm-content .tm-html-float-left': { float: 'left', marginRight: '8px' },
      '& .cm-content .tm-html-float-right': { float: 'right', marginLeft: '8px' },
    }),
  ],
};
