// Links written as HTML: the addresses a link may have, and the `<a href>` links among one
// block's inline HTML tags, which are drawn, opened and reached from the keyboard as markdown
// links are.

import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { readTags } from './blocks';

/** The schemes GitHub keeps in a link's address; a relative address has none. */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'xmpp', 'irc', 'ircs']);

/** An address as a browser reads it before its scheme: control characters dropped, and spaces at either end. */
export function cleanAddress(raw: string): string {
  return raw.replace(/[\u0000- \u007f-\u009f]/g, (c) => (c === ' ' ? ' ' : '')).trim();
}

/** The scheme of an address, lower case, or '' for a relative one. */
export function schemeOf(value: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  return match ? match[1]!.toLowerCase() : '';
}

/** Whether a link may have the address `value` (as `cleanAddress` gives it): a relative one or a scheme GitHub keeps. */
export function isLinkAddress(value: string): boolean {
  const scheme = schemeOf(value);
  return scheme === '' || LINK_SCHEMES.has(scheme);
}

export interface HtmlLink {
  href: string;
  /** From the start of `<a ...>` to the end of `</a>`. */
  from: number;
  to: number;
  /** The link's text, between the two tags. */
  textFrom: number;
  textTo: number;
}

const ANCHOR = /^<(\/?)a(?=[\s/>])/i;

/**
 * The links among the HTML tags that are children of `parent` (a paragraph, a heading, a
 * cell): each `<a href>` with the next `</a>` among them, as a browser closes an anchor.
 */
export function htmlLinksIn(doc: Text, parent: SyntaxNode): HtmlLink[] {
  const out: HtmlLink[] = [];
  let open: { node: SyntaxNode; href: string } | null = null;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'HTMLTag') continue;
    const text = doc.sliceString(child.from, child.to);
    const match = ANCHOR.exec(text);
    if (!match) continue;
    if (match[1]) {
      if (open?.href) {
        out.push({ href: open.href, from: open.node.from, to: child.to, textFrom: open.node.to, textTo: child.from });
      }
      open = null;
      continue;
    }
    const href = cleanAddress(readTags(text).tags[0]?.attributes.get('href') ?? '');
    open = { node: child, href: href && isLinkAddress(href) ? href : '' };
  }
  return out;
}
