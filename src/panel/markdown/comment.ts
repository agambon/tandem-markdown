// Obsidian's comments: `%%hidden%%` inside a paragraph, and a block that starts with a line
// beginning `%%` and ends at the next `%%`, over as many lines as it takes, blank ones included.
// A block never closed runs to the end of the file, as Obsidian hides the rest of a note then.
// Nothing inside a comment is read as markdown. `\%%` is no mark, and a line that closes its own
// `%%` is a comment inside a paragraph, not a block. A block is read at the top level of the
// file only; inside a list item or a quote, `%%` lines are a comment only when they close within
// their paragraph.
//
// Nodes:
//   PercentComment       `%%...%%` inside a paragraph, holding two `PercentCommentMark`
//   PercentCommentBlock  the block's lines, holding a `PercentCommentMark` for its opening `%%`
//                        and, when it closes, one for its closing `%%`

import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';
import { CODE_PERCENT, indentedAsCode } from './chars';

/** Whether `line` starts a comment block: at the top level, `%%` first on it and no `%%` after that. */
function opensBlock(cx: BlockContext, line: Line): boolean {
  if (cx.parentType().name !== 'Document' || indentedAsCode(line)) return false;
  const text = line.text;
  if (text.charCodeAt(line.pos) !== CODE_PERCENT || text.charCodeAt(line.pos + 1) !== CODE_PERCENT) return false;
  return text.indexOf('%%', line.pos + 2) < 0;
}

function parseBlock(cx: BlockContext, line: Line): boolean {
  if (!opensBlock(cx, line)) return false;
  const from = cx.lineStart + line.pos;
  const marks = [cx.elt('PercentCommentMark', from, from + 2)];
  while (cx.nextLine()) {
    const close = line.text.indexOf('%%', line.pos);
    if (close >= 0) {
      marks.push(cx.elt('PercentCommentMark', cx.lineStart + close, cx.lineStart + close + 2));
      cx.nextLine();
      break;
    }
  }
  cx.addElement(cx.elt('PercentCommentBlock', from, cx.prevLineEnd(), marks));
  return true;
}

function parseInline(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_PERCENT || cx.char(pos + 1) !== CODE_PERCENT) return -1;
  // A failed search means no `%%` starts after it, so few searches fail in one paragraph.
  const close = cx.text.indexOf('%%', pos + 3 - cx.offset);
  if (close < 0) return -1;
  const end = cx.offset + close;
  return cx.addElement(
    cx.elt('PercentComment', pos, end + 2, [
      cx.elt('PercentCommentMark', pos, pos + 2),
      cx.elt('PercentCommentMark', end, end + 2),
    ]),
  );
}

export const PercentComments: MarkdownConfig = {
  defineNodes: [
    { name: 'PercentCommentBlock', block: true },
    { name: 'PercentComment' },
    { name: 'PercentCommentMark' },
  ],
  parseBlock: [{ name: 'PercentCommentBlock', parse: parseBlock, endLeaf: (cx, line) => opensBlock(cx, line) }],
  parseInline: [{ name: 'PercentComment', parse: parseInline, before: 'Emphasis' }],
};
