// The document's headings, for the outline and for jumping to a heading: the ones the panel draws,
// found by the panel's own parser (@lezer/markdown with GFM), so never inside code or HTML blocks,
// and never in the front matter, which is blanked out first. The text is what a reader sees
// (plainText.ts), less attributes in braces after an ATX heading (attributes.ts), whose `#id` is the
// heading's id, with emoji codes as emoji when given GitHub's list; the anchor is made from
// `anchorText`, which keeps codes as typed.

import type { PartialParse, SyntaxNode, Tree, TreeFragment } from '@lezer/common';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import { headingAttributes, readAttributes } from './attributes';
import type { EmojiCodes } from './emojiCodes';
import { findFrontmatterEnd } from './frontmatter';
import { anchorText, plainText, type PlainTextOptions } from './plainText';

/** What a heading says: its level and its text. */
type HeadingText = Pick<OutlineItem, 'level' | 'text'>;

export interface OutlineItem {
  level: number;
  text: string;
  /** The id the heading's attributes give it (`{#intro}`), when they give one. */
  id?: string;
  /** The text the heading's anchor is made from (`anchorText`), when it is not `text`. */
  anchorText?: string;
  /** Zero-based line of the heading (of its first line, for a Setext heading). */
  line: number;
  /** Offset where that line starts. */
  from: number;
}

/**
 * The parser of block structure only: inline syntax never decides where a block is (CommonMark
 * parses blocks first), and leaving it out halves the parse, to about 150 ms a megabyte.
 */
export const blockParser = markdownParser.configure([
  GFM,
  {
    remove: [
      'Escape',
      'Entity',
      'InlineCode',
      'HTMLTag',
      'Emphasis',
      'HardBreak',
      'Link',
      'Image',
      'LinkEnd',
      'Strikethrough',
      'Autolink',
    ],
  },
]);

const HEADING = /^(?:ATXHeading([1-6])|SetextHeading([12]))$/;
/** Nodes a heading can sit inside. The walk does not go into anything else. */
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/** True when both lists hold the same headings (level and text) in the same order, wherever they are. */
export function sameHeadings(a: readonly HeadingText[], b: readonly HeadingText[]): boolean {
  return a.length === b.length && a.every((x, i) => x.level === b[i]!.level && x.text === b[i]!.text);
}

/** The headings of `text`; with `options`, emoji, math, and wikilinks follow those settings. */
export function buildOutline(text: string, options?: EmojiCodes | PlainTextOptions): OutlineItem[] {
  return outlineOf(blockParser.parse(withoutFrontmatter(text)), text, options);
}

/**
 * A parse of `text` for its outline that can be advanced a step at a time, reusing the
 * `fragments` of an earlier parse; `outlineOf` reads the tree it ends with.
 */
export function startOutlineParse(text: string, fragments: readonly TreeFragment[]): PartialParse {
  return blockParser.startParse(withoutFrontmatter(text), fragments);
}

/**
 * The headings of `tree`, a parse of `text` with @lezer/markdown's block nodes, as
 * `buildOutline` gives them.
 */
export function outlineOf(tree: Tree, text: string, options?: EmojiCodes | PlainTextOptions): OutlineItem[] {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const items: OutlineItem[] = [];
  tree.iterate({
    enter(ref) {
      const m = HEADING.exec(ref.name);
      if (!m) return CONTAINERS.has(ref.name);
      const node = ref.node;
      const line = lineAt(node.from);
      const level = m[1] ? Number(m[1]) : Number(m[2]);
      const { content, id } = headingContent(text, node);
      const item: OutlineItem = { level, text: plainText(content, options), line, from: lineStarts[line]! };
      const anchor = anchorText(content);
      if (anchor !== item.text) item.anchorText = anchor;
      if (id) item.id = id;
      items.push(item);
      return false;
    },
  });
  return items;
}

/** The text with a front matter block's characters turned to spaces (line breaks kept), so offsets stay put. */
function withoutFrontmatter(text: string): string {
  const end = findFrontmatterEnd(text);
  return end < 0 ? text : text.slice(0, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

/**
 * The text of `node`, an ATX or Setext heading, as markdown, with the id its attributes give it:
 * what the outline and a note's card (host/model/notePreviewText.ts) read a heading's label from.
 */
export function headingContent(text: string, node: SyntaxNode): { content: string; id: string | null } {
  return node.name.startsWith('ATX') ? atxContent(text, node) : { content: setextContent(text, node), id: null };
}

/**
 * An ATX heading's text: between the opening hashes and the closing ones, if any, less the
 * attributes that end it and the closing hashes before them; with the id they give.
 */
function atxContent(text: string, node: SyntaxNode): { content: string; id: string | null } {
  const marks = node.getChildren('HeaderMark');
  const start = marks.length > 0 ? marks[0]!.to : node.from;
  const end = marks.length > 1 ? marks[marks.length - 1]!.from : node.to;
  if (start >= end) return { content: '', id: null };
  const attributes = headingAttributes(text, start, end);
  if (!attributes) return { content: text.slice(start, end), id: null };
  const { braces } = attributes;
  return {
    content: text.slice(start, attributes.textTo),
    id: readAttributes(text.slice(braces.from, braces.to))?.id ?? null,
  };
}

/**
 * A Setext heading's text: its lines above the underline, joined by spaces. A line after
 * the first starts with the quote markers or indent of the container it sits in; those go.
 */
function setextContent(text: string, node: SyntaxNode): string {
  const underline = node.getChild('HeaderMark');
  const body = text.slice(node.from, underline ? underline.from : node.to);
  return body
    .split('\n')
    .map((l, i) => (i === 0 ? l : l.replace(/^[ \t>]*/, '')).trim())
    .filter((l) => l !== '')
    .join(' ');
}
