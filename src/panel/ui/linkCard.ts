// The link card: hovering a link, in either view, shows a small card with where it goes and an
// Open button. For a wikilink it says which file it opens; a missing one says so (and has no
// Open button); an ambiguous one lists the other files the target also matches. For a footnote
// it shows the note's text, with a button that goes to the note, or back from a note's number to
// its first reference; the note's text is what a line draws of it, read as plain text, and for a
// note written in a grid table's cell, what the cell draws of it. Built with CodeMirror's hover
// tooltip; text only through textContent.

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import {
  closeHoverTooltips,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { linkAt, readPointerLink, type LinkTarget } from '../links/read';
import { treeForLine } from '../markdown/tree';
import { getMode } from '../modes';
import { drawnSpan, inlineDrawing, originsOf } from '../render/framework';
import { gridCellState } from '../render/gridTables';
import { inlineText } from '../render/inlineDom';
import { openTarget } from '../render/links';
import { wikilinkResolution } from '../render/wikilinks';
import { cellAt, fileGrid } from '../tables/gridCells';

/** How long the pointer rests on a link before its card shows; ui/noteCard.ts waits as long. */
export const HOVER_MS = 500;

// ---------------------------------------------------------------------------
// Cards over inline content drawn outside the lines

/** Where the pointer last moved in each view. */
const pointers = new WeakMap<EditorView, { x: number; y: number }>();

/** Keeps where the pointer last moved, for `hoverPlace`. */
const trackPointer = ViewPlugin.define((view) => {
  const move = (event: MouseEvent) => pointers.set(view, { x: event.clientX, y: event.clientY });
  view.dom.addEventListener('mousemove', move);
  return { destroy: () => view.dom.removeEventListener('mousemove', move) };
});

/** A link found under the pointer in inline content drawn outside the lines, and what shows it. */
interface DrawnPlace {
  pos: number;
  side: -1 | 1;
  /** The text under the pointer, whose parent shows the link. */
  text: Text;
}

/**
 * Where the pointer is in the document when it rests on inline content drawn outside the lines,
 * such as a table's cell: CodeMirror gives a hover card a widget's start there, so the card looks
 * at the character under the pointer instead. Null elsewhere.
 */
export function hoverPlace(view: EditorView): DrawnPlace | null {
  const pointer = pointers.get(view);
  const caret = pointer && view.dom.ownerDocument.caretPositionFromPoint(pointer.x, pointer.y);
  if (!caret || caret.offsetNode.nodeType !== Node.TEXT_NODE || !view.contentDOM.contains(caret.offsetNode))
    return null;
  const text = caret.offsetNode as Text;
  const origins = originsOf(text);
  const start = origins && drawnSpan(text);
  if (!origins || !start) return null;
  const at = start.from - origins[0]! + origins[Math.min(caret.offset, text.length)]!;
  return { pos: at, side: caret.offset < text.length ? 1 : -1, text };
}

/**
 * A card for what `place` found, which stands at [from, to] of the document: kept while the
 * pointer is over the drawing that holds it, set beside the element that draws it, and closed
 * when the pointer leaves that element for anything but the card.
 */
function drawnCard(
  view: EditorView,
  place: DrawnPlace,
  from: number,
  to: number,
  make: (view: EditorView) => HTMLElement,
): Tooltip {
  // The outermost element around the text that draws nothing but [from, to].
  let shown: Element = place.text.parentElement!;
  for (let up = shown.parentElement; up; up = up.parentElement) {
    const span = drawnSpan(up);
    if (!span || span.from < from || span.to > to) break;
    shown = up;
  }
  const block = view.lineBlockAt(view.posAtDOM(shown));
  return {
    pos: block.from,
    end: block.to,
    above: true,
    create: (v): TooltipView => {
      const leave = (event: Event) => {
        const next = (event as MouseEvent).relatedTarget as Element | null;
        if (!next?.closest?.('.cm-tooltip')) v.dispatch({ effects: closeHoverTooltips });
      };
      shown.addEventListener('mouseleave', leave);
      return {
        dom: make(v),
        getCoords: () => shown.getBoundingClientRect(),
        destroy: () => shown.removeEventListener('mouseleave', leave),
      };
    },
  };
}

/**
 * The hover card `make` builds for what stands at `range`: over the drawing that holds it when
 * the pointer rests on content drawn outside the lines (`place`, from `hoverPlace`), otherwise
 * over its text.
 */
export function cardOver(
  view: EditorView,
  place: DrawnPlace | null,
  range: { from: number; to: number },
  make: (view: EditorView) => HTMLElement,
): Tooltip {
  if (place) return drawnCard(view, place, range.from, range.to, make);
  return { pos: range.from, end: range.to, above: true, create: (v) => ({ dom: make(v) }) };
}

/**
 * The link under the pointer of a hover card asked for at `pos` and `side`, and where it is
 * drawn outside the lines, if it is (`hoverPlace`). Null when there is none.
 */
export function hoveredLink(
  view: EditorView,
  pos: number,
  side: -1 | 1,
): { target: LinkTarget; place: DrawnPlace | null } | null {
  const place = hoverPlace(view);
  const target = readPointerLink(view.state, () =>
    place ? linkAt(view.state, place.pos, place.side, true) : linkAt(view.state, pos, side),
  );
  return target && { target, place };
}

interface CardContent {
  /** The main line: the address, or the file a wikilink opens; empty for a footnote. */
  address: string;
  title?: string | undefined;
  /** A footnote's text. */
  text?: string;
  /** A short sentence under the address. */
  note?: string;
  /** Other files an ambiguous wikilink matches. */
  others: string[];
  canOpen: boolean;
  /** The button's words, when they are not "Open". */
  openLabel?: string;
}

/** The longest footnote text a card shows; a longer one is cut at a word and ends with an ellipsis. */
const MAX_NOTE_CHARS = 400;

/**
 * A note's text as a line draws it, read as plain text: one line per paragraph of its
 * definition, or the note written in place, whose node starts at `at`. A note written in a grid
 * table's cell is read as the cell draws it, by a state holding that cell.
 */
function noteText(state: EditorState, at: number): string {
  const tree = treeForLine(state, at);
  const table = tree.resolveInner(at, 1);
  if (table.name !== 'GridTable') return noteIn(state, tree, at);
  const grid = fileGrid(state, table);
  const hit = grid && cellAt(state, grid, at);
  const ctx = state.facet(panelContext);
  if (!grid || !hit || !ctx) return '';
  const cell = gridCellState(ctx, getMode(state), state, grid.start, hit.parsed.cell);
  return noteIn(cell, syntaxTree(cell), hit.pos);
}

/** `noteText` for the note whose node starts at `at` in `tree`, a tree of `state`. */
function noteIn(state: EditorState, tree: Tree, at: number): string {
  let node = tree.resolveInner(at, 1);
  while (node.parent && node.from === at && node.name !== 'InlineFootnote' && node.name !== 'FootnoteLabel')
    node = node.parent;
  const reads = (nodes: readonly SyntaxNode[], from: number, to: number) =>
    inlineText(inlineDrawing(state, 'linkCard', nodes), state.doc, from, to)
      .replace(/\s+/g, ' ')
      .trim();
  if (node.name === 'InlineFootnote') {
    // Its content, not the note itself, which a line draws as its number.
    const content: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (child.name !== 'InlineFootnoteMark') content.push(child);
    return reads(content, node.from + 2, node.to - 1);
  }
  const paragraphs: string[] = [];
  for (let child = node.name === 'FootnoteLabel' ? node.nextSibling : null; child; child = child.nextSibling)
    if (child.name === 'Paragraph') paragraphs.push(reads([child], child.from, child.to));
  return paragraphs.join('\n');
}

/** What the card for a footnote says: the note's text, and a button that follows it. */
function footnoteCardContent(state: EditorState, target: LinkTarget): CardContent {
  const link = target.footnote;
  if (!link || link.role === 'number')
    return { address: '', note: 'Back to the first reference.', others: [], canOpen: !!link, openLabel: 'Go back' };
  let text = link.note === null ? '' : noteText(state, link.note);
  if (text.length > MAX_NOTE_CHARS) {
    const space = text.lastIndexOf(' ', MAX_NOTE_CHARS);
    text = `${text.slice(0, space > 0 ? space : MAX_NOTE_CHARS)}…`;
  }
  return { address: '', text, others: [], canOpen: link.role === 'reference', openLabel: 'Go to note' };
}

export function cardContent(target: LinkTarget, resolution: ReturnType<typeof wikilinkResolution>): CardContent {
  if (target.kind !== 'wikilink') {
    return { address: target.href || '(no address)', title: target.title, others: [], canOpen: !!target.href };
  }
  const written = `[[${target.href}]]`;
  if (!target.target) return { address: written, note: 'A heading in this file.', others: [], canOpen: true };
  if (!resolution) return { address: written, others: [], canOpen: true };
  if (resolution.status === 'missing')
    return { address: written, note: 'No file matches this link.', others: [], canOpen: false };
  const path = resolution.path ?? written;
  if (resolution.status === 'ambiguous') {
    return {
      address: path,
      note: `${resolution.candidates.length} files match. This one is closest to this note.`,
      others: resolution.candidates.filter((c) => c !== path),
      canOpen: true,
    };
  }
  return { address: path, others: [], canOpen: true };
}

function buildCard(view: EditorView, target: LinkTarget): HTMLElement {
  const doc = view.dom.ownerDocument;
  const content =
    target.kind === 'footnote'
      ? footnoteCardContent(view.state, target)
      : cardContent(target, wikilinkResolution(view.state.facet(panelContext), target.target ?? ''));
  const card = doc.createElement('div');
  card.className = 'tm-link-card';
  if (content.title) {
    const title = doc.createElement('div');
    title.className = 'tm-link-card-title';
    title.textContent = content.title;
    card.appendChild(title);
  }
  if (content.address) {
    const address = doc.createElement('div');
    address.className = 'tm-link-card-address';
    address.textContent = content.address;
    card.appendChild(address);
  }
  if (content.text) {
    const text = doc.createElement('div');
    text.className = 'tm-link-card-text';
    text.textContent = content.text;
    card.appendChild(text);
  }
  if (content.note) {
    const note = doc.createElement('div');
    note.className = 'tm-link-card-note';
    note.textContent = content.note;
    card.appendChild(note);
  }
  if (content.others.length) {
    const list = doc.createElement('ul');
    list.className = 'tm-link-card-others';
    for (const other of content.others.slice(0, 8)) {
      const item = doc.createElement('li');
      item.textContent = other;
      list.appendChild(item);
    }
    if (content.others.length > 8) {
      const more = doc.createElement('li');
      more.textContent = `and ${content.others.length - 8} more`;
      list.appendChild(more);
    }
    card.appendChild(list);
  }
  if (content.canOpen) {
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'tm-link-card-open';
    open.textContent = content.openLabel ?? 'Open';
    open.addEventListener('mousedown', (event) => event.preventDefault());
    open.addEventListener('click', (event) => {
      event.preventDefault();
      openTarget(view, target);
    });
    card.appendChild(open);
  }
  return card;
}

function source(view: EditorView, pos: number, side: -1 | 1): Tooltip | null {
  const hovered = hoveredLink(view, pos, side);
  if (!hovered) return null;
  const { target, place } = hovered;
  return cardOver(view, place, target, (v) => buildCard(v, target));
}

export const linkCard: Feature = {
  id: 'linkCard',
  extension: () => [
    trackPointer,
    hoverTooltip(source, { hoverTime: HOVER_MS, hideOnChange: true }),
    EditorView.baseTheme({
      // The card's frame, with the link's part, the note's part (ui/noteCard.ts) or both.
      '& .cm-tooltip.cm-tooltip-hover:has(.tm-link-card), & .cm-tooltip.cm-tooltip-hover:has(.tm-note-card)': {
        background: 'var(--tm-widget-bg)',
        color: 'var(--tm-widget-fg)',
        border: '1px solid var(--tm-border)',
        borderRadius: '3px',
        boxShadow: '0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25))',
      },
      '& .tm-link-card': {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '4px',
        maxWidth: '440px',
        padding: '6px 8px',
        fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
        fontSize: '12px',
        lineHeight: '1.4',
      },
      '& .tm-link-card-title': { fontWeight: '600' },
      '& .tm-link-card-address': { overflowWrap: 'anywhere', color: 'var(--tm-link)' },
      '& .tm-link-card-text': { overflowWrap: 'anywhere', whiteSpace: 'pre-line' },
      '& .tm-link-card-note': { color: 'var(--tm-faded)' },
      '& .tm-link-card-others': {
        margin: '0',
        paddingLeft: '16px',
        color: 'var(--tm-faded)',
        overflowWrap: 'anywhere',
      },
      '& .tm-link-card-open': {
        marginTop: '2px',
        padding: '2px 10px',
        border: 'none',
        borderRadius: '2px',
        background: 'var(--tm-button-bg)',
        color: 'var(--tm-button-fg)',
        font: 'inherit',
        cursor: 'pointer',
      },
      '& .tm-link-card-open:hover': { background: 'var(--tm-button-hover-bg)' },
    }),
  ],
};
