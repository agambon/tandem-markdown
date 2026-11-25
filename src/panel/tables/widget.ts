// The table widget: GitHub's grid in place of a table's source lines. In Rich editor a click
// on a cell opens it for editing (cellEdit.ts); in Rich view the grid is all there is, and its
// text can be selected and copied. A link or a tag in a cell follows with the keys it follows
// with in a line: a plain click in Rich view, Ctrl+click (Cmd+click on a Mac) in Rich editor.

import type { EditorView } from '@codemirror/view';
import { runCommand } from '../commands/registry';
import { getMode } from '../modes';
import { followsLink } from '../render/follow';
import { posOf, RichWidget } from '../render/framework';
import { createBar, type BarAction } from './bar';
import { clickCell, redrawGrid, rootDropped, runAction } from './cellEdit';
import { elementSource, refOf, sameGrid, sourceOffsetAt, sweepWidgets, syncGrid, tableOf, type GridView } from './grid';

/** About one line of text with the cell padding and border. */
const ROW_HEIGHT_PX = 35;

export class TableWidget extends RichWidget {
  constructor(
    source: string,
    readonly grid: GridView,
    /** Layout classes: list and quote depth, a gap above. */
    readonly layout: string,
  ) {
    super(source);
  }

  override sameAs(other: TableWidget): boolean {
    // The same source can draw differently (a link definition or a host's answer changed);
    // a row that does is a new one (tables.ts keeps one per line while it draws alike).
    return other.layout === this.layout && sameGrid(other.grid, this.grid);
  }

  override get estimatedHeight(): number {
    return this.grid.rows.length * ROW_HEIGHT_PX + (this.layout.includes('tm-table-touch') ? 16 : 0);
  }

  private className(editing: boolean): string {
    return ['tm-table-block', this.layout, editing ? 'tm-table-editing' : ''].filter(Boolean).join(' ');
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const root = doc.createElement('div');
    root.className = this.className(false);
    const scroll = doc.createElement('div');
    scroll.className = 'tm-table-scroll';
    const table = doc.createElement('table');
    table.className = 'tm-table';
    scroll.appendChild(table);
    root.append(createBar(doc), scroll);
    syncGrid(view, root, this.grid, null);

    root.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('.tm-table-field')) return;
      // Rich view: leave the browser to select text. Rich editor: keep the focus and the
      // editor's selection where they are (a click near the grid must not reveal its source).
      if (getMode(view.state) === 'edit') event.preventDefault();
    });
    root.addEventListener('click', (event) => {
      const target = event.target as Element;
      if (target.closest('.tm-table-field')) return;
      const button = target.closest<HTMLButtonElement>('button[data-action]');
      if (button && root.contains(button)) {
        event.preventDefault();
        if (!button.disabled) runAction(view, root, button.dataset.action as BarAction);
        return;
      }
      const cell = target.closest<HTMLElement>('th, td');
      const ref = cell && tableOf(root)?.contains(cell) ? refOf(cell) : null;
      if (!cell || !ref) return;
      if (event.button === 0 && target !== cell && followsLink(view, event)) {
        const at = elementSource(root, ref, target);
        const from = posOf(view, root);
        if (at !== null && from !== null && runCommand(view, 'openLink', { at: from + at, cell: true })) {
          event.preventDefault();
          return;
        }
      }
      clickCell(view, root, ref, sourceOffsetAt(cell, event.clientX, event.clientY));
    });
    return root;
  }

  override redraw(dom: HTMLElement, view: EditorView): boolean {
    if (!dom.classList.contains('tm-table-block') || !tableOf(dom)) return false;
    dom.className = this.className(dom.classList.contains('tm-table-editing'));
    redrawGrid(view, dom, this.grid);
    return true;
  }

  /**
   * Every event stays with the table but the keys pressed on a link that has focus in Rich view
   * (ui/viewKeys.ts), which move on from it or follow it as on a link in a line.
   */
  override ignores(event: Event): boolean {
    const target = event.target as Element | null;
    return !(event.type === 'keydown' && target?.getAttribute?.('role') === 'link');
  }

  override destroy(dom: HTMLElement): void {
    sweepWidgets(dom, true);
    try {
      rootDropped(dom);
    } catch (error) {
      console.error('Tandem Markdown: closing a table cell field failed', error);
    }
  }
}
