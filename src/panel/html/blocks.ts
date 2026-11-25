// Reading the HTML of an HTML block without a DOM: its tags, and what the block is to the
// drawing (docs/ARCHITECTURE.md, "HTML blocks"). The text is read as the HTML tokenizer reads
// it, closely enough to tell tags from text; what reaches the page is still the door's
// (html/door.ts). Each character is looked at a bounded number of times: every search moves
// forward, and a search for something the rest of the text lacks is not repeated.

import { decodeHTMLAttribute } from 'entities';
import { isAsciiLetter, isHtmlSpace } from '../../core/markdownText';
import { CODE_BANG, CODE_QUESTION_MARK, CODE_SLASH } from '../markdown/chars';
import { isHtmlElement, VOID_ELEMENTS } from './elements';
import { scanTag } from './tagScan';

interface Tag {
  /** The name in lower case. */
  readonly name: string;
  readonly closing: boolean;
  /** Written `<name/>`. */
  readonly selfClosing: boolean;
  /** Where the tag starts, and where it ends after its `>`, in the text. */
  readonly from: number;
  readonly to: number;
  /** A start tag's attributes by lower-case name, character references read; one written with no value has ''. */
  readonly attributes: ReadonlyMap<string, string>;
  /** Inside `<svg>` or `<math>`, where names are not HTML's. */
  readonly foreign: boolean;
}

/** A range of the text, start inclusive, end exclusive. */
interface Range {
  readonly from: number;
  readonly to: number;
}

interface TagReading {
  readonly tags: readonly Tag[];
  /** Every run of text outside tags, comments and raw text that is not white space. */
  readonly text: readonly Range[];
}

/** Elements whose content the HTML tokenizer reads as text, outside SVG and MathML. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/**
 * `indexOf` that remembers its last answer for each needle, so asking again from further on
 * costs nothing until that answer is passed, and a needle the text lacks is searched for once.
 */
function finder(text: string): (needle: string, from: number) => number {
  const last = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const known = last.get(needle);
    if (known && from >= known.from && (known.at < 0 || from <= known.at)) return known.at;
    const at = text.indexOf(needle, from);
    last.set(needle, { from, at });
    return at;
  };
}

/**
 * The tags of `html` in order, and where it holds text: the one reading a browser makes of the
 * block, attribute values decoded. Each tag is read through html/tagScan.ts, which
 * html/renameInline.ts shares; paste/classifyHtml.ts reads clipboard HTML its own forgiving way.
 */
export function readTags(html: string): TagReading {
  const n = html.length;
  const lower = html.toLowerCase();
  const find = finder(lower);
  const tags: Tag[] = [];
  const text: Range[] = [];
  let foreign = 0;

  const addText = (from: number, to: number) => {
    while (from < to && isHtmlSpace(html.charCodeAt(from))) from++;
    while (to > from && isHtmlSpace(html.charCodeAt(to - 1))) to--;
    if (to > from) text.push({ from, to });
  };

  /** Reads the tag whose name starts at `at`; null when the text ends before its `>`. */
  const readTag = (start: number, at: number, closing: boolean): Tag | null => {
    const attributes = new Map<string, string>();
    const scan = scanTag(html, lower, at, find, (attribute, _from, value) => {
      if (!closing && !attributes.has(attribute)) {
        attributes.set(attribute, decodeHTMLAttribute(value ? html.slice(value.from, value.to) : ''));
      }
    });
    if (scan.end < 0) return null;
    return {
      name: scan.name,
      closing,
      selfClosing: scan.selfClosing,
      from: start,
      to: scan.end,
      attributes: closing ? NO_ATTRIBUTES : attributes,
      foreign: foreign > 0,
    };
  };

  let i = 0;
  while (i < n) {
    const lt = find('<', i);
    if (lt < 0) {
      addText(i, n);
      break;
    }
    addText(i, lt);
    const next = html.charCodeAt(lt + 1);
    if (lower.startsWith('<!--', lt)) {
      // `<!-->` and `<!--->` end at once; otherwise the comment ends at `-->` or `--!>`.
      if (html[lt + 4] === '>') i = lt + 5;
      else if (html.startsWith('->', lt + 4)) i = lt + 6;
      else {
        const a = find('-->', lt + 4);
        const b = find('--!>', lt + 4);
        i = a < 0 && b < 0 ? n : a < 0 ? b + 4 : b < 0 || a < b ? a + 3 : b + 4;
      }
      continue;
    }
    if (next === CODE_BANG || next === CODE_QUESTION_MARK) {
      // `<!...>` and `<?...>`
      const end = find('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = next === CODE_SLASH;
    if (!isAsciiLetter(html.charCodeAt(closing ? lt + 2 : lt + 1))) {
      addText(lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const tag = readTag(lt, closing ? lt + 2 : lt + 1, closing);
    if (!tag) break; // the text ends inside the tag, which is then no tag at all
    tags.push(tag);
    i = tag.to;
    const enters = tag.name === 'svg' || tag.name === 'math';
    if (enters && !closing && !tag.selfClosing) foreign++;
    else if (enters && closing && foreign > 0) foreign--;
    else if (!closing && foreign === 0) {
      if (tag.name === 'plaintext') break;
      if (RAW_TEXT.has(tag.name)) {
        const end = find(`</${tag.name}`, i);
        i = end < 0 ? n : end;
      }
    }
  }
  return { tags, text };
}

/**
 * `html` with every tag that names no HTML element written as text (`&lt;name>`), so a browser
 * shows it as typed instead of dropping it. Tags inside SVG and MathML keep their own names.
 */
export function escapeUnknownTags(html: string): string {
  let out = '';
  let last = 0;
  for (const tag of readTags(html).tags) {
    if (tag.foreign || isHtmlElement(tag.name)) continue;
    out += `${html.slice(last, tag.from)}&lt;`;
    last = tag.from + 1;
  }
  return last === 0 ? html : out + html.slice(last);
}

/** A `width` or `height` attribute in pixels (`120`, `120px`), or null for any other. */
export function sizeInPixels(value: string | null | undefined): number | null {
  const match = /^\s*(\d{1,5})\s*(?:px)?\s*$/i.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// What a block is to the drawing

export type Align = 'left' | 'center' | 'right' | 'justify';

/**
 * What an HTML block is:
 * - `opener`: the opening tag of a wrapper whose inside is markdown (`<details>`, `<div align>`),
 *   left open for a later `closer` among the blocks beside it. `pure` when it holds only that
 *   tag (and, for `<details>`, one `<summary>`, whose inner HTML is `summary`); a `<details>`
 *   is always pure.
 * - `closer`: one end tag alone.
 * - `invisible`: nothing a browser would show (an anchor, empty elements).
 * - `drawing`: HTML a browser shows, complete in itself.
 * - `text`: tag-shaped text that names no HTML element, shown as typed.
 * - `code`: HTML that leaves elements open for blocks after it, which is shown as code.
 */
export type HtmlBlock =
  | {
      kind: 'opener';
      name: string;
      align: Align | null;
      /** A `<details>` written with `open`. */
      open: boolean;
      pure: boolean;
      summary: Range | null;
    }
  | { kind: 'closer'; name: string }
  | { kind: 'summary'; inner: Range; empty: boolean }
  | { kind: 'invisible' | 'drawing' | 'text' | 'code' };

/** Elements whose inside may be markdown, between their tag lines. */
const WRAPPERS = new Set(['details', 'div', 'p', 'center']);

/** Elements whose end tag may be left out, which leave nothing waiting for a later block. */
const OPTIONAL_END = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'tbody',
  'thead',
  'tfoot',
  'option',
  'optgroup',
  'colgroup',
  'caption',
  'rb',
  'rt',
  'rtc',
  'rp',
]);

/** Elements a browser shows with no text in them. */
const SHOWN_EMPTY = new Set([
  'img',
  'br',
  'hr',
  'picture',
  'video',
  'audio',
  'input',
  'textarea',
  'select',
  'button',
  'iframe',
  'svg',
  'math',
  'canvas',
  'object',
  'embed',
  'meter',
  'progress',
]);

const ALIGNS = new Set<string>(['left', 'center', 'right', 'justify']);

function isWrapperStart(tag: Tag): boolean {
  return !tag.closing && (WRAPPERS.has(tag.name) || (tag.attributes.has('markdown') && isHtmlElement(tag.name)));
}

function alignOf(tag: Tag): Align | null {
  if (tag.name === 'center') return 'center';
  const value = tag.attributes.get('align')?.trim().toLowerCase() ?? '';
  return ALIGNS.has(value) ? (value as Align) : null;
}

function inside(range: Range, outer: Range): boolean {
  return range.from >= outer.from && range.to <= outer.to;
}

/** The first `<summary>` directly inside the `<details>` that `tags[0]` opens: its element and inner HTML. */
function summaryOf(tags: readonly Tag[]): { element: Range; inner: Range } | null {
  let depth = 0;
  for (let i = 1; i < tags.length; i++) {
    const tag = tags[i]!;
    if (tag.closing) {
      depth--;
      continue;
    }
    if (VOID_ELEMENTS.has(tag.name) || tag.selfClosing) continue;
    if (depth === 0 && tag.name === 'summary') {
      let nested = 0;
      for (let k = i + 1; k < tags.length; k++) {
        const t = tags[k]!;
        if (t.name !== 'summary' || t.selfClosing) continue;
        if (!t.closing) nested++;
        else if (nested > 0) nested--;
        else return { element: { from: tag.from, to: t.to }, inner: { from: tag.to, to: t.from } };
      }
      return null;
    }
    depth++;
  }
  return null;
}

/** When the whole block is one balanced `<summary>...</summary>` element, its inner HTML range. */
function standaloneSummary(tags: readonly Tag[], text: readonly Range[]): Range | null {
  const first = tags[0];
  if (!first || first.closing || first.selfClosing || first.name !== 'summary') return null;
  let nested = 0;
  let close: Tag | null = null;
  for (let i = 1; i < tags.length; i++) {
    const tag = tags[i]!;
    if (tag.name !== 'summary' || tag.selfClosing) continue;
    if (!tag.closing) nested++;
    else if (nested > 0) nested--;
    else {
      close = tag;
      break;
    }
  }
  if (!close) return null;
  const outer: Range = { from: first.from, to: close.to };
  if (!tags.every((t) => inside(t, outer)) || !text.every((r) => inside(r, outer))) return null;
  return { from: first.to, to: close.from };
}

/** What the HTML block `html` (its whole text) is to the drawing. */
export function readHtmlBlock(html: string): HtmlBlock {
  const { tags, text } = readTags(html);
  const first = tags[0];
  if (!first) return { kind: text.length ? 'text' : 'invisible' };
  if (!isHtmlElement(first.name)) return { kind: 'text' };

  if (text.length === 0 && tags.every((t) => t.closing)) {
    // End tags alone close what other blocks opened: one is a wrapper's closer, more are code.
    return tags.length === 1 ? { kind: 'closer', name: first.name } : { kind: 'code' };
  }

  const open: string[] = [];
  let stray = false;
  for (const tag of tags) {
    if (tag.closing) {
      const at = open.lastIndexOf(tag.name);
      if (at < 0) stray = true;
      else open.length = at;
    } else if (!VOID_ELEMENTS.has(tag.name) && !tag.selfClosing) {
      open.push(tag.name);
    }
  }

  if (isWrapperStart(first) && open.length === 1 && open[0] === first.name && !stray) {
    const summary = first.name === 'details' ? summaryOf(tags) : null;
    const allowed: Range[] = [{ from: first.from, to: first.to }];
    if (summary) allowed.push(summary.element);
    const pure =
      tags.every((t) => allowed.some((r) => inside(t, r))) &&
      text.every((t) => summary !== null && inside(t, summary.element));
    // A <details> folds what follows its summary, so it is a wrapper only when nothing else
    // comes before the markdown.
    if (first.name === 'details' && !pure) return { kind: 'code' };
    return {
      kind: 'opener',
      name: first.name,
      align: alignOf(first),
      open: first.name === 'details' && first.attributes.has('open'),
      pure,
      summary: summary?.inner ?? null,
    };
  }

  if (!open.every((name) => OPTIONAL_END.has(name))) return { kind: 'code' };
  const empty = text.length === 0 && !tags.some((t) => !t.closing && SHOWN_EMPTY.has(t.name));
  if (!stray && open.length === 0) {
    const summary = standaloneSummary(tags, text);
    if (summary) return { kind: 'summary', inner: summary, empty };
  }
  if (empty) return { kind: 'invisible' };
  return { kind: 'drawing' };
}

// ---------------------------------------------------------------------------
// Pairing wrappers

export interface TagBlock {
  readonly from: number;
  readonly to: number;
  readonly shape: HtmlBlock;
}

export interface Wrapper<T extends TagBlock = TagBlock> {
  readonly opener: T & { readonly shape: Extract<HtmlBlock, { kind: 'opener' }> };
  readonly closer: T;
  /** A standalone `<summary>` block immediately after a `<details>` opener with no summary of its own. */
  readonly summary?: T & { readonly shape: Extract<HtmlBlock, { kind: 'summary' }> };
}

/**
 * The wrappers among `blocks`, the HTML blocks of one parent in document order: each closer
 * ends the nearest opener of its name still open, and openers opened after that one stay
 * unpaired. A standalone `<summary>` block right after a `<details>` opener with no blocks
 * between them (`onlyBlankBetween`) becomes that `<details>`'s summary. In the order of their openers.
 */
export function pairWrappers<T extends TagBlock>(
  blocks: readonly T[],
  onlyBlankBetween: (from: number, to: number) => boolean = () => true,
): Wrapper<T>[] {
  const open: {
    opener: T & { readonly shape: Extract<HtmlBlock, { kind: 'opener' }> };
    summary?: T & { readonly shape: Extract<HtmlBlock, { kind: 'summary' }> };
  }[] = [];
  const out: Wrapper<T>[] = [];
  for (const block of blocks) {
    const shape = block.shape;
    if (shape.kind === 'opener') {
      open.push({ opener: block as T & { readonly shape: typeof shape } });
    } else if (shape.kind === 'summary') {
      const top = open[open.length - 1];
      if (
        top &&
        top.opener.shape.name === 'details' &&
        top.opener.shape.summary === null &&
        !top.summary &&
        onlyBlankBetween(top.opener.to, block.from)
      ) {
        top.summary = block as T & { readonly shape: typeof shape };
      }
    } else if (shape.kind === 'closer') {
      let at = open.length - 1;
      while (at >= 0 && open[at]!.opener.shape.name !== shape.name) at--;
      if (at < 0) continue;
      const matched = open[at]!;
      out.push(
        matched.summary
          ? { opener: matched.opener, closer: block, summary: matched.summary }
          : { opener: matched.opener, closer: block },
      );
      open.length = at;
    }
  }
  return out.sort((a, b) => a.opener.from - b.opener.from);
}
