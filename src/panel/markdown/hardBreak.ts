// Hard line breaks (two or more spaces, or a backslash, before a line break), in place of
// @lezer/markdown 1.8.1's own `HardBreak` inline parser and giving the same tree.
//
// The parser is tried at every position of a paragraph. Lezer's version, at a space, looks
// along the whole run of spaces from there to see whether a line break ends it, so a run of
// n spaces costs n squared steps: a line of 40,000 spaces takes seconds to parse. This one
// looks only from a run's first space. From any later space of the same run the answer is
// the same, and it can only be "no": had the run ended in a line break, the break found from
// its first space would have taken the whole run, and nothing else in a paragraph ends
// partway along a run of spaces.
//
// `LinearHardBreak` is @lezer/markdown 1.8.1's `HardBreak` inline parser (MIT) with that one
// guard added. @lezer/markdown's notice:
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

import type { MarkdownConfig } from '@lezer/markdown';
import { CODE_BACKSLASH, CODE_LF, CODE_SPACE } from '../../core/markdownText';

export const LinearHardBreak: MarkdownConfig = {
  parseInline: [
    {
      // The same name replaces lezer's parser where it stood in the order.
      name: 'HardBreak',
      parse(cx, next, start) {
        if (next === CODE_BACKSLASH && cx.char(start + 1) === CODE_LF)
          return cx.addElement(cx.elt('HardBreak', start, start + 2));
        if (next !== CODE_SPACE || cx.char(start - 1) === CODE_SPACE) return -1;
        let pos = start + 1;
        while (cx.char(pos) === CODE_SPACE) pos++;
        if (cx.char(pos) === CODE_LF && pos >= start + 2) return cx.addElement(cx.elt('HardBreak', start, pos + 1));
        return -1;
      },
    },
  ],
};
