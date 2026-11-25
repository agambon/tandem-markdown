// GFM's flanking rule for a run of delimiter marks: whether it may open a span (left-flanking)
// and whether it may close one (right-flanking). Highlight (highlight.ts) and the one-tilde
// strike (tilde.ts) read their runs with it.
//
// The test is the one in @lezer/markdown 1.8.1's Strikethrough extension (MIT), taken whole.
// @lezer/markdown's notice:
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

import type { InlineContext } from '@lezer/markdown';

const punctuation = /[\p{S}\p{P}]/u;

/** Whether the run of marks at [from, to) in `cx` may open a span (`open`) and may close one (`close`). */
export function flanking(cx: InlineContext, from: number, to: number): { open: boolean; close: boolean } {
  const before = cx.slice(from - 1, from);
  const after = cx.slice(to, to + 1);
  const sBefore = /\s|^$/.test(before);
  const sAfter = /\s|^$/.test(after);
  const pBefore = punctuation.test(before);
  const pAfter = punctuation.test(after);
  return {
    open: !sAfter && (!pAfter || sBefore || pBefore),
    close: !sBefore && (!pBefore || sAfter || pAfter),
  };
}
