// Abbreviation definitions, as PHP Markdown Extra, Python-Markdown, kramdown and
// markdown-it-abbr write them: `*[HTML]: Hyper Text Markup Language`, on a line of its own,
// at most three spaces in. Each is its own block and may interrupt a paragraph, so that a run
// of them reads as one each. render/abbreviations.ts gives the abbreviation a tooltip wherever
// it stands in the text.
//
// Nodes: `Abbreviation`, a leaf block holding the `AbbreviationLabel` (`HTML`) and the
// `AbbreviationTitle` (what it stands for).

import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';
import { CODE_STAR, indentedAsCode } from './chars';

/** `*[label]: title`, the label without a `]` or a backslash, the title not empty (trailing spaces included). */
const DEFINITION = /^\*\[([^\]\\]+)\][ \t]?:[ \t]*(\S.*)$/;

function definitionAt(line: Line): RegExpExecArray | null {
  if (line.next !== CODE_STAR || indentedAsCode(line)) return null;
  return DEFINITION.exec(line.text.slice(line.pos));
}

function parseAbbreviation(cx: BlockContext, line: Line): boolean {
  const match = definitionAt(line);
  if (!match) return false;
  const from = cx.lineStart + line.pos;
  const label = from + 2;
  const title = from + match[0].length - match[2]!.length;
  cx.addElement(
    cx.elt('Abbreviation', from, cx.lineStart + line.text.length, [
      cx.elt('AbbreviationLabel', label, label + match[1]!.length),
      cx.elt('AbbreviationTitle', title, title + match[2]!.trimEnd().length),
    ]),
  );
  cx.nextLine();
  return true;
}

export const Abbreviations: MarkdownConfig = {
  defineNodes: [{ name: 'Abbreviation', block: true }, 'AbbreviationLabel', 'AbbreviationTitle'],
  parseBlock: [
    {
      name: 'Abbreviation',
      parse: parseAbbreviation,
      endLeaf: (_cx, line) => definitionAt(line) !== null,
      before: 'LinkReference',
    },
  ],
};
