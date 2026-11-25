// Highlight: `==text==`, with the same flanking rules as GFM strikethrough (`~~text~~`).
//
// A mark is a run of exactly two `=`, as a strike is a run of two `~` on GitHub, and never one
// with a `+` beside it, so a grid table's `+===+===+` row stays text; nor one that opens after a
// `{` or closes before a `}`, which are tracked-change marks (`{==text==}`).
//
// Nodes: `Highlight` (the whole span) holding two `HighlightMark` children (the `==`).
//
// The parser is copied from @lezer/markdown 1.8.1's Strikethrough extension (MIT) with `=` in
// place of `~`, and the two guards above added; its flanking test is flanking.ts's. @lezer/markdown's
// notice:
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
import type { MarkdownConfig } from '@lezer/markdown';
import { CODE_CLOSE_BRACE, CODE_EQUALS, CODE_OPEN_BRACE, CODE_PLUS } from '../../core/markdownText';
import { flanking } from './flanking';

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== CODE_EQUALS || cx.char(pos + 1) !== CODE_EQUALS) return -1;
        const prev = cx.char(pos - 1);
        const following = cx.char(pos + 2);
        if (prev === CODE_EQUALS || following === CODE_EQUALS || prev === CODE_PLUS || following === CODE_PLUS)
          return -1;
        const { open, close } = flanking(cx, pos, pos + 2);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          prev !== CODE_OPEN_BRACE && open,
          following !== CODE_CLOSE_BRACE && close,
        );
      },
      after: 'Emphasis',
    },
  ],
};
