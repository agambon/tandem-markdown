// Picture sizes other programs write after a picture:
//
//   ![](pic.png){width="6.5in" height=4in}    Pandoc (from every Word picture), Quarto, GitLab
//   ![](pic.png){:height 452, :width 785}     Logseq
//   ![alt](pic.png =500x250)                  Azure DevOps, where CommonMark reads no picture
//
// A size after the alt text, `![alt|100x145](pic.png)` (Obsidian), needs no parser: the picture
// drawing reads it. Pandoc's braces are attributes as core/attributes.ts reads them. Nodes:
// `ImageAttributes` and `LogseqImageAttributes`, the braces, each right after an `Image`; for
// Azure's form an `Image` with its `LinkMark`s and `URL`, and `ImageSize` for ` =500x250`.

import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { attributesEnd, MAX_ATTRIBUTES, readAttributes } from '../../core/attributes';
import { CODE_OPEN_BRACE, CODE_OPEN_BRACKET, isSpaceOrTab } from '../../core/markdownText';
import { CODE_BANG } from './chars';

/** Azure's form longer than this is text: nothing a program writes comes near it, and the scan stays short. */
const MAX_SIZED_PICTURE = 2000;

/** Logseq's: `:height` and `:width` with a number each, comma between. */
const LOGSEQ = /^\{\s*:(?:height|width)\s+\d{1,5}(?:\s*,\s*:(?:height|width)\s+\d{1,5})?\s*\}/;

/** Azure's: alt text, an address with no space, then `=width x height`, either number left out. */
const AZURE = /^!\[([^[\]\n]*)\]\([ \t]*([^\s()<>]+)([ \t]+=(\d{1,5})?x(\d{1,5})?)[ \t]*\)/;

/**
 * Whether the inline content read so far ends in a picture that ends at `pos`. Lezer keeps
 * that content in `parts`, which its published typings leave out (@lezer/markdown 1.8).
 */
function pictureEndsAt(cx: InlineContext, pos: number): boolean {
  const parts = (cx as unknown as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;
  const last = parts[parts.length - 1] as { type?: unknown; to?: unknown } | null | undefined;
  if (!last || last.to !== pos || typeof last.type !== 'number') return false;
  return cx.parser.nodeSet.types[last.type]?.name === 'Image';
}

/** An extension naming braces right after a picture as `name`; `length` reads how long they are, 0 for none. */
function braces(name: string, length: (text: string) => number): MarkdownConfig {
  return {
    defineNodes: [{ name }],
    parseInline: [
      {
        name,
        parse(cx, next, pos) {
          if (next !== CODE_OPEN_BRACE || !pictureEndsAt(cx, pos)) return -1;
          const found = length(cx.slice(pos, Math.min(cx.end, pos + MAX_ATTRIBUTES)));
          return found > 0 ? cx.addElement(cx.elt(name, pos, pos + found)) : -1;
        },
      },
    ],
  };
}

/** Pandoc's braces after a picture (`pictureSizes`). */
export const PictureBraces: MarkdownConfig = braces('ImageAttributes', (text) => {
  const end = attributesEnd(text, 0);
  return end > 0 && readAttributes(text.slice(0, end)) ? end : 0;
});

/** Logseq's braces after a picture (`otherPictureSizes`). */
export const LogseqPictureBraces: MarkdownConfig = braces(
  'LogseqImageAttributes',
  (text) => LOGSEQ.exec(text)?.[0].length ?? 0,
);

/** Azure DevOps' size inside a picture's parentheses (`otherPictureSizes`). */
export const AzurePictureSize: MarkdownConfig = {
  defineNodes: [{ name: 'ImageSize' }],
  parseInline: [
    {
      name: 'AzurePictureSize',
      parse(cx, next, pos) {
        if (next !== CODE_BANG || cx.char(pos + 1) !== CODE_OPEN_BRACKET) return -1;
        const match = AZURE.exec(cx.slice(pos, Math.min(cx.end, pos + MAX_SIZED_PICTURE)));
        if (!match || (match[4] === undefined && match[5] === undefined)) return -1;
        const end = pos + match[0].length;
        const close = pos + 2 + match[1]!.length;
        let url = close + 2;
        while (isSpaceOrTab(cx.char(url))) url++;
        const urlTo = url + match[2]!.length;
        const sizeTo = urlTo + match[3]!.length;
        const sizeFrom = sizeTo - match[3]!.trimStart().length;
        return cx.addElement(
          cx.elt('Image', pos, end, [
            cx.elt('LinkMark', pos, pos + 2),
            cx.elt('LinkMark', close, close + 1),
            cx.elt('LinkMark', close + 1, close + 2),
            cx.elt('URL', url, urlTo),
            cx.elt('ImageSize', sizeFrom, sizeTo),
            cx.elt('LinkMark', end - 1, end),
          ]),
        );
      },
      before: 'Image',
    },
  ],
};
