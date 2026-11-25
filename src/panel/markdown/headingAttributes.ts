// Attributes after a heading, as Pandoc, kramdown, Python-Markdown, Hugo and Google Docs'
// export write them: `## Title {#id .class}`, `## Preface {-}`. The braces end an ATX
// heading's line and hold at least one attribute (core/attributes.ts); the heading's text is
// what stands before them, a closing run of hashes dropped as CommonMark drops one. Braces
// after a Setext heading's text, or after anything else, stay text.
//
// Nodes: the ATX heading as CommonMark gives it, with an `Attributes` child for the braces.

import type { Element, MarkdownConfig } from '@lezer/markdown';
import { headingAttributes } from '../../core/attributes';
import { CODE_HASH, isSpaceOrTab } from '../../core/markdownText';

const MAX_LEVEL = 6;

export const HeadingAttributes: MarkdownConfig = {
  defineNodes: ['Attributes'],
  parseBlock: [
    {
      name: 'HeadingAttributes',
      parse(cx, line) {
        if (line.next !== CODE_HASH) return false;
        const text = line.text;
        const off = line.pos;
        let level = 1;
        while (text.charCodeAt(off + level) === CODE_HASH) level++;
        if (level > MAX_LEVEL || (off + level < text.length && !isSpaceOrTab(text.charCodeAt(off + level))))
          return false;
        const attributes = headingAttributes(text, off + level);
        if (!attributes) return false;
        const { closing, braces } = attributes;
        const contentFrom = Math.min(off + level + 1, braces.from);
        const at = cx.lineStart;
        const children: Element[] = [cx.elt('HeaderMark', at + off, at + off + level)];
        const content = text.slice(contentFrom, Math.max(contentFrom, attributes.textTo));
        children.push(...cx.parser.parseInline(content, at + contentFrom));
        if (closing) children.push(cx.elt('HeaderMark', at + closing.from, at + closing.to));
        children.push(cx.elt('Attributes', at + braces.from, at + braces.to));
        const heading = cx.elt(`ATXHeading${level}`, at + off, at + text.length, children);
        cx.nextLine();
        cx.addElement(heading);
        return true;
      },
      before: 'ATXHeading',
    },
  ],
};
