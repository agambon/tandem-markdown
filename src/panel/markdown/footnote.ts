// Footnotes: references `[^id]`, definitions `[^id]: text` at the start of a line, and notes
// written in place, `^[text]` (Pandoc, Obsidian, markdown-it-footnote). A label follows
// markdown-it-footnote: not empty, no spaces, tabs or brackets, so MultiMarkdown's
// `[^This is the note]` is none. A note written in place lies on one line.
//
// Nodes:
//   FootnoteRef     `[^id]`. Not taken when `(` follows: `[^id](url)` is a link, as in markdown-it.
//   FootnoteDef     a block from `[^id]:` to the end of its content: further lines indented by
//                   DEFINITION_INDENT or more spaces, its first paragraph continuing lazily. It
//                   can interrupt a paragraph.
//     FootnoteLabel `[^id]:`, the colon included, as the definition's first child.
//   InlineFootnote  `^[text]`: an `InlineFootnoteMark` at either end and the inline content between.

import { tags } from '@lezer/highlight';
import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';
import {
  CODE_BACKSLASH,
  CODE_CLOSE_BRACKET,
  CODE_COLON,
  CODE_CR,
  CODE_LF,
  CODE_OPEN_BRACKET,
  CODE_OPEN_PAREN,
  CODE_SPACE,
  CODE_TAB,
} from '../../core/markdownText';
import { CODE_CARET } from './chars';

/** The longest note written in place; the scan from a `^[` that never closes stops here. */
const MAX_NOTE_LENGTH = 1000;

/** Length of a valid label body starting at `from`, read through `charAt` (up to, not including, `]`), or -1. */
function labelLength(charAt: (i: number) => number, from: number, end: number): number {
  for (let i = from; i < end; i++) {
    const ch = charAt(i);
    if (ch === CODE_CLOSE_BRACKET) return i > from ? i - from : -1;
    if (ch === CODE_OPEN_BRACKET || ch === CODE_SPACE || ch === CODE_TAB || ch === CODE_LF || ch === CODE_CR) return -1;
  }
  return -1;
}

/** Length of `[^id]:` at `line.pos`, or -1. */
function definitionStart(line: Line): number {
  const text = line.text;
  const pos = line.pos;
  if (text.charCodeAt(pos) !== CODE_OPEN_BRACKET || text.charCodeAt(pos + 1) !== CODE_CARET) return -1;
  const length = labelLength((i) => text.charCodeAt(i), pos + 2, text.length);
  if (length < 0) return -1;
  const close = pos + 2 + length;
  return text.charCodeAt(close + 1) === CODE_COLON ? close + 2 - pos : -1;
}

function parseReference(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_OPEN_BRACKET || cx.char(pos + 1) !== CODE_CARET) return -1;
  const length = labelLength((i) => cx.char(i), pos + 2, cx.end);
  if (length < 0) return -1;
  const end = pos + 2 + length + 1;
  if (cx.char(end) === CODE_OPEN_PAREN) return -1;
  return cx.addElement(cx.elt('FootnoteRef', pos, end));
}

/**
 * A note written in place: brackets inside it pair up, and an escaped one does not count. A
 * note holds no note, so the search stops at the next `^[`, and no character is looked at by
 * two searches.
 */
function parseInlineNote(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_CARET || cx.char(pos + 1) !== CODE_OPEN_BRACKET) return -1;
  const limit = Math.min(cx.end, pos + 2 + MAX_NOTE_LENGTH);
  let depth = 0;
  for (let i = pos + 2; i < limit; i++) {
    const ch = cx.char(i);
    if (ch === CODE_LF || (ch === CODE_CARET && cx.char(i + 1) === CODE_OPEN_BRACKET)) return -1;
    if (ch === CODE_BACKSLASH) i++;
    else if (ch === CODE_OPEN_BRACKET) depth++;
    else if (ch === CODE_CLOSE_BRACKET && depth > 0) depth--;
    else if (ch === CODE_CLOSE_BRACKET) {
      if (cx.slice(pos + 2, i).trim() === '') return -1;
      return cx.addElement(
        cx.elt('InlineFootnote', pos, i + 1, [
          cx.elt('InlineFootnoteMark', pos, pos + 2),
          ...cx.parser.parseInline(cx.slice(pos + 2, i), pos + 2),
          cx.elt('InlineFootnoteMark', i, i + 1),
        ]),
      );
    }
  }
  return -1;
}

/** Continuation indent of a definition, as markdown-it-footnote uses. */
export const DEFINITION_INDENT = 4;

export const Footnote: MarkdownConfig = {
  defineNodes: [
    {
      name: 'FootnoteDef',
      block: true,
      composite(_cx: BlockContext, line: Line, value: number) {
        if (line.indent < line.baseIndent + value && line.next > -1) return false;
        line.moveBaseColumn(line.baseIndent + value);
        return true;
      },
    },
    { name: 'FootnoteLabel', style: tags.labelName },
    { name: 'FootnoteRef', style: tags.labelName },
    { name: 'InlineFootnote' },
    { name: 'InlineFootnoteMark', style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'FootnoteDef',
      parse(cx, line) {
        const size = definitionStart(line);
        if (size < 0) return false;
        cx.startComposite('FootnoteDef', line.pos, DEFINITION_INDENT);
        cx.addElement(cx.elt('FootnoteLabel', cx.lineStart + line.pos, cx.lineStart + line.pos + size));
        line.moveBase(line.pos + size);
        return null;
      },
      endLeaf(_cx, line) {
        return definitionStart(line) >= 0;
      },
      before: 'LinkReference',
    },
  ],
  parseInline: [
    { name: 'FootnoteRef', parse: parseReference, before: 'Link' },
    { name: 'InlineFootnote', parse: parseInlineNote, before: 'Link' },
  ],
};
