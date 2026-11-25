// The outline's tree: the headings nested by level, and which heading the tree shows as
// selected while the panel scrolls.

import type { OutlineItem } from '../../core/outline';

export interface OutlineNode {
  readonly item: OutlineItem;
  /** The heading's place in document order (its index in `flat`). */
  readonly index: number;
  readonly parent: OutlineNode | undefined;
  readonly children: OutlineNode[];
}

/**
 * Nests the headings by level: each heading goes under the nearest heading before it with a
 * lower level (a level 3 straight after a level 1 goes under the level 1).
 */
export function nestOutline(items: readonly OutlineItem[]): { roots: OutlineNode[]; flat: OutlineNode[] } {
  const roots: OutlineNode[] = [];
  const flat: OutlineNode[] = [];
  const open: OutlineNode[] = [];
  items.forEach((item, index) => {
    while (open.length > 0 && open[open.length - 1]!.item.level >= item.level) open.pop();
    const parent = open[open.length - 1];
    const node: OutlineNode = { item, index, parent, children: [] };
    (parent ? parent.children : roots).push(node);
    flat.push(node);
    open.push(node);
  });
  return { roots, flat };
}

/**
 * The heading the panel is scrolled to, from its view state: the last heading that starts on
 * or above the first line whose start is in view, or the first heading when the view is above
 * them all (a tree view cannot be left with nothing selected). -1 when there are no headings.
 *
 * The first line whose start is in view is `topLine` when the view's top edge is at that
 * line's start (`topOffsetPx` 0), and the line after it otherwise. Revealing a heading puts
 * its line a few pixels below the top edge, so the edge falls inside the line above it and
 * the heading itself is the answer.
 */
export function headingAtTop(items: readonly { line: number }[], topLine: number, topOffsetPx: number): number {
  if (items.length === 0) return -1;
  const top = Number.isFinite(topLine) ? Math.max(0, Math.floor(topLine)) : 0;
  const reading = top + (Number.isFinite(topOffsetPx) && topOffsetPx > 0 ? 1 : 0);
  let found = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.line > reading) break;
    found = i;
  }
  return found;
}

/**
 * Which heading the tree shows as selected. Normally the heading at the panel's top
 * (`headingAtTop`). When the user chooses a heading in the tree, the panel scrolls to it,
 * but it may not be able to put it at the top (near the end of the file, or under a tall
 * block), and the heading at the top is then another one. So a choice is kept until the
 * user scrolls the panel: the first view state after the choice is the panel settling on
 * it, and a later one with another top line ends the choice.
 */
export class HeadingFollower {
  private chosen: { index: number; settledTop: number | null } | null = null;

  /** The user chose heading `index` in the tree; `atTop` is the heading at the panel's top just then. */
  choose(index: number, atTop: number): void {
    this.chosen = index === atTop ? null : { index, settledTop: null };
  }

  viewStateReported(topLine: number): void {
    const c = this.chosen;
    if (!c) return;
    if (c.settledTop === null) c.settledTop = topLine;
    else if (topLine !== c.settledTop) this.chosen = null;
  }

  /** The heading to show as selected, given the heading at the panel's top. */
  target(atTop: number): number {
    return this.chosen ? this.chosen.index : atTop;
  }

  /** The headings changed or another panel became active: the choice no longer holds. */
  reset(): void {
    this.chosen = null;
  }
}
