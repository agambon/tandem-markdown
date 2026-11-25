// Block quotes, and the boxes (`:::`, `!!!`) that are drawn as a level of quote
// (`QUOTE_LEVELS`; render/boxes.ts draws their heads and colors).
//
// Every line of a quote gets `tm-quote`, a depth class `tm-qd<n>` (how many quotes hold the
// line) and an offset class `tm-qx<n>` (how many list levels sit outside the outermost
// quote, so its bars start at that list's text). The stylesheet draws one bar per depth,
// the quote background and the faded text from those classes.
//
// A `>` marker is hidden with the one space after it, unless the cursor is on its line. A
// line holding only markers is drawn at the height of the gap between blocks
// (`tm-quote-gap`), as the space between two paragraphs of a quote is.

import { IterMode, type SyntaxNode } from '@lezer/common';
import type { Feature } from '../features';
import { QUOTE_LEVELS } from '../markdown/nodes';
import { blockFeature } from './framework';
import { MAX_LIST_DEPTH, MAX_QUOTE_DEPTH } from './layout';
import type { BlockEntry } from './lines';

/** Every QuoteMark inside `quote`. Markers of a quote's later lines sit inside the blocks they cross. */
function quoteMarks(quote: SyntaxNode, out: { from: number; to: number }[]): void {
  const cursor = quote.cursor(IterMode.IgnoreMounts);
  let depth = 0;
  for (;;) {
    if (cursor.name === 'QuoteMark') out.push({ from: cursor.from, to: cursor.to });
    if (cursor.firstChild()) {
      depth++;
      continue;
    }
    while (!cursor.nextSibling()) {
      if (depth === 0 || !cursor.parent()) return;
      depth--;
    }
    if (depth === 0) return;
  }
}

const CODE = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock']);

export const quotes: Feature = {
  id: 'quotes',
  extension: () =>
    blockFeature('quotes', (d) => {
      const outer: BlockEntry[] = [];
      let depthOfLine: Uint8Array | null = null;
      let offsetOfLine: Uint8Array | null = null;
      const codeLines = new Set<number>();
      d.blocks((block) => {
        if (CODE.has(block.name) && block.quoteDepth > 0) {
          // An empty line inside code keeps its height.
          for (let n = block.firstLine; n <= block.lastLine; n++) codeLines.add(n);
          return;
        }
        if (!QUOTE_LEVELS.has(block.name)) return;
        depthOfLine ??= new Uint8Array(d.lines.count + 1);
        offsetOfLine ??= new Uint8Array(d.lines.count + 1);
        for (let n = block.firstLine; n <= block.lastLine; n++) depthOfLine[n]!++;
        if (block.quoteDepth === 1) {
          outer.push(block);
          const listsOutside = Math.min(block.listDepth, MAX_LIST_DEPTH);
          for (let n = block.firstLine; n <= block.lastLine; n++) offsetOfLine[n] = listsOutside;
        }
      });
      if (!depthOfLine || !offsetOfLine) return;
      const depths: Uint8Array = depthOfLine;
      const offsets: Uint8Array = offsetOfLine;

      const marks: { from: number; to: number }[] = [];
      for (const quote of outer) quoteMarks(quote.node, marks);
      for (const mark of marks) {
        if (d.lineRevealed(mark.from)) {
          d.mark(mark.from, mark.to, 'tm-mark');
        } else {
          const space = d.doc.sliceString(mark.to, mark.to + 1) === ' ' ? 1 : 0;
          d.hide(mark.from, mark.to + space);
        }
      }

      for (const quote of outer) {
        for (let n = quote.firstLine; n <= quote.lastLine; n++) {
          const depth = depths[n];
          if (!depth) continue;
          const text = d.lines.text(n);
          const onlyMarks = !codeLines.has(n) && /^[\s>]*$/.test(text) && text.includes('>');
          const classes = `tm-quote tm-qd${Math.min(depth, MAX_QUOTE_DEPTH)} tm-qx${offsets[n]}`;
          d.line(d.lines.start(n), onlyMarks ? `${classes} tm-quote-gap` : classes);
        }
      }
    }),
};
