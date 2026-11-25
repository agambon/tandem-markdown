// Horizontal rules: the line becomes a bar (`tm-hr`, drawn by the stylesheet) with its dashes
// hidden, unless the cursor is on the line, when the dashes show faded (`tm-hr-raw`).

import type { Feature } from '../features';
import { blockFeature } from './framework';

export const rules: Feature = {
  id: 'rules',
  extension: () =>
    blockFeature('rules', (d) => {
      d.blocks((block) => {
        if (block.name !== 'HorizontalRule') return;
        if (d.lineRevealed(block.from)) {
          d.line(block.from, 'tm-hr-raw');
          d.mark(block.from, block.to, 'tm-mark');
        } else {
          d.line(block.from, 'tm-hr');
          d.hide(block.from, block.to);
        }
      });
    }),
};
