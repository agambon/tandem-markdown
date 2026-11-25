// Attributes after a heading (markdown/headingAttributes.ts): the braces, and the spaces before
// them, hidden; shown faded while the cursor is on the heading's line, as its `#` marks are.

import { isSpaceOrTab } from '../../core/markdownText';
import type { Feature } from '../features';
import { isAtxHeading, NO_INLINE } from '../markdown/nodes';
import { inlineFeature } from './framework';

export const headingAttributes: Feature = {
  id: 'headingAttributes',
  extension: () =>
    inlineFeature('headingAttributes', (d) => {
      d.iterate((node) => {
        if (node.name === 'Paragraph' || NO_INLINE.has(node.name)) return false;
        if (node.name !== 'Attributes') return true;
        const heading = node.node.parent;
        if (!heading || !isAtxHeading(heading.name)) return false;
        if (d.lineRevealed(node.from)) {
          d.mark(node.from, node.to, 'tm-mark');
          return false;
        }
        const line = d.lines.get(d.lines.numberAt(node.from));
        let from = node.from;
        while (from > line.from && isSpaceOrTab(line.text.charCodeAt(from - 1 - line.from))) from--;
        d.hide(from, node.to);
        return false;
      });
    }),
};
