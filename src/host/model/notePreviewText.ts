// What a link's hover card shows of the note it points to: the note's title and the start of
// its text, read as plain text (core/plainText.ts) block by block: a heading as the outline reads
// it (`headingContent`, its attributes in braces left out), a quote without its marks, a list
// item after its marker as written, code as typed, and what the page does not show (comments,
// link definitions, rules) left out. Emoji codes are their emoji when the caller passes
// GitHub's list (emojiNames.ts).

import type { SyntaxNode } from '@lezer/common';
import type { EmojiCodes } from '../../core/emojiCodes';
import { MARKDOWN_EXT } from '../../core/fileKinds';
import { findFrontmatterEnd } from '../../core/frontmatter';
import { blockParser, buildOutline, headingContent } from '../../core/outline';
import { plainText, type PlainTextOptions } from '../../core/plainText';
import { notePart } from './noteSection';

/** The most of a note the host reads for its preview. A larger file gets none. */
export const NOTE_PREVIEW_MAX_BYTES = 64 * 1024;
/** How much of the note the card shows. */
export const NOTE_PREVIEW_CHARS = 600;

const ATX_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** Blocks the page shows nothing of. */
const UNSHOWN = new Set(['CommentBlock', 'ProcessingInstructionBlock', 'LinkReference', 'HorizontalRule']);

/** The lines of a block's text after the first, without the quote marks and indent of what holds them. */
function blockLines(text: string, node: SyntaxNode): string {
  return text
    .slice(node.from, node.to)
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(/^[ \t>]*/, '')))
    .join('\n');
}

/** The blocks of `parent`, each as plain text. */
function plainBlocks(text: string, parent: SyntaxNode, options: EmojiCodes | PlainTextOptions | undefined): string[] {
  const plain = (source: string) => plainText(source, options);
  const out: string[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (!node.type.is('Block') || UNSHOWN.has(node.name)) continue;
    if (node.name === 'Blockquote') {
      out.push(...plainBlocks(text, node, options));
    } else if (node.name === 'BulletList' || node.name === 'OrderedList') {
      const items: string[] = [];
      for (let item = node.firstChild; item; item = item.nextSibling) {
        const mark = item.getChild('ListMark');
        if (item.name !== 'ListItem' || !mark) continue;
        items.push(`${text.slice(mark.from, mark.to)} ${plainBlocks(text, item, options).join(' ')}`.trimEnd());
      }
      out.push(items.join('\n'));
    } else if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      const code = node.getChild('CodeText');
      out.push(code ? text.slice(code.from, code.to) : '');
    } else if (node.name === 'Table') {
      const rows: string[] = [];
      for (let row = node.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        rows.push(
          row
            .getChildren('TableCell')
            .map((cell) => plain(text.slice(cell.from, cell.to)))
            .join(' | '),
        );
      }
      out.push(rows.join('\n'));
    } else if (/^(?:ATX|Setext)Heading/.test(node.name)) {
      // As the outline reads it: attributes after an ATX heading (`{#id}`) left out.
      out.push(plain(headingContent(text, node).content));
    } else if (node.name === 'Task') {
      const marker = node.getChild('TaskMarker');
      const from = marker?.to ?? node.from;
      out.push(`${marker ? text.slice(marker.from, marker.to) : ''} ${plain(text.slice(from, node.to))}`.trim());
    } else {
      out.push(plain(blockLines(text, node)));
    }
  }
  return out.filter((block) => block !== '');
}

/** `markdown` as plain text, block by block, its blocks a blank line apart. */
function plainBody(markdown: string, options: EmojiCodes | PlainTextOptions | undefined): string {
  return plainBlocks(markdown, blockParser.parse(markdown).topNode, options).join('\n\n');
}

/** The first NOTE_PREVIEW_CHARS characters of `text`, "…" ending a text that goes on. */
function startOf(text: string): string {
  const chars = Array.from(text);
  return chars.length > NOTE_PREVIEW_CHARS ? `${chars.slice(0, NOTE_PREVIEW_CHARS).join('').trimEnd()}…` : text;
}

/**
 * A note's title and the start of its text, from its LF text: the title is its first heading
 * (as the outline shows it), else the file name without its markdown extension; the text is the
 * first NOTE_PREVIEW_CHARS characters of what follows the front matter, read as plain text, with
 * the title's own line left out when the note starts with it. "…" ends a text that goes on. For
 * a link to a block (`block`, its id without the `^`), the text is the start of that block when
 * the note has it. With `options`, emoji, math, and wikilinks follow the note's settings.
 */
export function notePreviewOf(
  lf: string,
  fileName: string,
  block?: string,
  options?: EmojiCodes | PlainTextOptions,
): { title: string; text: string } {
  const end = findFrontmatterEnd(lf);
  const bodyFrom = end < 0 ? 0 : end;
  const first = buildOutline(lf, options)[0];
  let title = fileName.replace(MARKDOWN_EXT, '');
  if (first && first.text) title = first.text;
  if (block) {
    const part = notePart(lf, `^${block}`);
    if ('text' in part) return { title, text: startOf(plainBody(part.text, options)) };
  }
  let body = lf.slice(bodyFrom).replace(/^\s*\n/, '');
  const firstLineEnd = body.indexOf('\n');
  const firstLine = firstLineEnd < 0 ? body : body.slice(0, firstLineEnd);
  // The note starts with its title: the card shows it once.
  if (first && ATX_LINE.test(firstLine) && lf.indexOf(firstLine, bodyFrom) === first.from) {
    body = (firstLineEnd < 0 ? '' : body.slice(firstLineEnd + 1)).replace(/^\s*\n/, '');
  }
  return { title, text: startOf(plainBody(body, options)) };
}
