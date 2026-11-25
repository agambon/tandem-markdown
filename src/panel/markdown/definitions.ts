// Definition lists, as Pandoc, PHP Markdown Extra, Python-Markdown, kramdown, Hugo, GitLab and
// markdown-it-deflist write them: a term on a line of its own, then its definition, a line
// that starts with `:` and a space (at most three spaces in). One blank line may stand between
// them when they are not inside a quote or a list; a term may have several definitions. A
// definition's further lines are indented to its text, and it holds any blocks, as a list item
// does. A list opens at its term, which looks down for its definition: frontmatter.ts parses
// again the lines just above each change, so a definition typed below a term finds it.
//
// Nodes: `DefinitionList`, a container block holding the term (a paragraph) and one or more
// `Definition`s, each a container block whose first child is its `DefinitionMark` (the `:`).

import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';
import { CODE_COLON, isSpaceOrTab } from '../../core/markdownText';
import { parseInput, reached } from './blockContext';
import { indentedAsCode } from './chars';

/** Columns from the start of a definition's marker to its text, when spaces after it would make code. */
const NARROW = 2;
const MAX_WIDTH = 5;

/** Whether `text`, from `pos`, starts with a definition's marker: `:` and a space or tab. */
function isMarker(text: string, pos: number): boolean {
  return text.charCodeAt(pos) === CODE_COLON && isSpaceOrTab(text.charCodeAt(pos + 1));
}

/** The width, in columns, from the `:` that starts `line` to its text, or -1 when it is not a definition's marker. */
function markerWidth(line: Line): number {
  if (indentedAsCode(line) || !isMarker(line.text, line.pos)) return -1;
  let text = line.pos + 1;
  while (isSpaceOrTab(line.text.charCodeAt(text))) text++;
  const width = line.countIndent(text, line.pos, line.indent) - line.indent;
  return text === line.text.length || width > MAX_WIDTH ? NARROW : width;
}

/** A line read raw, as a definition's: up to three spaces, and the quote markers of its containers, before the `:`. */
const RAW_MARKER = /^[ \t>]*:[ \t]/;

/** How much of a line is read to tell whether it starts with a definition's marker. */
const MARKER_PREFIX = 8;

/** Whether the line starting at `at` in the parse's text starts with a definition's marker. */
function definitionAt(cx: BlockContext, at: number): boolean {
  const input = parseInput(cx);
  return !!input && RAW_MARKER.test(input.read(at, Math.min(input.length, at + MARKER_PREFIX)));
}

/** A list opens at a line that would start a paragraph, when its definition follows. */
function startList(cx: BlockContext, line: Line): boolean | null {
  if (line.next < 0 || indentedAsCode(line) || cx.parentType().name === 'DefinitionList') return false;
  const next = cx.peekLine();
  if (!RAW_MARKER.test(next)) {
    // One blank line between term and definition, only where no container's marks stand.
    if (cx.depth !== 1 || next.trim() !== '') return false;
    if (!definitionAt(cx, cx.lineStart + line.text.length + 1 + next.length + 1)) return false;
  }
  cx.startComposite('DefinitionList', line.pos);
  return null;
}

function continueList(_cx: BlockContext, line: Line): boolean {
  return line.next < 0 || line.indent > line.baseIndent || markerWidth(line) >= 0;
}

function continueDefinition(_cx: BlockContext, line: Line, column: number): boolean {
  if (line.indent < line.baseIndent + column && line.next > -1) return false;
  line.moveBaseColumn(line.baseIndent + column);
  return true;
}

function startDefinition(cx: BlockContext, line: Line): boolean | null {
  if (cx.parentType().name !== 'DefinitionList') return false;
  const width = markerWidth(line);
  if (width < 0) return false;
  // Where its text starts, in columns from the base of the list.
  const column = line.indent - line.baseIndent + width;
  cx.startComposite('Definition', line.pos, column);
  cx.addElement(cx.elt('DefinitionMark', cx.lineStart + line.pos, cx.lineStart + line.pos + 1));
  line.moveBaseColumn(line.baseIndent + column);
  return null;
}

export const DefinitionLists: MarkdownConfig = {
  defineNodes: [
    { name: 'DefinitionList', block: true, composite: continueList },
    { name: 'Definition', block: true, composite: continueDefinition },
    'DefinitionMark',
  ],
  parseBlock: [
    {
      name: 'Definition',
      parse: startDefinition,
      // A definition ends the paragraph above it in its list: the term, or the definition before.
      endLeaf: (cx, line) =>
        reached(line) > 1 && cx.parentType(reached(line) - 1).name === 'DefinitionList' && markerWidth(line) >= 0,
      before: 'LinkReference',
    },
    { name: 'DefinitionList', parse: startList, after: 'SetextHeading' },
  ],
};
