// Links: inline links, reference links, autolinks and bare web addresses draw as link text;
// their marks and addresses are hidden unless the link is revealed (Rich editor, a selection
// touching it), when they show faded. A link with no text shows its address. A reference to a
// label the file does not define stays plain text, as in the preview.
//
//   [text](address "title")   [text][label]   [text][]   [text]   <https://x.y>   www.x.y
//
// Link definitions are removed in Rich view (with one blank line after, as comments are) and
// faded in Rich editor. In Rich view a link's drawn text can take focus (`linkTextAttrs`).

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { PanelCommand } from '../commands/registry';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { goToFootnote } from '../links/footnotes';
import {
  definitionLookup,
  definitionsField,
  definitionsKey,
  linkAt,
  linkParts,
  readPointerLink,
  type DefinitionLookup,
  type LinkTarget,
} from '../links/read';
import { OPAQUE_BLOCKS, selfRevealingChildren } from '../markdown/nodes';
import { getMode } from '../modes';
import { syntaxOn } from '../syntax';
import { followOnClick } from './follow';
import { blockFeature, drawnSpan, inlineFeature, posOf, type InlineDraw } from './framework';
import { hideRange, hideWithGap, markRange } from './layout';
import { searchTag, tagAt } from './tags';

/** The elements drawn for a link's text: a link, and a link to a note. In Rich view they take focus. */
export const DRAWN_LINK = '.tm-link, .tm-wikilink';

/**
 * Asks the host to open `target` in the view it was clicked in; a footnote is followed in the
 * panel (`goToFootnote`). A link opens by a plain click in Rich view, Ctrl+click (Cmd+click on
 * a Mac) in Rich editor, the hover card's Open button (ui/linkCard.ts), Enter on a link that has
 * focus in Rich view (ui/viewKeys.ts), and the panel command `openLink` (Alt+Enter;
 * `args: { at? }`, else the link that has focus, else the link at the cursor).
 */
export function openTarget(view: EditorView, target: LinkTarget): void {
  if (target.kind === 'footnote') {
    const goTo = target.footnote?.goTo;
    if (typeof goTo === 'number') goToFootnote(view, goTo);
    return;
  }
  if (!target.href && target.kind !== 'wikilink') return;
  const ctx = view.state.facet(panelContext);
  if (!ctx) return;
  ctx
    .request({ type: 'openLink', kind: target.kind, href: target.href, mode: getMode(view.state) })
    .catch((error) => ctx.log('warn', 'Opening a link got no answer from VS Code', error));
}

/** The link `element` (a link's drawn text, or a picture) draws in `view`'s content, or null. */
function linkDrawnBy(view: EditorView, element: Element | null | undefined): LinkTarget | null {
  if (!element || !view.contentDOM.contains(element)) return null;
  const pos = posOf(view, element);
  // A link in a table's cell is the table's own drawing, which `linkAt` reads only when told.
  return pos === null ? null : linkAt(view.state, pos, 1, drawnSpan(element) !== null);
}

/** The link whose drawn text has keyboard focus (Rich view, ui/viewKeys.ts), or null. */
export function focusedLink(view: EditorView): LinkTarget | null {
  const active = view.dom.ownerDocument.activeElement;
  if (!active || active === view.contentDOM || !view.contentDOM.contains(active)) return null;
  return linkDrawnBy(view, active.closest(DRAWN_LINK));
}

/**
 * Attributes for a link's drawn text: in Rich view it can take focus (by Tab, ui/viewKeys.ts)
 * and is a link to assistive technology. In Rich editor it is text being edited.
 */
export function linkTextAttrs(mode: 'view' | 'edit'): Record<string, string> | undefined {
  return mode === 'view' ? { tabindex: '-1', role: 'link' } : undefined;
}

/** The link drawn at the element an event happened on, or null. */
function linkFromEvent(view: EditorView, event: Event): LinkTarget | null {
  const start = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
  return linkDrawnBy(view, start?.closest(`${DRAWN_LINK}, .tm-image`));
}

/** Opens the link drawn where `event` happened. False when there is none, so the event goes on. */
function openClickedLink(view: EditorView, event: MouseEvent): boolean {
  const target = readPointerLink(view.state, () => linkFromEvent(view, event));
  if (!target) return false;
  event.preventDefault();
  openTarget(view, target);
  return true;
}

/**
 * Opens the link at `args.at`, else the link that has focus, else the one at the cursor; or
 * searches for a tag there. `args.cell`: `at` is in a cell the table draws itself
 * (tables/widget.ts, render/gridTables.ts).
 */
const openLink: PanelCommand = (view, args) => {
  const { at, cell } = (args ?? {}) as { at?: unknown; cell?: unknown };
  const given = typeof at === 'number' && Number.isFinite(at);
  const pos = given ? Math.max(0, Math.min(view.state.doc.length, Math.floor(at))) : view.state.selection.main.head;
  const target = given ? linkAt(view.state, pos, 0, cell === true) : (focusedLink(view) ?? linkAt(view.state, pos, 0));
  if (target) {
    openTarget(view, target);
    return true;
  }
  // A tag follows with the same keys as a link: it searches the workspace for the tag.
  const tag = tagAt(view.state, pos);
  if (!tag || !syntaxOn(view.state.facet(panelContext)?.settings, 'tags')) return false;
  searchTag(view, tag);
  return true;
};

// ---------------------------------------------------------------------------
// Drawing

const SKIP = new Set([...OPAQUE_BLOCKS, 'Table']);

function drawLink(d: InlineDraw, node: SyntaxNode, defs: DefinitionLookup): void {
  const parts = linkParts(d.doc, node, defs);
  if (!parts) return; // a reference to an undefined label: plain text
  const revealed = d.revealed(node.from, node.to, selfRevealingChildren(node));
  const empty = parts.textFrom === parts.textTo;
  if (revealed) {
    markRange(d, parts.textFrom, parts.textTo, 'tm-link');
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'LinkMark' || c.name === 'LinkTitle' || c.name === 'LinkLabel')
        markRange(d, c.from, c.to, 'tm-mark');
      else if (c.name === 'URL') markRange(d, c.from, c.to, 'tm-mark tm-link-url');
    }
    return;
  }
  hideRange(d, parts.open.from, parts.open.to);
  const url = parts.url;
  const attrs = linkTextAttrs(d.mode);
  if (empty && url && url.to > url.from) {
    // No text: the address stands in for it.
    const angled = d.doc.sliceString(url.from, url.from + 1) === '<';
    hideRange(d, parts.close.from, url.from + (angled ? 1 : 0));
    markRange(d, url.from + (angled ? 1 : 0), url.to - (angled ? 1 : 0), 'tm-link', attrs);
    hideRange(d, url.to - (angled ? 1 : 0), node.to);
    return;
  }
  markRange(d, parts.textFrom, parts.textTo, 'tm-link', attrs);
  hideRange(d, parts.close.from, node.to);
}

function drawAutolink(d: InlineDraw, node: SyntaxNode): void {
  const url = node.getChild('URL');
  if (!url) return;
  d.mark(url.from, url.to, 'tm-link', linkTextAttrs(d.mode));
  const revealed = d.revealed(node.from, node.to);
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'LinkMark') continue;
    if (revealed) d.mark(c.from, c.to, 'tm-mark');
    else d.hide(c.from, c.to);
  }
}

export const links: Feature = {
  id: 'links',
  extension: () => [
    definitionsField,
    inlineFeature(
      'links',
      (d) => {
        const defs = definitionLookup(d.state);
        d.iterate((ref) => {
          const name = ref.name;
          if (SKIP.has(name)) return false;
          if (name === 'Link') {
            drawLink(d, ref.node, defs);
            return true; // its text may hold an image or a bare address that is not a link of its own
          }
          if (name === 'Autolink') {
            drawAutolink(d, ref.node);
            return false;
          }
          if (name === 'URL') {
            const parent = ref.node.parent?.name;
            if (parent === 'LinkReference') d.mark(ref.from, ref.to, 'tm-link tm-link-def-url', linkTextAttrs(d.mode));
            else if (parent !== 'Link' && parent !== 'Image' && parent !== 'Autolink')
              d.mark(ref.from, ref.to, 'tm-link', linkTextAttrs(d.mode));
            return false;
          }
          if (name === 'Image' || name === 'Wikilink' || name === 'Embed') return false;
          return true;
        });
      },
      { reads: definitionsKey },
    ),
    // Definitions: removed in Rich view (top-level ones, with one blank line after), faded in Rich editor.
    blockFeature('links', (d) => {
      d.blocks((block) => {
        if (block.name !== 'LinkReference') return;
        if (d.mode === 'view' && block.top) {
          hideWithGap(d, block);
          return;
        }
        for (let n = block.firstLine; n <= block.lastLine; n++) d.line(d.lines.start(n), 'tm-link-def');
      });
    }),
    followOnClick(openClickedLink),
    EditorView.baseTheme({
      '& .cm-content .tm-link': { color: 'var(--tm-link)', textDecoration: 'none' },
      '& .cm-content .tm-link:hover': { textDecoration: 'underline' },
      '&.tm-mode-view .cm-content .tm-link': { cursor: 'pointer' },
      '& .cm-content .tm-link-url': { wordBreak: 'break-all' },
      '& .cm-content .tm-link-def': { color: 'var(--tm-faded)' },
    }),
  ],
  commands: { openLink },
};
