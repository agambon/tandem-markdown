// Tags, by Obsidian's rule (`tagNameLength` in core/markdownText.ts): `#` at the start of a
// line or after white space, then one or more tag characters, at least one of them not a digit.
// So `#1984` and `#5` stay text, while `#y1984`, `#area/sub` and the color code `#ff0000` are
// tags; letters in any script and emoji are tag characters. `\#text` is an escape, not a
// tag; `C#` and `page#part` are not tags.
//
// Nodes: `Tag` (the whole `#name`) holding `TagMark` (the `#`).

import { tags as styleTags } from '@lezer/highlight';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { CODE_HASH, MAX_TAG_LENGTH, tagMayFollow, tagNameLength } from '../../core/markdownText';

function parseTag(cx: InlineContext, next: number, pos: number): number {
  if (next !== CODE_HASH) return -1;
  if (pos > cx.offset && !tagMayFollow(cx.slice(pos - 1, pos))) return -1;
  const length = tagNameLength(cx.slice(pos, Math.min(cx.end, pos + 2 + MAX_TAG_LENGTH)), 1);
  if (length === 0) return -1;
  return cx.addElement(cx.elt('Tag', pos, pos + 1 + length, [cx.elt('TagMark', pos, pos + 1)]));
}

export const Tag: MarkdownConfig = {
  defineNodes: [
    { name: 'Tag', style: styleTags.labelName },
    { name: 'TagMark', style: styleTags.processingInstruction },
  ],
  parseInline: [{ name: 'Tag', parse: parseTag }],
};
