// Math written with dollars, by Pandoc's rule (which the VS Code preview, GitLab and Typora
// share), so prices stay text: `$a^2$` in a line, `$$x$$` display math, and GitHub's
// `` $`\sqrt3`$ ``. The rule is in core/formulas.ts, which the plain reading of headings and
// notes follows too. On lines of its own, `$$x$$` is a block (render/math.ts), since Pandoc
// reads display math as part of a paragraph. A paragraph's blank line ends any search. The
// ```` ```math ```` fence is a code block here; the drawing reads it. The nodes are in
// docs/ARCHITECTURE.md, "Our syntax nodes".

import type { Input } from '@lezer/common';
import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';
import { dollarClosers, dollarFormula, type DollarClosers } from '../../core/formulas';
import { CODE_DOLLAR } from '../../core/markdownText';
import { parseInput } from './blockContext';
import { indentedAsCode } from './chars';

/** Maximum distance scanned ahead for a closing `$$` fence when a `$$` block holds blank lines. */
export const MAX_MATH_BLOCK_SCAN = 16_384;

const MATH_FENCE_LINE = /^ {0,3}\$\$[ \t]*$/;
const CODE_FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;

const closersByContext = new WeakMap<InlineContext, DollarClosers>();

/** Where a formula may close in the paragraph `cx` reads, found once for the paragraph. */
function closersOf(cx: InlineContext): DollarClosers {
  let found = closersByContext.get(cx);
  if (!found) closersByContext.set(cx, (found = dollarClosers(cx.text)));
  return found;
}

/** The nodes `formula` builds, defined by every parser of math here (latexMath.ts too). */
export const MATH_NODES = ['InlineMath', 'DisplayMath', 'MathMark', 'MathText'];

function countQuotePrefixes(prefix: string): number {
  let count = 0;
  let rest = prefix;
  for (;;) {
    const next = rest.replace(/^ {0,3}> ?/, '');
    if (next === rest) break;
    count++;
    rest = next;
  }
  return count;
}

function stripQuotePrefixes(line: string, quotes: number): { text: string; offset: number } | null {
  let offset = 0;
  for (let q = 0; q < quotes; q++) {
    const m = /^ {0,3}> ?/.exec(line.slice(offset));
    if (!m) return null;
    offset += m[0].length;
  }
  return { text: line.slice(offset), offset };
}

interface MathBlockMatch {
  closeLineStart: number;
  closeLineEnd: number;
  markStart: number;
  markEnd: number;
}

/**
 * Looks ahead from an opening `$$` line for a closing `$$` line with at least one blank line
 * between them. Single-paragraph `$$...$$` blocks (with no blank line) return null so the
 * inline `DollarMath` parser handles them as before.
 */
function findBlankLineMathBlock(
  input: Input,
  lineStart: number,
  firstLineLen: number,
  quotes: number,
): MathBlockMatch | null {
  const afterOpen = lineStart + firstLineLen + 1;
  if (afterOpen >= input.length) return null;
  const limit = Math.min(input.length, afterOpen + MAX_MATH_BLOCK_SCAN);
  const chunk = input.read(afterOpen, limit);
  let offset = 0;
  let sawBlank = false;

  while (offset <= chunk.length) {
    const nl = chunk.indexOf('\n', offset);
    const end = nl < 0 ? chunk.length : nl;
    const rawLine = chunk.slice(offset, end);
    const stripped = stripQuotePrefixes(rawLine, quotes);
    if (!stripped) return null;
    const trimmed = stripped.text;
    if (trimmed.trim() === '') {
      sawBlank = true;
    } else if (MATH_FENCE_LINE.test(trimmed)) {
      if (!sawBlank) return null;
      const markRel = stripped.offset + trimmed.indexOf('$$');
      const closeLineStart = afterOpen + offset;
      return {
        closeLineStart,
        closeLineEnd: afterOpen + end,
        markStart: closeLineStart + markRel,
        markEnd: closeLineStart + markRel + 2,
      };
    } else if (CODE_FENCE_LINE.test(trimmed)) {
      return null;
    }
    if (nl < 0) break;
    offset = nl + 1;
  }
  return null;
}

function opensMathBlock(cx: BlockContext, line: Line): MathBlockMatch | null {
  if (indentedAsCode(line) || line.next !== CODE_DOLLAR) return null;
  if (!MATH_FENCE_LINE.test(line.text.slice(line.pos))) return null;
  const input = parseInput(cx);
  if (!input) return null;
  const quotes = countQuotePrefixes(line.text.slice(0, line.pos));
  return findBlankLineMathBlock(input, cx.lineStart, line.text.length, quotes);
}

function parseMathBlock(cx: BlockContext, line: Line): boolean {
  const match = opensMathBlock(cx, line);
  if (!match) return false;
  const openFrom = cx.lineStart + line.pos;
  const openTo = openFrom + 2;
  while (cx.lineStart < match.closeLineStart) {
    if (!cx.nextLine()) break;
  }
  cx.nextLine();
  cx.addElement(
    cx.elt('DisplayMathBlock', openFrom, match.closeLineEnd, [
      cx.elt('MathMark', openFrom, openTo),
      cx.elt('MathText', openTo, match.markStart),
      cx.elt('MathMark', match.markStart, match.markEnd),
    ]),
  );
  return true;
}

/**
 * Adds a formula node of `type` over [from, to]: `mark` characters at each end are its marks
 * and the rest its text. With no marks (a LaTeX environment, `\begin` to `\end`), it is all text.
 */
export function formula(cx: InlineContext, type: string, from: number, to: number, mark: number): number {
  const children = mark
    ? [
        cx.elt('MathMark', from, from + mark),
        cx.elt('MathText', from + mark, to - mark),
        cx.elt('MathMark', to - mark, to),
      ]
    : [cx.elt('MathText', from, to)];
  return cx.addElement(cx.elt(type, from, to, children));
}

function parseDollarMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_DOLLAR) return -1;
  const found = dollarFormula(cx.text, pos - cx.offset, () => closersOf(cx));
  return found ? formula(cx, found.type, pos, cx.offset + found.to, found.mark) : -1;
}

export const DollarMath: MarkdownConfig = {
  // No highlight style: a formula shown as typed (over two lines, or too long to draw in a
  // line) looks like the text around it, as a price would.
  defineNodes: [...MATH_NODES, { name: 'DisplayMathBlock', block: true }],
  parseBlock: [
    {
      name: 'DisplayMathBlock',
      parse: parseMathBlock,
      endLeaf: (cx, line) => opensMathBlock(cx, line) !== null,
      before: 'FencedCode',
    },
  ],
  parseInline: [{ name: 'DollarMath', parse: parseDollarMath, before: 'InlineCode' }],
};
