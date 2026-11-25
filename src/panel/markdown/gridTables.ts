// Grid tables, as Pandoc writes them for tables from Word, whose cells hold paragraphs and lists:
//
//   +---------+--------+
//   | Fruit   | Price  |
//   +=========+========+      the row of `=` ends the header
//   | Bananas | $1.34  |
//   +---------+--------+
//
// One opens with a border line (`+`, then runs of `-`, `=` or `:`, each closed by `+`) and runs
// over the lines that start with `|` or `+`; it cannot interrupt a paragraph. Its lines are not
// read as markdown, so a `+===+` row is no highlight. Node: `GridTable`, a leaf block, whose
// cells render/gridTables.ts reads.

import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';
import { CODE_PIPE, CODE_PLUS } from '../../core/markdownText';
import { reached } from './blockContext';
import { indentedAsCode } from './chars';

/** A border line from `pos`: `+`, then one or more runs of `-`, `=` or `:`, each ended by `+`. */
export const BORDER = /^\+(?:[-=:]+\+)+[ \t]*$/;

function parseGridTable(cx: BlockContext, line: Line): boolean {
  if (line.next !== CODE_PLUS || indentedAsCode(line) || !BORDER.test(line.text.slice(line.pos))) return false;
  const from = cx.lineStart + line.pos;
  const markers = [];
  const continues = (next: Line) => reached(next) >= cx.depth && (next.next === CODE_PIPE || next.next === CODE_PLUS);
  while (cx.nextLine() && continues(line)) markers.push(...line.markers);
  cx.addElement(cx.elt('GridTable', from, cx.prevLineEnd(), markers));
  return true;
}

export const GridTables: MarkdownConfig = {
  defineNodes: [{ name: 'GridTable', block: true }],
  parseBlock: [{ name: 'GridTable', parse: parseGridTable, before: 'LinkReference' }],
};
