// Inline markdown read as plain text: what a reader sees of it, for the headings of the outline
// and of a contents list, and the start of a note in a link's card, which show text, not
// drawings. Marks with a plain form give it: the marked text without its marks, a link its text,
// an entity its character, a comment nothing. Math has none: a formula, found by the page's
// rule (formulas.ts), stays exactly as typed, nothing inside it read. An emoji code on GitHub's
// list gives its emoji when the caller passes the list (the emoji setting is on for the file,
// and the list has loaded); without it, every code stays as typed. Codes are found by the
// page's rule (emojiCodes.ts), and one stays as typed wherever the page does not draw it: in
// code, a link's address, an autolink or a bare web address, an HTML tag, a wikilink, a
// picture's alt text, a footnote's label, a comment, a span's attributes and math.

import { attributesEnd, readAttributes, spanStyle } from './attributes';
import { type EmojiCodes, emojiCodeEnd, emojiOf } from './emojiCodes';
import { type DollarClosers, type Formula, dollarClosers, dollarFormula, latexClosers, latexFormula } from './formulas';
import { isHtmlElement } from './htmlElements';
import { ESCAPABLE, findBacktickRun } from './markdownText';
import { parseWikilink } from './wikilinks';

/**
 * The named entities the plain reading decodes: the ones notes actually use. The panel draws every
 * HTML5 entity; the host's bundle carries this short list instead, and a name not in it stays as
 * typed.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '\u00ad',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  sup2: '\u00b2',
  sup3: '\u00b3',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  middot: '\u00b7',
  bull: '\u2022',
  hellip: '\u2026',
  prime: '\u2032',
  Prime: '\u2033',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  dagger: '\u2020',
  Dagger: '\u2021',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  harr: '\u2194',
  lArr: '\u21d0',
  rArr: '\u21d2',
  hArr: '\u21d4',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  minus: '\u2212',
  infin: '\u221e',
  check: '\u2713',
  cross: '\u2717',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
};

/**
 * A character entity reference as CommonMark reads one: decimal of up to 7 digits, hexadecimal of
 * up to 6, or a name.
 */
const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/** The character an entity stands for, or null when this table does not know it. */
function entityValue(decimal: string | undefined, hex: string | undefined, name: string | undefined): string | null {
  if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name]! : null;
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
  // CommonMark: zero, a surrogate or past the last code point stands for the replacement character.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(code);
}

// What the reading sets aside stands in the text as a placeholder: its number, written in
// characters of the private use area, one digit to a character. Every placeholder of a reading
// has as many digits as the largest number it can need, so a text of any length has room for
// all it sets aside; up to PUA_SIZE pieces (any text shorter than that) take one character each.
const PUA_START = 0xe000;
const PUA_END = 0xf8ff;
const PUA_SIZE = PUA_END - PUA_START + 1;
const isPrivateUse = (code: number) => code >= PUA_START && code <= PUA_END;

/**
 * The digits of each placeholder in a reading of `source`. Each piece set aside takes at least
 * one character of the source, so there are never more pieces than characters.
 */
function placeholderWidth(source: string): number {
  let width = 1;
  for (let room = PUA_SIZE; room <= source.length; room *= PUA_SIZE) width++;
  return width;
}

/**
 * Where the comment that opens at `at` of `s` ends, `<!--` or Obsidian's `%%`, by `closedBy(close,
 * from)` (the offset after the first `close` from `from`, or -1): CommonMark reads `<!-->` and
 * `<!--->` as whole comments, and `%%` runs to the next `%%` after one character, as the panel
 * reads a comment in a line (markdown/comment.ts).
 */
function commentEnd(s: string, at: number, closedBy: (close: string, from: number) => number): number {
  if (s.startsWith('<!--', at)) {
    if (s.startsWith('>', at + 4)) return at + 5;
    if (s.startsWith('->', at + 4)) return at + 6;
    return closedBy('-->', at + 4);
  }
  return closedBy('%%', at + 3);
}

/** `<!-- -->` and Obsidian's `%%…%%` left out; one never closed stays as typed. */
function withoutComments(s: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const html = s.indexOf('<!--', at);
    const percent = s.indexOf('%%', at);
    const start = html < 0 ? percent : percent < 0 ? html : Math.min(html, percent);
    if (start < 0) break;
    const end = commentEnd(s, start, (close, from) => {
      const found = s.indexOf(close, from);
      return found < 0 ? -1 : found + close.length;
    });
    if (end < 0) break;
    out += s.slice(at, start);
    at = end;
  }
  return out + s.slice(at);
}

/** An opening or closing tag as CommonMark reads one, its parts bounded so a long line is read once. */
const TAG =
  /<\/?([A-Za-z][A-Za-z0-9-]{0,40})((?:\s+[A-Za-z_:][\w.:-]{0,60}(?:\s*=\s*(?:"[^"]{0,1000}"|'[^']{0,1000}'|[^\s"'=<>`]{1,1000}))?){0,40})\s*\/?>/y;
const ALT = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/** The tags of HTML elements left out, a line break read as a space and a picture as its alt text. */
function withoutTags(s: string): string {
  let out = '';
  let at = 0;
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    if (i < at) continue;
    TAG.lastIndex = i;
    const m = TAG.exec(s);
    if (!m || !isHtmlElement(m[1]!)) continue;
    const name = m[1]!.toLowerCase();
    const alt = name === 'img' ? ALT.exec(m[2] ?? '') : null;
    out += s.slice(at, i) + (name === 'br' ? ' ' : alt ? (alt[1] ?? alt[2] ?? alt[3] ?? '') : '');
    at = i + m[0].length;
  }
  return out + s.slice(at);
}

// ---------------------------------------------------------------------------
// Where the page reads no math and no emoji codes

/** A URI autolink as CommonMark reads one: a scheme of 2 to 32 characters, then no space, `<` or `>`. */
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*>/y;
/** A wikilink or an embed, as `reading` takes one. */
const WIKILINK = /!?\[\[[^\]]+\]\]/y;
/** A picture, as `reading` takes one. */
const PICTURE = /!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/y;
/** A footnote reference (panel/markdown/footnote.ts): a label with no white space or brackets, and no `(` after it. */
const FOOTNOTE = /\[\^[^\s[\]]+\](?!\()/y;
/**
 * A web address GFM finds in text: `http://`, `https://` or `www.`, a domain with a dot, a port
 * and a path up to white space or `<`. GFM leaves punctuation at the end out of the address; a
 * code cannot stand there, so it is not trimmed here.
 */
const WEB_ADDRESS = /(?:https?:\/\/|www\.)[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:\/[^\s<]*)?/y;

/** The end of the match of the sticky `pattern` at `at` in `text`, or -1. */
function matchEnd(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.exec(text) ? pattern.lastIndex : -1;
}

/**
 * Finds, for each place in `text`, the end of the formula that opens there by the page's rule
 * (formulas.ts), or -1. LaTeX's delimiters are read with single backslashes, as the page reads
 * them by default; the doubled ones are behind a setting that starts off.
 */
function formulas(text: string): (at: number) => number {
  let dollars: DollarClosers | undefined;
  let latex: number[] | undefined;
  /** Where the paragraph's text starts, the only place display math in LaTeX's brackets may open. */
  const start = text.search(/\S/);
  return (at) => {
    let found: Formula | null = null;
    if (text[at] === '$') found = dollarFormula(text, at, () => (dollars ??= dollarClosers(text)));
    else if (text[at] === '\\') found = latexFormula(text, at, 1, () => (latex ??= latexClosers(text, 1)), start);
    return found ? found.to : -1;
  };
}

/**
 * Finds, for each place in `text`, the end of what the page takes whole when it opens there, so
 * that no formula and no emoji code is read inside it. Code spans and backslash escapes are not
 * among them, since `reading` sets those aside itself, and a link's address is dropped from the
 * reading. The patterns are the reading's own, or CommonMark's.
 */
export type WikilinksMode = 'noteFirst' | 'textFirst' | 'off';

export interface PlainTextOptions {
  emoji?: EmojiCodes | undefined;
  /** `tandemMarkdown.syntax.math`: true (default) keeps formulas untouched; false reads them as plain markdown. */
  math?: boolean | undefined;
  /** `tandemMarkdown.syntax.wikilinks`: 'noteFirst' (default), 'textFirst', or 'off'. */
  wikilinks?: WikilinksMode | undefined;
}

function normalizeOptions(options?: EmojiCodes | PlainTextOptions): PlainTextOptions {
  if (!options) return {};
  if ('names' in options) return { emoji: options };
  return options;
}

function claimedSpans(text: string, wikilinks: WikilinksMode): (at: number) => number {
  /**
   * For each closing mark, the offset from which it is known not to stand, so no search runs twice
   * over the same text.
   */
  const missing = new Map<string, number>();
  /** Just past the first `close` at or after `from`, where the span it closes ends, or -1. */
  const closedBy = (close: string, from: number): number => {
    if (from >= (missing.get(close) ?? Infinity)) return -1;
    const found = text.indexOf(close, from);
    if (found < 0) missing.set(close, from);
    return found < 0 ? -1 : found + close.length;
  };
  return (at) => {
    switch (text[at]) {
      case '<':
        // A comment, a tag of any name, an autolink, the rest of the raw HTML CommonMark keeps
        // whole: a processing instruction, a CDATA section, a declaration.
        if (text.startsWith('<!--', at)) return commentEnd(text, at, closedBy);
        TAG.lastIndex = at;
        if (TAG.exec(text)) return TAG.lastIndex;
        if (text.startsWith('<?', at)) return closedBy('?>', at + 2);
        if (text.startsWith('<![CDATA[', at)) return closedBy(']]>', at + 9);
        if (/^<![A-Za-z]/.test(text.slice(at, at + 3))) return closedBy('>', at + 2);
        return matchEnd(AUTOLINK, text, at);
      case '%':
        return text[at + 1] === '%' ? commentEnd(text, at, closedBy) : -1;
      case '[':
        return Math.max(wikilinks !== 'off' ? matchEnd(WIKILINK, text, at) : -1, matchEnd(FOOTNOTE, text, at));
      case '!':
        // An embed, or a picture, whose alt text the page shows as typed.
        return Math.max(wikilinks !== 'off' ? matchEnd(WIKILINK, text, at) : -1, matchEnd(PICTURE, text, at));
      case '{': {
        // Braces just after a bracket: a span's attributes, when they make one.
        if (text[at - 1] !== ']') return -1;
        const end = attributesEnd(text, at);
        const attributes = end < 0 ? null : readAttributes(text.slice(at, end));
        return attributes && spanStyle(attributes, text[at - 2] === '[') ? end : -1;
      }
      case 'h':
      case 'w':
        // A web address starts where no letter, digit or `_` stands before it.
        return at > 0 && /\w/.test(text[at - 1]!) ? -1 : matchEnd(WEB_ADDRESS, text, at);
      default:
        return -1;
    }
  };
}

/**
 * Each entity as its character. One that stands for a private-use character is set aside
 * (`hold`), so it is not taken for a placeholder, and one that stands for white space until the
 * spaces around it are run together (`holdLate`), so it stays as written.
 */
function decodeEntities(s: string, hold: (s: string) => string, holdLate: (s: string) => string): string {
  return s.replace(ENTITY, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    const char = entityValue(decimal, hex, name);
    if (char === null) return whole;
    if (/\s/.test(char)) return holdLate(char);
    return isPrivateUse(char.charCodeAt(0)) ? hold(char) : char;
  });
}

/**
 * Reduces inline markdown to what a reader sees. Code spans, backslash escapes and any
 * private-use character already in the text are set aside first (as placeholders, so the
 * patterns below cannot touch them), and in the same pass from the left, as the page reads
 * them: with `complete`, each formula and each wikilink's text, exactly as typed; with `emoji`,
 * each code the page draws, as its emoji. With `complete`, comments go; then wikilinks (those
 * the first pass did not take, when the reading is not complete), styled spans, images, links and
 * autolinks give up their text; with `complete`, the tags of HTML elements go; then emphasis,
 * strikethrough and highlight marks go; with `complete`, entities become their characters.
 * Last, the placeholders give back what they stand for, and runs of white space read as one
 * space, but for what was set aside to stay as written.
 */
function reading(source: string, complete: boolean, opts: PlainTextOptions = {}): string {
  const emoji = opts.emoji;
  const mathOn = opts.math !== false;
  const wikilinks: WikilinksMode = opts.wikilinks ?? 'noteFirst';
  const kept: string[] = [];
  const width = placeholderWidth(source);
  const hold = (s: string) => {
    let n = kept.push(s) - 1;
    let placeholder = '';
    for (let digit = 0; digit < width; digit++) {
      placeholder = String.fromCharCode(PUA_START + (n % PUA_SIZE)) + placeholder;
      n = Math.floor(n / PUA_SIZE);
    }
    return placeholder;
  };
  /** What stays as written when spaces are run together: a formula, white space an entity stands for. */
  const late = new Set<number>();
  const holdLate = (s: string) => {
    late.add(kept.length);
    return hold(s);
  };

  /** With `complete`: where what the page takes whole, opening at a place, ends (-1 when nothing opens there). */
  const claimedEnd = complete ? claimedSpans(source, wikilinks) : null;
  /** No formula and no code is read before this offset: it lies inside something the page takes whole. */
  let claimedTo = 0;
  const formulaAt = complete && mathOn ? formulas(source) : null;

  let s = '';
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    const opens = claimedEnd !== null && i >= claimedTo;
    if (opens) claimedTo = Math.max(i, claimedEnd(i));
    const wikilink = opens && wikilinks !== 'off' && (c === '[' || c === '!') ? matchEnd(WIKILINK, source, i) : -1;
    const formula = formulaAt && i >= claimedTo ? formulaAt(i) : -1;
    if (wikilink > 0) {
      // A wikilink or an embed: its text exactly as typed, as the page shows it.
      const embed = c === '!';
      s += hold(wikilinkText(source.slice(i + (embed ? 3 : 2), wikilink - 2), embed ? 'noteFirst' : wikilinks));
      i = wikilink;
    } else if (formula > 0) {
      s += holdLate(source.slice(i, formula));
      i = formula;
    } else if (isPrivateUse(c.charCodeAt(0))) {
      s += hold(c);
      i++;
    } else if (c === '\\' && i + 1 < source.length && ESCAPABLE.test(source[i + 1]!)) {
      s += hold(source[i + 1]!);
      i += 2;
    } else if (c === '`') {
      let n = 1;
      while (source[i + n] === '`') n++;
      const close = findBacktickRun(source, i + n, n);
      if (close < 0) {
        s += source.slice(i, i + n);
        i += n;
      } else {
        let content = source.slice(i + n, close).replace(/\n/g, ' ');
        if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        s += hold(content);
        i = close + n;
      }
    } else {
      const end = emoji && c === ':' && i >= claimedTo ? emojiCodeEnd(source, i) : -1;
      if (end < 0) {
        s += c;
        i++;
      } else {
        // A code: its emoji, set aside so no pattern below takes it apart (`:hash:` is `#️⃣`), or
        // the code as typed when its name is not on the list or the list has not loaded.
        const code = source.slice(i, end);
        const names = emoji?.names;
        if (!names) emoji?.wanted?.();
        const char = names ? emojiOf(names, code) : undefined;
        s += char === undefined ? code : hold(char);
        i = end;
      }
    }
  }

  if (complete) s = withoutComments(s);
  if (wikilinks !== 'off') {
    s = s.replace(/!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]/g, (_m, embed: string | undefined, link: string | undefined) =>
      wikilinkText(embed ?? link ?? '', embed !== undefined ? 'noteFirst' : wikilinks),
    );
  }
  s = s
    .replace(/\[([^\]]*)\](\{[^}\n]*\})/g, (whole, inner: string, braces: string) => {
      const attributes = readAttributes(braces);
      return attributes && spanStyle(attributes, inner === '') ? inner : whole;
    })
    .replace(/!\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/<((?:https?|ftp|mailto):[^>\s]*|[^>\s@]+@[^>\s@]+)>/gi, '$1');
  if (complete) s = withoutTags(s);

  for (let pass = 0; pass < 3; pass++) {
    const before = s;
    s = s
      .replace(/\*\*(?=\S)([^]*?\S)\*\*/g, '$1')
      .replace(/(?<![\p{L}\p{N}])__(?=\S)([^]*?\S)__(?![\p{L}\p{N}])/gu, '$1')
      .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '$1')
      .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1')
      .replace(/~~(?=\S)([^]*?\S)~~/g, '$1')
      .replace(/==(?=\S)([^]*?\S)==/g, '$1');
    if (s === before) break;
  }

  if (complete) s = decodeEntities(s, hold, holdLate);

  // One pass, so that what a placeholder gives back is never read again as a placeholder.
  let out = '';
  /** White space has been met since the last word: it reads as one space before the next. */
  let space = false;
  const addWord = (word: string) => {
    if (space && out !== '') out += ' ';
    space = false;
    out += word;
  };
  const addText = (text: string) => {
    const words = text.split(/\s+/);
    words.forEach((word, k) => {
      if (k > 0) space = true;
      if (word !== '') addWord(word);
    });
  };
  for (let i = 0; i < s.length;) {
    if (!isPrivateUse(s.charCodeAt(i))) {
      let end = i + 1;
      while (end < s.length && !isPrivateUse(s.charCodeAt(end))) end++;
      addText(s.slice(i, end));
      i = end;
      continue;
    }
    let index = 0;
    for (let digit = 0; digit < width; digit++) index = index * PUA_SIZE + (s.charCodeAt(i + digit) - PUA_START);
    const piece = kept[index] ?? s.slice(i, i + width);
    if (late.has(index)) addWord(piece);
    else addText(piece);
    i += width;
  }
  return out;
}

function wikilinkText(inner: string, mode: WikilinksMode): string {
  if (mode === 'textFirst') {
    const bar = inner.indexOf('|');
    if (bar >= 0) {
      let label = inner.slice(0, bar);
      if (label.endsWith('\\')) label = label.slice(0, -1);
      const shown = label.trim();
      if (shown) return shown;
      const target = parseWikilink(inner.slice(bar + 1));
      if (target.heading) return target.target ? `${target.target} > ${target.heading}` : target.heading;
      return target.target;
    }
  }
  const link = parseWikilink(inner);
  if (link.alias) return link.alias;
  if (link.heading) return link.target ? `${link.target} > ${link.heading}` : link.heading;
  return link.target;
}

/**
 * `source`, inline markdown, as plain text: the reading a heading's label and a note's start
 * show. Honors emoji codes, `syntax.math`, and `syntax.wikilinks` when passed.
 */
export function plainText(source: string, options?: EmojiCodes | PlainTextOptions): string {
  return reading(source, true, normalizeOptions(options));
}

/**
 * The reading heading anchors are made from (`slugOf` in src/host/model/headingAnchors.ts): as
 * `plainText`, but comments, the tags of HTML elements and entities as typed. Links already
 * written to headings name them by anchors made from this reading.
 */
export function anchorText(source: string): string {
  return reading(source, false);
}
