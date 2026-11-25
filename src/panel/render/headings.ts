// Headings, ATX (`# Title`) and Setext (`Title` underlined with `===` or `---`).
//
// Every line of a heading gets `tm-h tm-h<level>`. The `#` marks (and a closing `##` run)
// are hidden unless the cursor is on the line; a Setext underline line is removed unless
// the cursor is on one of the heading's lines, when it shows as `tm-setext-underline`.

import { isSpaceOrTab } from '../../core/markdownText';
import type { Feature } from '../features';
import { headingLevel, isAtxHeading } from '../markdown/nodes';
import { blockFeature, type BlockDraw } from './framework';
import type { BlockEntry } from './lines';

function atx(d: BlockDraw, block: BlockEntry, level: number): void {
  d.line(block.from, `tm-h tm-h${level}`);
  const revealed = d.lineRevealed(block.from);
  const lineFrom = d.lines.start(block.firstLine);
  const text = d.lines.text(block.firstLine);
  // Up to three spaces may stand before the marks; they mean nothing on the page.
  if (!revealed && block.from > lineFrom && /^[ \t]+$/.test(text.slice(0, block.from - lineFrom))) {
    d.hide(lineFrom, block.from);
  }
  for (let mark = block.node.firstChild; mark; mark = mark.nextSibling) {
    if (mark.name !== 'HeaderMark') continue;
    if (revealed) {
      d.mark(mark.from, mark.to, 'tm-mark');
    } else if (mark.from === block.from) {
      let end = mark.to;
      while (end < block.to && isSpaceOrTab(text.charCodeAt(end - lineFrom))) end++;
      d.hide(mark.from, end);
    } else {
      // A closing run: hide it with the spaces before it.
      let start = mark.from;
      while (start > block.from && isSpaceOrTab(text.charCodeAt(start - 1 - lineFrom))) start--;
      d.hide(start, mark.to);
    }
  }
}

function setext(d: BlockDraw, block: BlockEntry, level: number): void {
  const underline = block.node.getChild('HeaderMark');
  const lastText = underline ? d.lines.numberAt(underline.from) - 1 : block.lastLine;
  for (let n = block.firstLine; n <= Math.max(block.firstLine, lastText); n++)
    d.line(d.lines.start(n), `tm-h tm-h${level}`);
  if (!underline) return;
  if (d.blockRevealed(block.from, block.to)) {
    d.line(underline.from, 'tm-setext-underline');
    d.mark(underline.from, underline.to, 'tm-mark');
  } else {
    d.hideLines(underline.from, underline.to);
  }
}

export const headings: Feature = {
  id: 'headings',
  extension: () =>
    blockFeature('headings', (d) => {
      d.blocks((block) => {
        const level = headingLevel(block.name);
        if (!level) return;
        if (isAtxHeading(block.name)) atx(d, block, level);
        else setext(d, block, level);
      });
    }),
};
