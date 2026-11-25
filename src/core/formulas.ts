// Math in a paragraph's text: where a formula opens and ends, by the rules the page draws math
// by, for the page's parsers (panel/markdown/math.ts, latexMath.ts) and the plain reading
// (plainText.ts). Dollars by Pandoc's rule (dollarFormula), and LaTeX's own delimiters
// (latexFormula); `\$` is a dollar, inside math and out. Nothing inside a formula is markdown:
// the page takes a formula where it opens, ahead of a code span or an escape there.

import {
  CODE_BACKSLASH,
  CODE_BACKTICK,
  CODE_CR,
  CODE_DOLLAR,
  CODE_LF,
  CODE_LOWER_B,
  CODE_OPEN_BRACKET,
  CODE_OPEN_PAREN,
  CODE_SPACE,
  CODE_TAB,
  isAsciiDigit,
} from './markdownText';
import { firstFrom } from './textLines';

/** The longest formula read in GitHub's backtick form, so an unclosed one is not scanned to the end each time. */
const MAX_BACKTICK_FORM = 4000;

const ENVIRONMENT = /\\begin\{((?:equation|align|alignat|gather)\*?)\}/y;

/** A formula found in a paragraph's text. */
export interface Formula {
  readonly type: 'InlineMath' | 'DisplayMath';
  /** Just past its closing mark, as an offset into the text. */
  readonly to: number;
  /** The length of its opening mark, and of its closing one; 0 for an environment, which has none. */
  readonly mark: number;
}

function isSpace(code: number): boolean {
  return code === CODE_SPACE || code === CODE_TAB || code === CODE_LF || code === CODE_CR;
}

/**
 * Where a dollar formula may close in one paragraph's text, found in one pass so that a
 * paragraph of many prices is not scanned again from each of them. Offsets into the text.
 */
export interface DollarClosers {
  /** `$` not escaped, after a non-space, before a non-digit. */
  single: number[];
  /** `$$` not escaped. */
  double: number[];
}

export function dollarClosers(text: string): DollarClosers {
  const found: DollarClosers = { single: [], double: [] };
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (code === CODE_BACKSLASH) {
      escaped = true;
      continue;
    }
    if (code !== CODE_DOLLAR) continue;
    if (text.charCodeAt(i + 1) === CODE_DOLLAR) {
      found.double.push(i);
      i++;
      continue;
    }
    if (i > 0 && !isSpace(text.charCodeAt(i - 1)) && !isAsciiDigit(text.charCodeAt(i + 1))) found.single.push(i);
  }
  return found;
}

/** `$` then a code span of `run` backticks then `$`, as GitHub writes inline math: where it ends, or -1. */
function backtickFormEnd(text: string, at: number, run: number): number {
  const start = at + 1 + run;
  const end = Math.min(text.length, start + MAX_BACKTICK_FORM);
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) !== CODE_BACKTICK) continue;
    let close = 0;
    while (text.charCodeAt(i + close) === CODE_BACKTICK) close++;
    if (close === run) return i > start && text.charCodeAt(i + close) === CODE_DOLLAR ? i + close + 1 : -1;
    i += close - 1;
  }
  return -1;
}

/**
 * The dollar formula that opens at `at` in `text`, a paragraph's text, or null. `closers` gives
 * the text's `dollarClosers`, asked for only when a formula may close at one of them.
 *
 * Pandoc's rule, which the VS Code preview, GitLab and Typora share, so prices stay text:
 *
 *   $a^2$        the opening `$` has a non-space after it; the closing `$` has a non-space
 *                before it and no digit after it. `$5 and $10` is text.
 *   $$x$$        display math, with any spacing inside.
 *   $`\sqrt3`$   GitHub's form: a code span between two dollars.
 */
export function dollarFormula(text: string, at: number, closers: () => DollarClosers): Formula | null {
  if (text.charCodeAt(at) !== CODE_DOLLAR) return null;
  const after = text.charCodeAt(at + 1);
  if (after === CODE_BACKTICK) {
    let run = 0;
    while (text.charCodeAt(at + 1 + run) === CODE_BACKTICK) run++;
    const to = backtickFormEnd(text, at, run);
    return to < 0 ? null : { type: 'InlineMath', to, mark: run + 1 };
  }
  if (after === CODE_DOLLAR) {
    const close = firstFrom(closers().double, at + 3);
    return close < 0 ? null : { type: 'DisplayMath', to: close + 2, mark: 2 };
  }
  if (Number.isNaN(after) || isSpace(after)) return null;
  const close = firstFrom(closers().single, at + 2);
  return close < 0 ? null : { type: 'InlineMath', to: close + 1, mark: 1 };
}

/** Where each closing `\)` written with `slashes` backslashes stands in a paragraph's text, found in one pass. */
export function latexClosers(text: string, slashes: 1 | 2): number[] {
  const close = `${'\\'.repeat(slashes)})`;
  const found: number[] = [];
  for (let i = text.indexOf(close); i >= 0; i = text.indexOf(close, i + close.length)) found.push(i);
  return found;
}

/**
 * The formula in LaTeX's delimiters, written with `slashes` backslashes, that opens at `at` in
 * `text`, or null. The paragraph's text starts at `start` in `text` (0 when `text` is just that),
 * and display math and environments open only there. `closers` gives the text's
 * `latexClosers`, asked for only for a formula in a line.
 *
 * Chat assistants, Jupyter and MathJax pages write the delimiters with one backslash;
 * MultiMarkdown and Jupyter also write them doubled (`\\(a^2\\)`):
 *
 *   \(a^2\)             in a line, anywhere, to the first closing `\)` in the paragraph.
 *   \[ E = mc^2 \]      display math, only as the whole of the paragraph's text.
 *   \begin{align} …     an environment KaTeX draws (equation, align, alignat, gather, each
 *   \end{align}         with or without `*`), as the whole of the paragraph's text, with single
 *                       backslashes only. Its `\begin` and `\end` are part of its text.
 */
export function latexFormula(
  text: string,
  at: number,
  slashes: 1 | 2,
  closers: () => number[],
  start = 0,
): Formula | null {
  if (text.charCodeAt(at) !== CODE_BACKSLASH || (slashes === 2 && text.charCodeAt(at + 1) !== CODE_BACKSLASH))
    return null;
  const size = slashes + 1;
  const after = text.charCodeAt(at + slashes);
  if (after === CODE_OPEN_PAREN) {
    const close = firstFrom(closers(), at + size + 1);
    return close < 0 ? null : { type: 'InlineMath', to: close + size, mark: size };
  }
  // The rest stand for the whole paragraph.
  if (at !== start) return null;
  const end = text.trimEnd().length;
  if (after === CODE_OPEN_BRACKET) {
    const closeDisplay = `${'\\'.repeat(slashes)}]`;
    return text.indexOf(closeDisplay, at + size + 1) === end - size
      ? { type: 'DisplayMath', to: end, mark: size }
      : null;
  }
  if (after === CODE_LOWER_B && slashes === 1) {
    ENVIRONMENT.lastIndex = at;
    const name = ENVIRONMENT.exec(text)?.[1];
    if (!name || !text.slice(0, end).endsWith(`\\end{${name}}`)) return null;
    return { type: 'DisplayMath', to: end, mark: 0 };
  }
  return null;
}
