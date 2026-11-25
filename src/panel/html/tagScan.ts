// A start or end tag read as the HTML tokenizer reads it: its name, then each attribute and its
// value, up to the `>`. html/blocks.ts reads a block's tags with it, and html/renameInline.ts the
// attributes the page's content policy would report.

import { isHtmlSpace } from '../../core/markdownText';

/** What `scanTag` read. */
export interface ScannedTag {
  /** In lower case. */
  name: string;
  /** Just after the tag's `>`; -1 when the text ends inside the tag. */
  end: number;
  /** The tag ends with `/>`. */
  selfClosing: boolean;
}

/**
 * Reads the tag whose name starts at `at` in `html` (`lower` is `html` in lower case). Each
 * attribute goes to `attribute` as it is read: its name in lower case, where the name starts,
 * and where its value is ([from, to), without quotes; null for none, or for a quoted value that
 * the text ends inside). `closeQuote(quote, from)` gives where the next `quote` at or after
 * `from` is, or -1.
 */
export function scanTag(
  html: string,
  lower: string,
  at: number,
  closeQuote: (quote: string, from: number) => number,
  attribute: (name: string, nameFrom: number, value: { from: number; to: number } | null) => void,
): ScannedTag {
  const n = html.length;
  let j = at;
  while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html[j] !== '/' && html[j] !== '>') j++;
  const name = lower.slice(at, j);
  let selfClosing = false;
  for (;;) {
    while (j < n && (isHtmlSpace(html.charCodeAt(j)) || html[j] === '/')) {
      selfClosing = html[j] === '/' && html[j + 1] === '>';
      j++;
    }
    if (j >= n) return { name, end: -1, selfClosing: false };
    if (html[j] === '>') return { name, end: j + 1, selfClosing };
    selfClosing = false;
    const from = j;
    j++; // a name may start with `=`
    while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
    const attributeName = lower.slice(from, j);
    let k = j;
    while (k < n && isHtmlSpace(html.charCodeAt(k))) k++;
    if (html[k] !== '=') {
      attribute(attributeName, from, null);
      continue;
    }
    k++;
    while (k < n && isHtmlSpace(html.charCodeAt(k))) k++;
    const quote = html[k];
    if (quote === '"' || quote === "'") {
      const close = closeQuote(quote, k + 1);
      if (close < 0) {
        attribute(attributeName, from, null);
        return { name, end: -1, selfClosing: false };
      }
      attribute(attributeName, from, { from: k + 1, to: close });
      j = close + 1;
    } else {
      j = k;
      while (j < n && !isHtmlSpace(html.charCodeAt(j)) && html[j] !== '>') j++;
      attribute(attributeName, from, { from: k, to: j });
    }
  }
}
