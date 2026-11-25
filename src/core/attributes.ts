// Attributes in braces, as Pandoc, kramdown, Python-Markdown, Hugo and markdown-it-attrs write
// them after a heading, a span or the name of a fenced block: `{#id .class key=value}`. Read
// by the panel's parser and by the outline, which shows a heading without them.
//
// Inside the braces, by Pandoc's rule: `#id` and `.class` (letters and digits in any script,
// `-`, `_`, `:` and `.`), `key=value` (the value bare, or in double or single quotes, which may
// hold spaces and braces), and `-`, short for `.unnumbered`; spaces, tabs and at most one line
// break between them, or none where one ends and the next begins (`.a#b`). A later id replaces
// an earlier one. kramdown and Python-Markdown may put a colon straight after the opening brace
// (`{: .note}`). Anything else between the braces means they are not attributes.

import {
  CODE_CLOSE_BRACE,
  CODE_CLOSE_BRACKET,
  CODE_COLON,
  CODE_DASH,
  CODE_DOT,
  CODE_DOUBLE_QUOTE,
  CODE_EQUALS,
  CODE_HASH,
  CODE_LF,
  CODE_OPEN_BRACE,
  CODE_SINGLE_QUOTE,
  isSpaceOrTab,
} from './markdownText';

interface Attributes {
  readonly id: string | null;
  readonly classes: readonly string[];
  /** `key=value` pairs in the order written, values without their quotes. */
  readonly pairs: readonly (readonly [string, string])[];
}

/** Attribute braces longer than this are text: nothing a program writes comes near it. */
export const MAX_ATTRIBUTES = 1000;

/**
 * The end (just past the `}`) of the attribute braces that open at `from` in `text`, or -1 when
 * no closing brace follows within MAX_ATTRIBUTES with no blank line before it. A quoted value may
 * hold `}`, and no line break.
 */
export function attributesEnd(text: string, from: number): number {
  if (text.charCodeAt(from) !== CODE_OPEN_BRACE) return -1;
  const limit = Math.min(text.length, from + MAX_ATTRIBUTES);
  let quote = 0;
  let lineBreak = false;
  for (let i = from + 1; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code === CODE_LF) {
      if (quote || lineBreak) return -1;
      lineBreak = true;
      continue;
    }
    if (!isSpaceOrTab(code)) lineBreak = false;
    if (quote) {
      if (code === quote) quote = 0;
    } else if ((code === CODE_DOUBLE_QUOTE || code === CODE_SINGLE_QUOTE) && text.charCodeAt(i - 1) === CODE_EQUALS) {
      quote = code;
    } else if (code === CODE_CLOSE_BRACE) {
      return i + 1;
    } else if (code === CODE_OPEN_BRACE) {
      return -1;
    }
  }
  return -1;
}

const NAME = /[\p{L}\p{N}_:.-]*/uy;
const KEY = /^[A-Za-z_][\w.:-]*$/;

/** The end of a name (of an id, a class, a key) from `at`: its run of NAME characters. */
function nameEnd(text: string, at: number): number {
  NAME.lastIndex = at;
  NAME.test(text);
  return NAME.lastIndex;
}

/** The attributes in `text`, a whole `{...}` as `attributesEnd` finds it, or null when they are not attributes. */
export function readAttributes(text: string): Attributes | null {
  if (text.charCodeAt(0) !== CODE_OPEN_BRACE || text.charCodeAt(text.length - 1) !== CODE_CLOSE_BRACE) return null;
  const end = text.length - 1;
  let i = text.charCodeAt(1) === CODE_COLON ? 2 : 1;
  let id: string | null = null;
  const classes: string[] = [];
  const pairs: [string, string][] = [];
  while (i < end) {
    const code = text.charCodeAt(i);
    if (isSpaceOrTab(code) || code === CODE_LF) {
      i++;
    } else if (code === CODE_HASH || code === CODE_DOT) {
      const to = nameEnd(text, i + 1);
      if (to === i + 1) return null;
      if (code === CODE_HASH) id = text.slice(i + 1, to);
      else classes.push(text.slice(i + 1, to));
      i = to;
    } else if (code === CODE_DASH) {
      classes.push('unnumbered');
      i++;
    } else {
      const equals = nameEnd(text, i);
      if (text.charCodeAt(equals) !== CODE_EQUALS || !KEY.test(text.slice(i, equals))) return null;
      const quote = text.charCodeAt(equals + 1);
      let to: number;
      let value: string;
      if (quote === CODE_DOUBLE_QUOTE || quote === CODE_SINGLE_QUOTE) {
        const close = text.indexOf(String.fromCharCode(quote), equals + 2);
        if (close < 0 || close >= end) return null;
        value = text.slice(equals + 2, close);
        to = close + 1;
      } else {
        to = equals + 1;
        while (to < end && !isSpaceOrTab(text.charCodeAt(to)) && text.charCodeAt(to) !== CODE_LF) to++;
        value = text.slice(equals + 1, to);
        if (value === '') return null;
      }
      pairs.push([text.slice(i, equals), value]);
      i = to;
    }
  }
  return { id, classes, pairs };
}

/**
 * The attribute braces that end `text[from, to)` (spaces after them aside), as a span, or null.
 * They must hold at least one attribute: empty braces are text.
 */
export function trailingAttributes(text: string, from = 0, to = text.length): { from: number; to: number } | null {
  let end = to;
  while (end > from && isSpaceOrTab(text.charCodeAt(end - 1))) end--;
  if (end - from < 3 || text.charCodeAt(end - 1) !== CODE_CLOSE_BRACE) return null;
  const limit = Math.max(from, end - MAX_ATTRIBUTES);
  for (
    let open = text.lastIndexOf('{', end - 2);
    open >= limit;
    open = open > 0 ? text.lastIndexOf('{', open - 1) : -1
  ) {
    if (attributesEnd(text, open) !== end) continue;
    const attributes = readAttributes(text.slice(open, end));
    if (!attributes || (attributes.id === null && !attributes.classes.length && !attributes.pairs.length)) return null;
    return { from: open, to: end };
  }
  return null;
}

interface Span {
  from: number;
  to: number;
}

/**
 * How attribute braces end an ATX heading's line (`## Title ## {#id}`), `from` being just past its
 * opening hashes: where the heading's text ends, its closing hashes, and the braces. Null when no
 * braces end the line, or when they follow `]` and so style a span, as Pandoc reads them.
 */
export function headingAttributes(
  text: string,
  from: number,
  to = text.length,
): { textTo: number; closing: Span | null; braces: Span } | null {
  const braces = trailingAttributes(text, from, to);
  if (!braces || text.charCodeAt(braces.from - 1) === CODE_CLOSE_BRACKET) return null;
  let spaceFrom = braces.from;
  while (spaceFrom > from && isSpaceOrTab(text.charCodeAt(spaceFrom - 1))) spaceFrom--;
  let hashes = spaceFrom;
  while (hashes > from && text.charCodeAt(hashes - 1) === CODE_HASH) hashes--;
  const closing = hashes < spaceFrom && (hashes === from || isSpaceOrTab(text.charCodeAt(hashes - 1)));
  let textTo = closing ? hashes : spaceFrom;
  while (textTo > from && isSpaceOrTab(text.charCodeAt(textTo - 1))) textTo--;
  return { textTo, closing: closing ? { from: hashes, to: spaceFrom } : null, braces };
}

export function attribute(attributes: Attributes, key: string): string | null {
  for (const [k, v] of attributes.pairs) if (k === key) return v;
  return null;
}

/** What a bracketed span is drawn as: one of Pandoc's three styles, or a bookmark. */
export type SpanStyle = 'underline' | 'smallcaps' | 'mark' | 'anchor';

const STYLES: readonly SpanStyle[] = ['underline', 'smallcaps', 'mark', 'anchor'];

/**
 * How a span `[text]{...}` with `attributes` is drawn, or null when it is not drawn (a class
 * only a site's styles give a meaning). An empty span with an id is a bookmark, as Pandoc's
 * Word reader writes one.
 */
export function spanStyle(attributes: Attributes, empty: boolean): SpanStyle | null {
  for (const style of STYLES) if (attributes.classes.includes(style)) return style;
  return empty && attributes.id !== null ? 'anchor' : null;
}

/**
 * The offset of the attribute braces in `text` that give the id `id` (`[]{#_Toc12 .anchor}`,
 * `## Title {#intro}`), or -1. Looks at each `#id` in the text once.
 */
export function findAnchor(text: string, id: string): number {
  if (!id) return -1;
  const wanted = `#${id}`;
  for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) {
    const windowFrom = Math.max(0, at - MAX_ATTRIBUTES);
    const before = text.slice(windowFrom, at);
    const brace = before.lastIndexOf('{');
    if (brace < 0 || before.lastIndexOf('}') > brace) continue;
    const open = windowFrom + brace;
    const end = attributesEnd(text, open);
    if (end > at && readAttributes(text.slice(open, end))?.id === id) return open;
  }
  return -1;
}
