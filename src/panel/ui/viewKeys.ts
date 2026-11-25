// Rich view from the keyboard. Tab and Shift+Tab move focus between the links (written as
// markdown or as HTML, in a line, a table's cell or a grid table's), the checkboxes, and the
// drawn blocks' buttons and links (`tm-stop`) in the text, in document order, scrolling each
// into view. A button is pressed with Enter or Space, as anywhere. Enter on a link that has
// focus opens it, as a click does; Space on a checkbox that has focus checks it (the browser's
// own key for a checkbox). Alt+Enter (VS Code's keybinding, the panel command `openLink`)
// opens the link that has focus too.
//
// A link's drawn text has tabindex="-1" in Rich view (render/links.ts `linkTextAttrs`) and a
// checkbox is an input with tabIndex -1 (render/lists.ts), so only this moves focus to them.
// The stops are found in the syntax tree, not in the page: CodeMirror draws only the lines
// near the screen, so the next link may not be drawn yet.

import type { EditorState, Text } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { htmlLinksIn, type HtmlLink } from '../html/links';
import { linkAt } from '../links/read';
import { FOOTNOTE_LINKS, LINK_NODES, OPAQUE_BLOCKS } from '../markdown/nodes';
import { PARSE_PAST, treeFor } from '../markdown/tree';
import { getMode } from '../modes';
import { drawnSpan, posOf } from '../render/framework';
import { DRAWN_LINK, focusedLink, openTarget } from '../render/links';
import { drawnInCell, fileGrid, gridCells, parseCell } from '../tables/gridCells';
import { readTable } from '../tables/model';

interface Stop {
  from: number;
  to: number;
  kind: 'link' | 'task';
}

/** Blocks with no links drawn in them. */
const SKIP = OPAQUE_BLOCKS;

/** How far past `pos` Tab first looks for the next stop; each look after it goes twice as far. */
const FIRST_LOOK = 10_000;

/**
 * What the walk for stops does at a node of `doc`, whose positions lie in the file at `at`:
 * gives the stop it is to `found` and says whether to look inside it. `inCell` says whether
 * the node is drawn in a table's cell, whose links are the table's own drawing.
 */
function stopsIn(
  state: EditorState,
  doc: Text,
  at: (pos: number) => number,
  inCell: (from: number) => boolean,
  found: (stop: Stop) => void,
): (ref: SyntaxNodeRef) => boolean {
  const tasks = !state.facet(panelContext)?.doc.readOnly;
  const html = state.facet(panelContext)?.settings.workspaceTrusted === true;
  /** The links written as HTML in each block met, by where they start. */
  const htmlLinks = new Map<number, Map<number, HtmlLink>>();
  const htmlLinkAt = (parent: SyntaxNode, from: number) => {
    let links = htmlLinks.get(parent.from);
    if (!links) htmlLinks.set(parent.from, (links = new Map(htmlLinksIn(doc, parent).map((l) => [l.from, l]))));
    return links.get(from);
  };
  return (ref) => {
    if (ref.name === 'TaskMarker') {
      if (tasks) found({ from: at(ref.from), to: at(ref.to), kind: 'task' });
      return false;
    }
    if (ref.name === 'HTMLTag') {
      // A link written as HTML stops on its text, which is what is drawn.
      const parent = ref.node.parent;
      const link = html && parent ? htmlLinkAt(parent, ref.from) : undefined;
      if (link) found({ from: at(link.textFrom), to: at(link.textTo), kind: 'link' });
      return false;
    }
    if (!LINK_NODES.has(ref.name) && !FOOTNOTE_LINKS.has(ref.name)) return true;
    const from = at(ref.from);
    const to = at(ref.to);
    const target = linkAt(state, from, 1, inCell(ref.from));
    if (target && target.from === from && target.to === to) {
      found({ from, to, kind: 'link' });
      return false;
    }
    // A reference to an undefined label is text, and may hold a bare address that is a link.
    return ref.name === 'Link';
  };
}

/** The stops in the cells of the grid table `node`, in the order they stand in the file. */
function gridStops(state: EditorState, node: SyntaxNode): Stop[] {
  const grid = fileGrid(state, node);
  if (!grid) return [];
  const stops: Stop[] = [];
  for (const cell of gridCells(grid)) {
    const parsed = parseCell(state, grid, cell);
    if (!parsed) continue;
    const visit = stopsIn(
      state,
      parsed.doc,
      parsed.at,
      () => true,
      (stop) => void stops.push(stop),
    );
    parsed.tree.iterate({
      enter: (ref) => !SKIP.has(ref.name) && (!ref.type.is('Block') || drawnInCell(ref.node)) && visit(ref),
    });
  }
  return stops.sort((a, b) => a.from - b.from);
}

/**
 * The next stop after `pos` (dir 1: the first one starting after it) or before it (dir -1:
 * the last one ending at or before it). Checkboxes count unless the document is read-only
 * (they are drawn disabled then). Forward, the text is parsed only as far as the stop: a
 * stretch at a time past `pos`, each twice as long as the last, so a stop near the cursor is
 * found without parsing the rest of a long note. A grid table's stops are those of its cells'
 * markdown, placed where they stand in the file.
 */
function nextStop(state: EditorState, pos: number, dir: 1 | -1): Stop | null {
  const accept = (stop: Stop) => (dir > 0 ? stop.from > pos : stop.to <= pos);
  let found: Stop | null = null;
  const take = (stop: Stop) => {
    if ((dir < 0 || !found) && accept(stop)) found = stop;
  };
  /** The end of the table drawn as a grid that the walk is in, whose cells' links are its own drawing. */
  let tableTo = -1;
  const visit = stopsIn(
    state,
    state.doc,
    (p) => p,
    (from) => from < tableTo,
    take,
  );
  const enter = (ref: SyntaxNodeRef): boolean => {
    if (dir > 0 && found) return false;
    if (SKIP.has(ref.name)) return false;
    if (ref.name === 'Table') {
      // A table shown as its source lines draws no links.
      if (!readTable(state.doc, ref.node)?.drawable) return false;
      tableTo = ref.to;
      return true;
    }
    if (ref.name === 'GridTable') {
      for (const stop of gridStops(state, ref.node)) take(stop);
      return false;
    }
    return visit(ref);
  };
  const start = Math.max(0, pos);
  if (dir < 0) {
    treeFor(state, pos).iterate({ from: 0, to: start, enter });
    return found;
  }
  // Each look walks from `pos` again, which costs little beside the parse it waits for.
  for (let span = FIRST_LOOK; ; span *= 2) {
    const to = Math.min(state.doc.length, start + span);
    treeFor(state, to + PARSE_PAST).iterate({ from: start, to, enter });
    if (found || to === state.doc.length) return found;
  }
}

/** The element drawn for `stop`, drawing its line first when it is off screen. Null when nothing is drawn for it. */
function drawnElement(view: EditorView, stop: Stop): HTMLElement | null {
  // CodeMirror draws the lines a scroll target is on at once; the scroll itself follows.
  view.dispatch({ effects: EditorView.scrollIntoView(stop.from, { y: 'nearest', yMargin: 40 }) });
  const task = stop.kind === 'task';
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>(task ? 'input.tm-task' : DRAWN_LINK)) {
    const pos = posOf(view, task ? (element.parentElement ?? element) : element);
    if (pos === null) continue;
    // The page holds a grid table's cells row by row, not in the order their text stands in the file.
    if (pos > stop.to && !drawnSpan(element)) break;
    if (task ? pos === stop.from && !(element as HTMLInputElement).disabled : pos >= stop.from && pos < stop.to)
      return element;
  }
  return null;
}

/**
 * Moves focus to the next stop in `dir`. The first Tab from the page itself goes to the first
 * stop on screen; a stop with nothing drawn for it (a link definition, which Rich view hides)
 * is passed over. False when there is none, or for Shift+Tab from the page itself: Tab then
 * goes on to whatever comes next around the editor, as it does anywhere.
 */
function moveFocus(view: EditorView, dir: 1 | -1): boolean {
  const active = view.dom.ownerDocument.activeElement as HTMLElement | null;
  let pos: number;
  let from: HTMLElement | null = null;
  if (active && active !== view.contentDOM && view.contentDOM.contains(active)) {
    from = active;
    const at = posOf(view, active.classList.contains('tm-task') ? (active.parentElement ?? active) : active);
    if (at === null) return false;
    pos = at;
  } else {
    // From the page itself: Tab goes to the first stop on screen; Shift+Tab leaves the editor.
    if (dir < 0) return false;
    pos = (view.visibleRanges[0]?.from ?? view.viewport.from) - 1;
  }
  // A stop with nothing drawn is passed over; the bound only guards against a tree that never ends.
  for (let tries = 0; tries < 1000; tries++) {
    const stop = nextStop(view.state, pos, dir);
    const control = nextControl(view, pos, stop, dir, from);
    if (control) {
      control.focus({ preventScroll: true });
      control.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (!stop) return false;
    const element = drawnElement(view, stop);
    if (element) {
      element.focus({ preventScroll: true });
      // CodeMirror scrolls to a table's start; a link further down its cells is brought in too.
      if (drawnSpan(element)) element.scrollIntoView({ block: 'nearest' });
      return true;
    }
    pos = stop.from;
  }
  return false;
}

/**
 * The drawn control (`tm-stop`: a block's "Draw anyway", a contents list's links) that comes
 * after `pos` (dir 1) or before it (dir -1) and before `stop`, or null. Controls in one drawing
 * share its position, so among them the order in the page decides, from `from`, the element
 * that has focus. Only what is drawn is looked at: such a control is in a block on screen.
 */
function nextControl(
  view: EditorView,
  pos: number,
  stop: Stop | null,
  dir: 1 | -1,
  from: HTMLElement | null,
): HTMLElement | null {
  let best: { element: HTMLElement; at: number } | null = null;
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>('.tm-stop')) {
    if (element.offsetParent === null || element === from) continue;
    const at = posOf(view, element);
    if (at === null) continue;
    const beyond =
      at === pos && from
        ? dir > 0 === !!(from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
        : dir > 0
          ? at > pos
          : at < pos;
    if (!beyond) continue;
    if (stop && (dir > 0 ? at > stop.from : at < stop.to)) continue;
    // The page lists controls in order, so of two at one position the first is kept going
    // forward and the last going back.
    if (!best || (dir > 0 ? at < best.at : at >= best.at)) best = { element, at };
  }
  return best?.element ?? null;
}

const keys = ViewPlugin.fromClass(
  class {
    private readonly onKey = (event: KeyboardEvent) => this.key(event);
    constructor(private readonly view: EditorView) {
      // On the content element itself, not a CodeMirror keymap: a checkbox's widget keeps its
      // events from CodeMirror's handlers.
      view.contentDOM.addEventListener('keydown', this.onKey);
    }
    private key(event: KeyboardEvent): void {
      const view = this.view;
      if (event.defaultPrevented || event.isComposing || getMode(view.state) !== 'view') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Tab') {
        if (moveFocus(view, event.shiftKey ? -1 : 1)) event.preventDefault();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const target = focusedLink(view);
        if (!target) return;
        event.preventDefault();
        openTarget(view, target);
      }
    }
    destroy(): void {
      this.view.contentDOM.removeEventListener('keydown', this.onKey);
    }
  },
);

export const viewKeys: Feature = {
  id: 'viewKeys',
  extension: () => [
    keys,
    EditorView.baseTheme({
      '&.tm-mode-view .cm-content .tm-link:focus-visible, &.tm-mode-view .cm-content .tm-wikilink:focus-visible': {
        outline: '1px solid var(--tm-focus)',
        outlineOffset: '1px',
        borderRadius: '2px',
      },
      '& .cm-content .tm-task:focus-visible': { outline: '1px solid var(--tm-focus)', outlineOffset: '1px' },
    }),
  ],
};
