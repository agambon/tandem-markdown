// The bar above a table while one of its cells is being edited: structure edits, column
// alignment, "Align table" and "Edit as text". Icons from VS Code's codicon font, each with
// a tooltip and an accessible name. The buttons never take focus from the cell's field.

import type { Align } from '../../core/tableModel';
import { iconButton } from '../ui/dom';
import { canApply, type TableAction } from './edits';
import type { CellRef } from './model';

export type BarAction = TableAction | 'editAsText';

interface Button {
  action: BarAction;
  icon: string;
  label: string;
}

const GROUPS: Button[][] = [
  [
    { action: 'insertRowAbove', icon: 'arrow-small-up', label: 'Insert row above' },
    { action: 'insertRowBelow', icon: 'arrow-small-down', label: 'Insert row below' },
    { action: 'insertColumnLeft', icon: 'arrow-small-left', label: 'Insert column left' },
    { action: 'insertColumnRight', icon: 'arrow-small-right', label: 'Insert column right' },
  ],
  [
    { action: 'deleteRow', icon: 'trash', label: 'Delete row' },
    { action: 'deleteColumn', icon: 'close', label: 'Delete column' },
  ],
  [
    { action: 'alignLeft', icon: 'layout-panel-left', label: 'Align left' },
    { action: 'alignCenter', icon: 'layout-panel-center', label: 'Center' },
    { action: 'alignRight', icon: 'layout-panel-right', label: 'Align right' },
  ],
  [
    { action: 'moveRowUp', icon: 'arrow-up', label: 'Move row up' },
    { action: 'moveRowDown', icon: 'arrow-down', label: 'Move row down' },
    { action: 'moveColumnLeft', icon: 'arrow-left', label: 'Move column left' },
    { action: 'moveColumnRight', icon: 'arrow-right', label: 'Move column right' },
  ],
  [
    { action: 'alignTable', icon: 'wand', label: 'Align table' },
    { action: 'editAsText', icon: 'code', label: 'Edit as text' },
  ],
];

const PRESSED: Partial<Record<BarAction, Align>> = { alignLeft: 'left', alignCenter: 'center', alignRight: 'right' };

/** The bar, hidden until a cell opens. */
export function createBar(doc: Document): HTMLElement {
  const bar = doc.createElement('div');
  bar.className = 'tm-table-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Table');
  bar.hidden = true;
  GROUPS.forEach((group, i) => {
    if (i > 0) {
      const sep = doc.createElement('span');
      sep.className = 'tm-table-sep';
      sep.setAttribute('aria-hidden', 'true');
      bar.appendChild(sep);
    }
    for (const button of group) {
      const element = iconButton(doc, { icon: button.icon, label: button.label, className: 'tm-table-button' });
      element.dataset.action = button.action;
      element.tabIndex = -1;
      bar.appendChild(element);
    }
  });
  return bar;
}

export function barOf(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(':scope > .tm-table-bar');
}

/** Shows the bar for the cell at `ref` of a table `width` wide with `rows` body rows. */
export function showBar(root: HTMLElement, width: number, rows: number, ref: CellRef, align: Align | undefined): void {
  const bar = barOf(root);
  if (!bar) return;
  for (const button of bar.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    const action = button.dataset.action as BarAction;
    button.disabled = action !== 'editAsText' && !canApply(action, width, rows, ref);
    const pressed = PRESSED[action];
    if (pressed) button.setAttribute('aria-pressed', String(align === pressed));
  }
  bar.hidden = false;
}

export function hideBar(root: HTMLElement): void {
  const bar = barOf(root);
  if (!bar) return;
  bar.hidden = true;
  // Back above the table, where the stylesheet puts it (cellEdit.ts moves it while it shows).
  bar.style.top = '';
  bar.style.bottom = '';
}
