// Character codes the parsers and readers of text compare against, each named once by its
// character, beside those the core names for itself and the panel (src/core/markdownText.ts),
// and the small readers of spaces they share: skipping them, counting the columns they take as
// CommonMark does, and whether a line's indent makes it code.

import type { Line } from '@lezer/markdown';
import { CODE_TAB, isSpaceOrTab } from '../../core/markdownText';

export const CODE_BANG = 33;
export const CODE_PERCENT = 37;
export const CODE_STAR = 42;
export const CODE_SLASH = 47;
export const CODE_LESS_THAN = 60;
export const CODE_GREATER_THAN = 62;
export const CODE_QUESTION_MARK = 63;
export const CODE_CARET = 94;
export const CODE_TILDE = 126;

/** The index of the first character at or after `from` in `text` that is not a space or a tab. */
export function skipSpaces(text: string, from: number): number {
  while (from < text.length && isSpaceOrTab(text.charCodeAt(from))) from++;
  return from;
}

/**
 * CommonMark's tab stop: a tab in a line's indent runs to the next multiple of 4 columns,
 * whatever the editor's tab size.
 */
const TAB_STOP = 4;

/** The column after the character `code` when it stands at `column`. */
export function nextColumn(column: number, code: number): number {
  return code === CODE_TAB ? column + TAB_STOP - (column % TAB_STOP) : column + 1;
}

/** Columns of indent past its container from which a line is code (CommonMark): no other block starts there. */
const INDENTED_CODE_COLUMNS = 4;

/** Whether `line` is indented past its container far enough to be indented code. */
export function indentedAsCode(line: Line): boolean {
  return line.indent >= line.baseIndent + INDENTED_CODE_COLUMNS;
}

/** The columns from index `from` to index `to` of `text`. */
export function columnsBetween(text: string, from: number, to: number): number {
  let column = 0;
  for (let i = from; i < to; i++) column = nextColumn(column, text.charCodeAt(i));
  return column;
}
