// Names of syntax nodes that several features treat alike, and the tests for a heading's kind and
// level. A feature that needs more builds its own set from these where it is used:
// `new Set([...NO_INLINE, 'Table'])`.

import type { SyntaxNode } from '@lezer/common';

/** Blocks whose lines are their text: nothing inside them is read as markdown. */
export const RAW_BLOCKS: ReadonlySet<string> = new Set([
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'PercentCommentBlock',
  'ConflictBlock',
  'DisplayMathBlock',
]);

export const OPAQUE_BLOCKS: ReadonlySet<string> = new Set([...RAW_BLOCKS, 'Frontmatter']);

/** Blocks with no inline markdown content. */
export const NO_INLINE: ReadonlySet<string> = new Set([...OPAQUE_BLOCKS, 'LinkReference']);

/** Inline spans whose text is code or math, not markdown. */
export const CODE_SPANS: ReadonlySet<string> = new Set(['InlineCode', 'InlineMath', 'DisplayMath']);

/** Blocks drawn as one level of quote: a quote, and a box (`:::`, `!!!`), which takes a quote's bar. */
export const QUOTE_LEVELS: ReadonlySet<string> = new Set(['Blockquote', 'Box']);

const ATX_HEADINGS: ReadonlySet<string> = new Set([1, 2, 3, 4, 5, 6].map((level) => `ATXHeading${level}`));

const SETEXT_HEADINGS: ReadonlySet<string> = new Set(['SetextHeading1', 'SetextHeading2']);

export function isAtxHeading(name: string): boolean {
  return ATX_HEADINGS.has(name);
}

export function isSetextHeading(name: string): boolean {
  return SETEXT_HEADINGS.has(name);
}

/** Returns heading level 1 to 6, or 0 for non-heading nodes. */
export function headingLevel(name: string): number {
  return isAtxHeading(name) || isSetextHeading(name) ? Number(name[name.length - 1]) : 0;
}

export const LINK_NODES: ReadonlySet<string> = new Set(['Link', 'Image', 'Autolink', 'URL', 'Wikilink', 'Embed']);

export const FOOTNOTE_LINKS: ReadonlySet<string> = new Set(['FootnoteRef', 'InlineFootnote', 'FootnoteLabel']);

/** Inline nodes that show their own marks: with the cursor inside one, only that one reveals. */
const REVEALS_OWN: ReadonlySet<string> = new Set([
  'Emphasis',
  'StrongEmphasis',
  'Strikethrough',
  'Highlight',
  'Subscript',
  'Superscript',
  'InlineCode',
  'Link',
  'Image',
  'Wikilink',
  'Embed',
  'FootnoteRef',
  'InlineFootnote',
  'Escape',
  'Entity',
  'Autolink',
  'Tag',
  'EmojiCode',
  'InlineMath',
  'DisplayMath',
  'Span',
  'CriticAddition',
  'CriticDeletion',
  'CriticSubstitution',
  'CriticHighlight',
  'CriticComment',
]);

/**
 * The children of `node` between `from` and `to` (all of them unless given) that show their own
 * marks: what a reveal question takes as `inner`.
 */
export function selfRevealingChildren(
  node: SyntaxNode,
  from = node.from,
  to = node.to,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.from >= from && c.to <= to && REVEALS_OWN.has(c.name)) out.push({ from: c.from, to: c.to });
  }
  return out;
}

/** Whether an inline node stands in a table cell, where `\|` is a pipe wherever it stands (GFM). */
export function inTableCell(node: SyntaxNode): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (n.name === 'TableCell') return true;
    if (n.type.is('Block')) return false;
  }
  return false;
}
