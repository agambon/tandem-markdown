// Math in LaTeX's own delimiters, as chat assistants, Jupyter and MathJax pages write it:
//
//   \(a^2\)             in a line, anywhere. CommonMark reads `\(` as an escaped parenthesis.
//   \[ E = mc^2 \]      display math, only as a paragraph of its own (the `\[` opens it and
//                       the `\]` ends it): web clippers write `\[` for every bracket in a page.
//   \begin{align} …     an environment KaTeX draws (equation, align, alignat, gather, each
//   \end{align}         with or without `*`), as a paragraph of its own.
//
// Behind a setting of its own, the same delimiters with their backslashes doubled, as MultiMarkdown
// and Jupyter write them (`\\(a^2\\)`). The rule is in core/formulas.ts, which the plain reading of
// headings and notes follows too. Nodes as for dollar math (math.ts), an environment's
// `DisplayMath` holding only its `MathText`, `\begin` and `\end` included, since KaTeX draws them.

import type { InlineContext, InlineParser, MarkdownConfig } from '@lezer/markdown';
import { latexClosers, latexFormula } from '../../core/formulas';
import { CODE_BACKSLASH } from '../../core/markdownText';
import { formula, MATH_NODES } from './math';

/** The inline parser for the delimiters written with `slashes` backslashes. */
function latexParser(slashes: 1 | 2): InlineParser {
  /** Where each closing `\)` of a paragraph's text is, found once for the paragraph. */
  const closersByContext = new WeakMap<InlineContext, number[]>();
  const closersOf = (cx: InlineContext) => {
    let found = closersByContext.get(cx);
    if (!found) closersByContext.set(cx, (found = latexClosers(cx.text, slashes)));
    return found;
  };
  return {
    name: slashes === 1 ? 'LatexMath' : 'DoubledLatexMath',
    before: 'Escape',
    parse(cx, next, pos) {
      if (next !== CODE_BACKSLASH) return -1;
      const found = latexFormula(cx.text, pos - cx.offset, slashes, () => closersOf(cx));
      return found ? formula(cx, found.type, pos, cx.offset + found.to, found.mark) : -1;
    },
  };
}

export const LatexMath: MarkdownConfig = { defineNodes: MATH_NODES, parseInline: [latexParser(1)] };

export const DoubledLatexMath: MarkdownConfig = { defineNodes: MATH_NODES, parseInline: [latexParser(2)] };
