// Tags (`#project`, `#area/sub`, markdown/tag.ts): a lightly tinted label, the `#` kept, as
// Obsidian shows them. A plain click in Rich view, or Ctrl+click (Cmd+click on a Mac) in Rich
// editor, searches the workspace for the tag through VS Code's search (`searchTag`), as a link
// opens with the same keys; the panel command `openLink` (Alt+Enter) does it for the tag at the
// cursor.

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { NO_INLINE } from '../markdown/nodes';
import { cellAt, drawnInCell, fileGrid } from '../tables/gridCells';
import { keyName } from '../ui/keys';
import { followOnClick } from './follow';
import { inlineFeature, posOf } from './framework';

/** The tag at `pos` on `side` in the cell of the grid table `node` that holds it, as the cell draws it. */
function gridTagAt(state: EditorState, node: SyntaxNode, pos: number, side: -1 | 1): string | null {
  const grid = fileGrid(state, node);
  const hit = grid && cellAt(state, grid, pos);
  if (!hit) return null;
  const { doc, tree } = hit.parsed;
  for (let n: SyntaxNode | null = tree.resolveInner(hit.pos, side); n?.parent; n = n.parent)
    if (n.name === 'Tag') return drawnInCell(n) ? doc.sliceString(n.from + 1, n.to) : null;
  return null;
}

/** The tag (without its `#`) whose node holds `pos`, in a line or a grid table's cell, or null. */
export function tagAt(state: EditorState, pos: number): string | null {
  for (const side of [1, -1] as const) {
    for (let node = syntaxTree(state).resolveInner(pos, side); node.parent; node = node.parent) {
      if (node.name === 'Tag') return state.sliceDoc(node.from + 1, node.to);
      if (node.name === 'GridTable') {
        const tag = gridTagAt(state, node, pos, side);
        if (tag !== null) return tag;
        break;
      }
    }
  }
  return null;
}

/** Asks VS Code to search the workspace for `tag`. */
export function searchTag(view: EditorView, tag: string): void {
  const ctx = view.state.facet(panelContext);
  ctx
    ?.request({ type: 'searchTag', tag })
    .catch((error) => ctx.log('warn', 'Searching for a tag got no answer', error));
}

function tagFromEvent(view: EditorView, event: Event): string | null {
  const start = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
  const element = start?.closest('.tm-tag');
  if (!element || !view.contentDOM.contains(element)) return null;
  const pos = posOf(view, element);
  return pos === null ? null : tagAt(view.state, pos + 1);
}

/** Searches for the tag drawn where `event` happened. False when there is none, so the event goes on. */
function searchClickedTag(view: EditorView, event: MouseEvent): boolean {
  const tag = tagFromEvent(view, event);
  if (!tag) return false;
  event.preventDefault();
  searchTag(view, tag);
  return true;
}

export const tags: Feature = {
  id: 'tags',
  extension: () => [
    inlineFeature('tags', (d) => {
      const title =
        d.mode === 'view'
          ? 'Click to search the workspace for this tag'
          : `${keyName({ key: 'ctrl', mac: 'cmd' })}+click to search the workspace for this tag`;
      d.iterate((node) => {
        if (NO_INLINE.has(node.name)) return false;
        if (node.name !== 'Tag') return true;
        d.mark(node.from, node.to, 'tm-tag', { title });
        return false;
      });
    }),
    followOnClick(searchClickedTag),
    EditorView.baseTheme({
      '& .cm-content .tm-tag': {
        color: 'var(--tm-link)',
        background: 'color-mix(in srgb, var(--tm-link) 12%, transparent)',
        borderRadius: '3px',
        padding: '0 0.25em',
        boxDecorationBreak: 'clone',
      },
      '&.tm-mode-view .cm-content .tm-tag': { cursor: 'pointer' },
    }),
  ],
};
