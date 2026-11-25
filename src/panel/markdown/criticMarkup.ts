// Tracked-change marks, CriticMarkup as MultiMarkdown, PyMdown and Markdown Preview Enhanced
// read them:
//
//   {++added++}   {--deleted--}   {~~old~>new~~}   {==marked==}   {>>a comment<<}
//
// A mark runs to its first closing sequence in its paragraph, and holds ordinary inline
// markdown. A substitution needs its `~>`. Where each mark may close is found in one pass over
// the paragraph's text, so that many openings are not each scanned to the end.
//
// Nodes: `CriticAddition`, `CriticDeletion`, `CriticSubstitution` (the old text, a
// `CriticArrow`, the new), `CriticHighlight` and `CriticComment`, each opened and closed by a
// `CriticMark`.

import type { Element, InlineContext, MarkdownConfig } from '@lezer/markdown';
import { CODE_OPEN_BRACE } from '../../core/markdownText';
import { firstFrom } from '../../core/textLines';

/** Each mark's second and third characters, its closing sequence and its node. */
const MARKS: Record<string, { close: string; node: string }> = {
  '++': { close: '++}', node: 'CriticAddition' },
  '--': { close: '--}', node: 'CriticDeletion' },
  '~~': { close: '~~}', node: 'CriticSubstitution' },
  '==': { close: '==}', node: 'CriticHighlight' },
  '>>': { close: '<<}', node: 'CriticComment' },
};

/** Where each closing sequence (and a substitution's `~>`) stands in a paragraph's text, by sequence. */
const closersByContext = new WeakMap<InlineContext, Map<string, number[]>>();

function closersOf(cx: InlineContext, close: string): number[] {
  let all = closersByContext.get(cx);
  if (!all) closersByContext.set(cx, (all = new Map()));
  let found = all.get(close);
  if (!found) {
    found = [];
    for (let i = cx.text.indexOf(close); i >= 0; i = cx.text.indexOf(close, i + close.length)) found.push(i);
    all.set(close, found);
  }
  return found;
}

function parseCritic(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_OPEN_BRACE) return -1;
  const mark = MARKS[cx.slice(pos + 1, pos + 3)];
  if (!mark) return -1;
  const at = pos - cx.offset;
  const close = firstFrom(closersOf(cx, mark.close), at + 4);
  if (close < 0) return -1;
  const from = pos + 3;
  const to = cx.offset + close;
  const children: Element[] = [cx.elt('CriticMark', pos, from)];
  if (mark.node === 'CriticSubstitution') {
    const arrow = firstFrom(closersOf(cx, '~>'), at + 3);
    if (arrow < 0 || arrow >= close) return -1;
    children.push(...cx.parser.parseInline(cx.slice(from, cx.offset + arrow), from));
    children.push(cx.elt('CriticArrow', cx.offset + arrow, cx.offset + arrow + 2));
    children.push(...cx.parser.parseInline(cx.slice(cx.offset + arrow + 2, to), cx.offset + arrow + 2));
  } else {
    children.push(...cx.parser.parseInline(cx.slice(from, to), from));
  }
  children.push(cx.elt('CriticMark', to, to + 3));
  return cx.addElement(cx.elt(mark.node, pos, to + 3, children));
}

export const CriticMarkup: MarkdownConfig = {
  defineNodes: [
    'CriticAddition',
    'CriticDeletion',
    'CriticSubstitution',
    'CriticHighlight',
    'CriticComment',
    'CriticMark',
    'CriticArrow',
  ],
  parseInline: [{ name: 'CriticMarkup', parse: parseCritic, before: 'InlineCode' }],
};
