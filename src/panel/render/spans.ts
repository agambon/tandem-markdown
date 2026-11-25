// Styled spans (markdown/spans.ts): `[text]{.underline}` underlined, `{.smallcaps}` in small
// capitals and `{.mark}` highlighted, the brackets and braces hidden unless a selection
// touches the span, as bold's marks are. A bookmark Word left (`[]{#_Toc123 .anchor}`) is
// hidden whole; a link to its id still finds it (`findAnchor` in core/attributes.ts).

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { readAttributes, spanStyle, type SpanStyle } from '../../core/attributes';
import type { Feature } from '../features';
import { CODE_SPANS, NO_INLINE, selfRevealingChildren } from '../markdown/nodes';
import { inlineFeature, type InlineDraw } from './framework';

const CLASSES: Record<SpanStyle, string> = {
  underline: 'tm-underline',
  smallcaps: 'tm-smallcaps',
  mark: 'tm-highlight',
  anchor: '',
};

function drawSpan(d: InlineDraw, span: SyntaxNode): void {
  const marks = span.getChildren('SpanMark');
  const braces = span.getChild('Attributes');
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (!open || !close || open === close || !braces) return;
  const attributes = readAttributes(d.doc.sliceString(braces.from, braces.to));
  const style = attributes && spanStyle(attributes, close.from === open.to);
  if (!style) return;
  if (d.revealed(span.from, span.to, selfRevealingChildren(span))) {
    d.mark(open.from, open.to, 'tm-mark');
    d.mark(close.from, braces.to, 'tm-mark');
  } else if (close.from === open.to) {
    d.hide(span.from, span.to);
    return;
  } else {
    d.hide(open.from, open.to);
    d.hide(close.from, braces.to);
  }
  if (CLASSES[style]) d.mark(open.to, close.from, CLASSES[style]);
}

export const spans: Feature = {
  id: 'spans',
  extension: () => [
    inlineFeature('spans', (d) => {
      d.iterate((node) => {
        if (NO_INLINE.has(node.name) || CODE_SPANS.has(node.name)) return false;
        if (node.name === 'Span') drawSpan(d, node.node);
        return true;
      });
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-underline': { textDecoration: 'underline' },
      '& .cm-content .tm-smallcaps': { fontVariant: 'small-caps' },
    }),
  ],
};
