// Block ids, as Obsidian writes them (src/core/blockId.ts): `^quote-1` at the end of a
// paragraph's last line, or a paragraph line of its own after a list, a table or a quote. A link
// or an embed names the block by it (`[[Note#^quote-1]]`); the text is not the block's. Faded in
// Rich editor; hidden in Rich view, the space before it too, and a line that holds only the id
// with it.

import { EditorView } from '@codemirror/view';
import { blockIdOf } from '../../core/blockId';
import { isSpaceOrTab } from '../../core/markdownText';
import type { Feature } from '../features';
import { blockFeature } from './framework';

export const blockIds: Feature = {
  id: 'blockIds',
  extension: () => [
    blockFeature('blockIds', (d) => {
      d.blocks((block) => {
        if (block.name !== 'Paragraph') return;
        const from = d.lines.start(block.lastLine);
        const to = Math.min(d.lines.end(block.lastLine), block.to);
        const line = d.doc.sliceString(from, to);
        const id = blockIdOf(line);
        if (id === null) return;
        const end = from + line.trimEnd().length;
        const caret = end - id.length - 1;
        const alone = line.trim() === `^${id}`;
        if (d.mode === 'edit') {
          d.mark(caret, end, 'tm-block-id');
        } else if (alone) {
          d.hideLines(from, to);
        } else {
          let start = caret;
          while (start > from && isSpaceOrTab(line.charCodeAt(start - from - 1))) start--;
          d.hide(start, end);
        }
      });
    }),
    EditorView.baseTheme({ '& .cm-content .tm-block-id': { color: 'var(--tm-faded)', opacity: '0.7' } }),
  ],
};
