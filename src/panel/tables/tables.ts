// Tables: a GFM table found by the parser draws as GitHub's grid: borders, a bold header row,
// alignment from the delimiter row, sideways scroll when it is wider than the column. A cell
// draws what a line draws: the inline features draw its content (grid.ts). In Rich editor a
// click on a cell edits it (cellEdit.ts), and a bar above the table edits its structure
// (bar.ts). The selection landing inside the table's lines shows them as source text
// (`tm-table-source`).
//
// Not drawn as a grid: a table that starts on a list item's marker line (the grid would hide
// the marker), and a table the parser read as the text of a Setext heading (a `---` line
// right under it): there is no Table node then, and the heading feature draws it.

import { EditorView } from '@codemirror/view';
import type { PanelContext } from '../context';
import type { Feature } from '../features';
import { blockFeature, inlineKey, sameDrawing, type BlockDraw } from '../render/framework';
import { wrapperAlignAt, wrapperRuns } from '../render/htmlBlocks';
import { BLOCK_INDENT, blockLayoutClasses } from '../render/layout';
import { isBlankLine, type BlockEntry } from '../render/lines';
import { LruCache } from '../render/lruCache';
import { cellEdits } from './cellEdit';
import { gridOf, type RowCache, type RowView } from './grid';
import { readTable } from './model';
import { TableWidget } from './widget';

interface CachedRow {
  row: RowView;
  /** The `inlineKey` it was drawn under. */
  key: string;
}

/**
 * Rows by their line's text and what they read of where they stand (`RowCache`), per panel. A
 * row draws the same as long as those and `inlineKey` do, so typing beside a table, or in one of
 * its cells, draws again only what changed. A row drawn again that draws as the last one did is
 * that one, so its DOM is kept.
 */
const rowCaches = new WeakMap<PanelContext, LruCache<string, CachedRow>>();
/** Rows kept per panel: those of several large tables. */
const CACHE_SIZE = 5000;

function rowCache(d: BlockDraw): RowCache {
  let rows = rowCaches.get(d.ctx);
  if (!rows) rowCaches.set(d.ctx, (rows = new LruCache(CACHE_SIZE)));
  const cache = rows;
  const key = inlineKey(d.state);
  return {
    get(rowKey) {
      const cached = cache.get(rowKey);
      if (cached?.key !== key) return undefined;
      return cached.row;
    },
    keep(rowKey, row) {
      const cached = cache.get(rowKey);
      const same =
        cached && cached.row.cells.join() === row.cells.join() && sameDrawing(cached.row.drawing, row.drawing);
      const kept = same ? cached.row : row;
      cache.set(rowKey, { row: kept, key });
      return kept;
    },
  };
}

/** Classes that place the widget as the lines it replaces were placed: list and quote depth, wrapper alignment, gap above. */
function layoutOf(d: BlockDraw, block: BlockEntry): string {
  const classes: string[] = [];
  const base = blockLayoutClasses(block);
  if (base) classes.push(base);
  const align = wrapperAlignAt(d.state, block.from);
  if (align) classes.push(`tm-table-align-${align}`);
  // A top-level table right under another block (no blank line between) gets the gap the
  // spacing feature would give its first line.
  if (block.top && block.firstLine > 1 && !isBlankLine(d.lines.text(block.firstLine - 1)))
    classes.push('tm-table-touch');
  return classes.join(' ');
}

const theme = EditorView.baseTheme({
  '& .cm-content .tm-table-block': {
    position: 'relative',
    boxSizing: 'border-box',
    paddingLeft: BLOCK_INDENT,
    paddingRight: '2px',
  },
  '& .cm-content .tm-table-align-center .tm-table': { marginLeft: 'auto', marginRight: 'auto' },
  '& .cm-content .tm-table-align-right .tm-table': { marginLeft: 'auto', marginRight: '0' },
  '& .cm-content .tm-table-touch': { paddingTop: 'var(--tm-gap)' },
  '& .cm-content .tm-table-scroll': { overflowX: 'auto' },
  '& .cm-content .tm-table': {
    borderCollapse: 'collapse',
    borderSpacing: '0',
    lineHeight: '1.5',
    whiteSpace: 'normal',
    // The editor breaks long words anywhere (lineWrapping); in a table a word too long for
    // the column makes the table scroll sideways instead, as GitHub's does.
    wordBreak: 'normal',
    overflowWrap: 'normal',
  },
  '& .cm-content .tm-table th, & .cm-content .tm-table td': {
    border: '1px solid var(--tm-border)',
    padding: '6px 13px',
    textAlign: 'start',
    verticalAlign: 'top',
  },
  '& .cm-content .tm-table th': { fontWeight: '600' },
  '&.tm-mode-edit .cm-content .tm-table th, &.tm-mode-edit .cm-content .tm-table td': { cursor: 'text' },
  '& .cm-content .tm-table :is(ul, ol)': { margin: '0', paddingLeft: '1.5em' },
  '& .cm-content .tm-table-active': { outline: '2px solid var(--tm-focus)', outlineOffset: '-2px' },
  '& .cm-content .tm-table-field': {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    margin: '0',
    padding: '0',
    border: 'none',
    outline: 'none',
    resize: 'none',
    overflow: 'hidden',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'inherit',
    whiteSpace: 'pre-wrap',
  },
  '& .cm-content .tm-table-bar': {
    position: 'absolute',
    bottom: '100%',
    left: BLOCK_INDENT,
    zIndex: '5',
    display: 'flex',
    // A narrow panel wraps the bar onto more rows; it grows upward from the table.
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '1px',
    padding: '2px',
    marginBottom: '2px',
    background: 'var(--tm-widget-bg)',
    color: 'var(--tm-widget-fg)',
    border: '1px solid var(--tm-border)',
    borderRadius: '4px',
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.2)',
    lineHeight: '1',
  },
  '& .cm-content .tm-table-bar[hidden]': { display: 'none' },
  '& .cm-content .tm-table-sep': { width: '1px', height: '16px', margin: '0 3px', background: 'var(--tm-border)' },
  '& .cm-content .tm-table-button': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: '0',
    border: 'none',
    borderRadius: '3px',
    background: 'none',
    color: 'inherit',
    cursor: 'pointer',
  },
  '& .cm-content .tm-table-button:hover:not(:disabled)': { background: 'var(--tm-button2-bg)' },
  '& .cm-content .tm-table-button[aria-pressed="true"]': {
    background: 'var(--tm-button2-bg)',
    color: 'var(--tm-link)',
  },
  '& .cm-content .tm-table-button:disabled': { opacity: '0.35', cursor: 'default' },
  '& .cm-content .tm-table-button .codicon': { fontSize: '16px' },
  '& .cm-content .tm-table-source': { fontFamily: 'var(--tm-mono)', fontSize: '0.85em' },
});

export const tables: Feature = {
  id: 'tables',
  extension: () => [
    blockFeature(
      'tables',
      (d) => {
        d.blocks((block) => {
          if (block.name !== 'Table') return;
          const info = readTable(d.doc, block.node);
          if (!info || !info.drawable) return;
          if (d.blockRevealed(block.from, block.to)) {
            for (let n = d.lines.numberAt(info.from); n <= d.lines.numberAt(info.to); n++)
              d.line(d.lines.start(n), 'tm-table-source');
            return;
          }
          const source = d.doc.sliceString(info.from, info.to);
          d.replaceLines(
            info.from,
            info.to,
            new TableWidget(source, gridOf(d.state, info, rowCache(d), d), layoutOf(d, block)),
          );
        });
      },
      { inline: true, linked: wrapperRuns },
    ),
    cellEdits,
    theme,
  ],
};
