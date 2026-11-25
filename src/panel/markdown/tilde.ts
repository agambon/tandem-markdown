// One tilde, and the caret: GitHub strikes `~text~` through; Pandoc, Quarto, Typora and Joplin
// read `H~2~O` and `x^2^` as subscript and superscript. The setting `tilde` chooses a reading
// (src/panel/syntax/inline.ts): GitHub's alone (`OneTildeStrike`, its runs read with
// flanking.ts's test in `githubTilde`); both (`TildeAndCaret`: a pair `pairAt` accepts is
// subscript or superscript, any other single tilde GitHub's); or Pandoc's alone, @lezer/markdown's
// `Subscript` and `Superscript`. docs/ARCHITECTURE.md, "One tilde", gives each rule in full.
//
// Nodes: GFM's `Strikethrough` holding two `StrikethroughMark`; `Subscript` and `Superscript`,
// each holding its two marks and an `Escape` for each escaped character inside.
//
// The subscript and superscript nodes are defined as @lezer/markdown 1.8.1's
// `Subscript` and `Superscript` (MIT) define them. @lezer/markdown's notice:
//
//   Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { tags } from '@lezer/highlight';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { CODE_BACKSLASH, CODE_BACKTICK } from '../../core/markdownText';
import { CODE_CARET, CODE_TILDE } from './chars';
import { flanking } from './flanking';

/** The shortest run of tildes that is always text. */
const MIN_TEXT_RUN = 3;
const OneTildeDelim = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
/** What a subscript or superscript follows straight on: a letter, a digit or a closing bracket. */
const ATTACHED = /^[\p{L}\p{M}\p{N})\]}]$/u;
/** What a backslash escapes inside a pair: CommonMark's ASCII punctuation, and a space, as Pandoc allows. */
const ESCAPABLE = /^[!-/:-@[-`{-~ ]$/;
const WHITESPACE = /^\s$/;

/** Whether the character at `pos` is `mark` on its own, not part of a longer run of it. */
function single(cx: InlineContext, pos: number, mark: number): boolean {
  return cx.char(pos) === mark && cx.char(pos - 1) !== mark && cx.char(pos + 1) !== mark;
}

/** GitHub's one-tilde delimiter at `pos`: it may open a strike when left-flanking, close one when right-flanking. */
function githubTilde(cx: InlineContext, pos: number): number {
  const { open, close } = flanking(cx, pos, pos + 1);
  return cx.addDelimiter(OneTildeDelim, pos, pos + 1, open, close);
}

/**
 * The subscript or superscript a single `mark` at `pos` opens, added to `cx`, and where it ends;
 * -1 when there is none. The mark must follow a letter, a digit or `)`, `]` or `}` straight on,
 * and the next single `mark` closes it, with one or more characters between and no white space
 * (unless escaped), line break or backtick among them, so a pair never reaches into code.
 */
function pairAt(cx: InlineContext, pos: number, mark: number, node: string, markNode: string): number {
  if (!single(cx, pos, mark) || !ATTACHED.test(cx.slice(pos - 1, pos))) return -1;
  const inside = [cx.elt(markNode, pos, pos + 1)];
  for (let i = pos + 1; i < cx.end; i++) {
    const next = cx.char(i);
    if (next === mark) {
      if (i === pos + 1 || cx.char(i + 1) === mark) return -1;
      return cx.addElement(cx.elt(node, pos, i + 1, [...inside, cx.elt(markNode, i, i + 1)]));
    }
    if (next === CODE_BACKSLASH && ESCAPABLE.test(cx.slice(i + 1, i + 2))) {
      inside.push(cx.elt('Escape', i, i + 2));
      i++;
    } else if (next === CODE_BACKTICK || WHITESPACE.test(cx.slice(i, i + 1))) {
      return -1;
    }
  }
  return -1;
}

/**
 * A run of three or more tildes in a line, taken whole as text: GFM never strikes with one
 * (its spec's example 493, `This will ~~~not~~~ strike.`), but @lezer/markdown 1.8's
 * Strikethrough reads a `~~` from inside such a run. Always on, beside GFM.
 */
export const TildeRuns: MarkdownConfig = {
  parseInline: [
    {
      name: 'TildeRun',
      parse(cx, next, pos) {
        if (next !== CODE_TILDE || cx.char(pos - 1) === CODE_TILDE) return -1;
        let end = pos;
        while (cx.char(end) === CODE_TILDE) end++;
        return end - pos >= MIN_TEXT_RUN ? end : -1;
      },
      before: 'Strikethrough',
    },
  ],
};

export const OneTildeStrike: MarkdownConfig = {
  parseInline: [
    {
      name: 'OneTildeStrike',
      parse: (cx, next, pos) => (next === CODE_TILDE && single(cx, pos, CODE_TILDE) ? githubTilde(cx, pos) : -1),
      after: 'Strikethrough',
    },
  ],
};

export const TildeAndCaret: MarkdownConfig = {
  defineNodes: [
    { name: 'Subscript', style: tags.special(tags.content) },
    { name: 'SubscriptMark', style: tags.processingInstruction },
    { name: 'Superscript', style: tags.special(tags.content) },
    { name: 'SuperscriptMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'TildePair',
      parse(cx, next, pos) {
        if (next !== CODE_TILDE || !single(cx, pos, CODE_TILDE)) return -1;
        const pair = pairAt(cx, pos, CODE_TILDE, 'Subscript', 'SubscriptMark');
        return pair >= 0 ? pair : githubTilde(cx, pos);
      },
      after: 'Strikethrough',
    },
    {
      name: 'CaretPair',
      parse: (cx, next, pos) =>
        next === CODE_CARET ? pairAt(cx, pos, CODE_CARET, 'Superscript', 'SuperscriptMark') : -1,
    },
  ],
};
