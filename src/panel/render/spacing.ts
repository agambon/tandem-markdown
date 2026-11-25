// The gaps between blocks (the sizes are the stylesheet's, from `--tm-gap`):
// - A blank line after a line that is not blank is a gap line (`tm-gap-line`).
// - A blank line after a blank line is an extra one: in Rich view each run of them is removed
//   with one block replace; in Rich editor each is a short line (`tm-gap-extra`).
// - A top-level block right under another, with no blank line between, gets a gap above its
//   first line (`tm-gap-touch`); every heading line a little more (`tm-gap-heading`).
// - The first line of the file gets no gap (a blank first line counts as an extra one).
// - Blank lines inside code blocks, HTML blocks and front matter are ordinary lines.
// - Nothing here depends on the selection: a gap line the cursor is on keeps its height.
// The space above a line is a transparent top border, so a line's own background (a quote, a
// code box) starts below the gap.

import type { Feature } from '../features';
import { headingLevel, OPAQUE_BLOCKS } from '../markdown/nodes';
import { blockFeature } from './framework';
import { isBlankLine } from './lines';

export const spacing: Feature = {
  id: 'spacing',
  extension: () =>
    blockFeature('spacing', (d) => {
      const lines = d.lines;
      const first = lines.numberAt(d.from);
      const last = lines.numberAt(d.to);
      const size = last - first + 1;
      // Indexed by line number minus `first`.
      const ordinary = new Uint8Array(size);
      const above = new Uint8Array(size); // bit 1: touches the block before; bit 2: heading

      d.blocks((block) => {
        const at = block.firstLine - first;
        // A top-level block touches the one before when the line above it is not blank:
        // lines between top-level blocks are blank, so a line that is not belongs to the block before.
        if (block.top && block.firstLine > 1 && !isBlankLine(lines.text(block.firstLine - 1))) above[at]! |= 1;
        if (headingLevel(block.name)) above[at]! |= 2;
        if (OPAQUE_BLOCKS.has(block.name))
          ordinary.fill(1, Math.max(0, at), Math.min(size, block.lastLine - first + 1));
      });

      const view = d.mode === 'view';
      let runStart = 0;
      // The file's first line gets no gap. A span starts at a block, so the line before it is
      // either blank or the end of the block before.
      let previousBlank = first === 1 || isBlankLine(lines.text(first - 1));
      const endRun = (lastLine: number) => {
        if (runStart > 0 && view) d.hideLines(lines.start(runStart), lines.end(lastLine));
        runStart = 0;
      };

      for (let n = first; n <= last; n++) {
        const i = n - first;
        if (ordinary[i] || !isBlankLine(lines.text(n))) {
          endRun(n - 1);
          previousBlank = false;
          const bits = n === 1 ? 0 : above[i];
          if (bits === 1) d.line(lines.start(n), 'tm-gap-touch');
          else if (bits === 2) d.line(lines.start(n), 'tm-gap-heading');
          else if (bits === 3) d.line(lines.start(n), 'tm-gap-touch tm-gap-heading');
          continue;
        }
        if (!previousBlank) {
          endRun(n - 1);
          d.line(lines.start(n), 'tm-gap-line');
        } else if (view) {
          if (runStart === 0) runStart = n;
        } else {
          d.line(lines.start(n), 'tm-gap-extra');
        }
        previousBlank = true;
      }
      endRun(last);
    }),
};
