// Obsidian's comments (markdown/comment.ts), as Obsidian shows them: faded in Rich editor, marks
// included (`tm-comment`), and gone in Rich view. A comment block, or a paragraph that holds
// nothing but comments, leaves Rich view with the blank line after it, as an HTML comment does.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { Feature } from '../features';
import { NO_INLINE } from '../markdown/nodes';
import { blockFeature, inlineFeature, type BlockDraw } from './framework';
import { drawComment, hideWithGap } from './layout';

/** Whether a paragraph holds nothing but comments and the space between them. */
function onlyComments(d: BlockDraw, paragraph: SyntaxNode): boolean {
  const blank = (from: number, to: number) => d.doc.sliceString(from, to).trim() === '';
  let pos = paragraph.from;
  let found = false;
  for (let child = paragraph.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'PercentComment' || !blank(pos, child.from)) return false;
    found = true;
    pos = child.to;
  }
  return found && blank(pos, paragraph.to);
}

export const comments: Feature = {
  id: 'comments',
  extension: () => [
    blockFeature('comments', (d) => {
      d.blocks((block) => {
        if (block.name === 'PercentCommentBlock') {
          if (d.mode === 'view') hideWithGap(d, block);
          else for (let n = block.firstLine; n <= block.lastLine; n++) d.line(d.lines.start(n), 'tm-comment');
        } else if (block.name === 'Paragraph' && d.mode === 'view' && onlyComments(d, block.node)) {
          hideWithGap(d, block);
        }
      });
    }),
    inlineFeature('comments', (d) => {
      d.iterate((node) => {
        if (NO_INLINE.has(node.name)) return false;
        if (node.name !== 'PercentComment') return true;
        drawComment(d, node.from, node.to, 'tm-comment');
        return false;
      });
    }),
    EditorView.baseTheme({ '& .cm-content .tm-comment': { color: 'var(--tm-faded)' } }),
  ],
};
