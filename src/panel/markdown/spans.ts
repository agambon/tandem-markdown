// Spans in brackets with attributes, as Pandoc writes them when it converts a Word file:
// `[text]{.underline}`, `[text]{.smallcaps}`, `[text]{.mark}`, and the bookmarks Word leaves,
// `[]{#_Toc123 .anchor}`. Brackets are a span only when braces holding attributes follow the
// closing bracket at once and give one of those styles (`spanStyle` in core/attributes.ts);
// any other bracketed text stays as CommonMark reads it, a link included.
//
// Where each span may close is found in one pass over a paragraph's text (brackets paired as
// they nest, escaped ones skipped), so a paragraph of many brackets is not scanned again
// from each of them.
//
// Nodes: `Span`, holding a `SpanMark` for each bracket, the inline content between them, and
// the `Attributes`.

import type { DelimiterType, InlineContext, MarkdownConfig } from '@lezer/markdown';
import { attributesEnd, readAttributes, spanStyle } from '../../core/attributes';
import { CODE_BACKSLASH, CODE_CLOSE_BRACKET, CODE_OPEN_BRACE, CODE_OPEN_BRACKET } from '../../core/markdownText';

const SpanStart: DelimiterType = {};

interface Pairs {
  /** The closing bracket of each opening one that starts a span, by offset into the text. */
  closeOf: Map<number, number>;
  /** The end of the attributes after each such closing bracket. */
  endOf: Map<number, number>;
}

const pairsByContext = new WeakMap<InlineContext, Pairs>();

function pairsOf(cx: InlineContext): Pairs {
  let pairs = pairsByContext.get(cx);
  if (pairs) return pairs;
  pairs = { closeOf: new Map(), endOf: new Map() };
  const text = cx.text;
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === CODE_BACKSLASH) i++;
    else if (code === CODE_OPEN_BRACKET) open.push(i);
    else if (code === CODE_CLOSE_BRACKET && open.length) {
      const from = open.pop()!;
      if (text.charCodeAt(i + 1) !== CODE_OPEN_BRACE) continue;
      const end = attributesEnd(text, i + 1);
      const attributes = end < 0 ? null : readAttributes(text.slice(i + 1, end));
      if (!attributes || !spanStyle(attributes, i === from + 1)) continue;
      pairs.closeOf.set(from, i);
      pairs.endOf.set(i, end);
    }
  }
  pairsByContext.set(cx, pairs);
  return pairs;
}

function parseOpen(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_OPEN_BRACKET || !pairsOf(cx).closeOf.has(pos - cx.offset)) return -1;
  return cx.addDelimiter(SpanStart, pos, pos + 1, true, false);
}

function parseClose(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_CLOSE_BRACKET) return -1;
  const pairs = pairsOf(cx);
  const end = pairs.endOf.get(pos - cx.offset);
  if (end === undefined) return -1;
  const index = cx.findOpeningDelimiter(SpanStart);
  const opening = index === null ? null : cx.getDelimiterAt(index);
  if (index === null || !opening || pairs.closeOf.get(opening.from - cx.offset) !== pos - cx.offset) return -1;
  const content = cx.takeContent(index);
  const to = cx.offset + end;
  return cx.addElement(
    cx.elt('Span', opening.from, to, [
      cx.elt('SpanMark', opening.from, opening.to),
      ...content,
      cx.elt('SpanMark', pos, pos + 1),
      cx.elt('Attributes', pos + 1, to),
    ]),
  );
}

export const Spans: MarkdownConfig = {
  defineNodes: ['Span', 'SpanMark', 'Attributes'],
  parseInline: [
    { name: 'SpanStart', parse: parseOpen, before: 'Link' },
    { name: 'SpanEnd', parse: parseClose, before: 'LinkEnd' },
  ],
};
