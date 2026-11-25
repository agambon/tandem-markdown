// Emoji codes: `:name:`, found by the rule in core/emojiCodes.ts, which the plain reading of
// headings and notes follows too. The parser names every such shape; only names on GitHub's
// list are drawn (render/emoji.ts), so `12:30:45` and `:not_a_name:` stay text.
//
// Nodes: `EmojiCode` (the whole `:name:`) holding two `EmojiMark` (the colons).

import { tags } from '@lezer/highlight';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { emojiCodeEnd } from '../../core/emojiCodes';

function parseEmoji(cx: InlineContext, _next: number, pos: number): number {
  const end = emojiCodeEnd(cx.text, pos - cx.offset);
  if (end < 0) return -1;
  const to = cx.offset + end;
  return cx.addElement(
    cx.elt('EmojiCode', pos, to, [cx.elt('EmojiMark', pos, pos + 1), cx.elt('EmojiMark', to - 1, to)]),
  );
}

export const Emoji: MarkdownConfig = {
  defineNodes: [
    // No highlight style: a shape that is not drawn (a time, a name off the list) must look like
    // the text around it.
    { name: 'EmojiCode' },
    { name: 'EmojiMark', style: tags.processingInstruction },
  ],
  parseInline: [{ name: 'EmojiCode', parse: parseEmoji }],
};
