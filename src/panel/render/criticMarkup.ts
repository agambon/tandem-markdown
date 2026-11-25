// Tracked-change marks (markdown/criticMarkup.ts), drawn as the programs that read them draw
// their HTML: an addition as inserted text, a deletion as deleted text, a substitution as the
// one then the other, a highlight as highlighted text and a comment as a note in small faded
// type. The marks are hidden unless a selection touches the change, as bold's are.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { Feature } from '../features';
import { CODE_SPANS, NO_INLINE, selfRevealingChildren } from '../markdown/nodes';
import { inlineFeature, type InlineDraw } from './framework';

const CLASSES: Record<string, string> = {
  CriticAddition: 'tm-critic-add',
  CriticDeletion: 'tm-critic-del',
  CriticHighlight: 'tm-highlight',
  CriticComment: 'tm-critic-comment',
};

function drawChange(d: InlineDraw, node: SyntaxNode): void {
  const marks = node.getChildren('CriticMark');
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return;
  const revealed = d.revealed(node.from, node.to, selfRevealingChildren(node));
  const arrow = node.getChild('CriticArrow');
  for (const mark of arrow ? [open, arrow, close] : [open, close]) {
    if (revealed) d.mark(mark.from, mark.to, 'tm-mark');
    else d.hide(mark.from, mark.to);
  }
  if (arrow) {
    d.mark(open.to, arrow.from, 'tm-critic-del');
    d.mark(arrow.to, close.from, 'tm-critic-add');
  } else {
    d.mark(open.to, close.from, CLASSES[node.name]!);
  }
}

const NODES = new Set(['CriticAddition', 'CriticDeletion', 'CriticSubstitution', 'CriticHighlight', 'CriticComment']);

export const criticMarkup: Feature = {
  id: 'criticMarkup',
  extension: () => [
    inlineFeature('criticMarkup', (d) => {
      d.iterate((node) => {
        if (NO_INLINE.has(node.name) || CODE_SPANS.has(node.name)) return false;
        if (NODES.has(node.name)) drawChange(d, node.node);
        return true;
      });
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-critic-add': {
        background: 'var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.2))',
        textDecoration: 'underline',
      },
      '& .cm-content .tm-critic-del': {
        background: 'var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.2))',
        textDecoration: 'line-through',
      },
      '& .cm-content .tm-critic-comment': {
        color: 'var(--tm-faded)',
        fontSize: '0.85em',
        fontStyle: 'italic',
      },
    }),
  ],
};
