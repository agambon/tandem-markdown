// Reading clipboard HTML without a DOM, enough to tell what kind of copy it is. The conversion
// (htmlToMarkdown.ts) uses a real parser and shares the helpers exported here.
//
// Every pattern and loop here looks at each character a bounded number of times, whatever the
// HTML: a web page decides what a copy puts on the clipboard. A tag pattern stops at the next
// `<`, and comments and the elements that are not content are cut out by searching forward,
// never by a pattern that can scan to the end again from each start.

import { VOID_ELEMENTS } from '../html/elements';

interface HtmlElement {
  name: string;
  attrs: string;
  children: HtmlNode[];
  parent: HtmlElement | null;
  /** Some text with words in it lies inside this element, at any depth. */
  text: boolean;
}
type HtmlNode = HtmlElement | string;

/** The copied part of clipboard HTML: between the StartFragment and EndFragment markers when it has them. */
export function htmlFragment(html: string): string {
  const startMark = '<!--StartFragment-->';
  const start = html.indexOf(startMark);
  const end = html.lastIndexOf('<!--EndFragment-->');
  if (start >= 0 && end > start) return html.slice(start + startMark.length, end);
  return html;
}

/** `html` without its comments, each from `<!--` to the first `-->` after it. One never closed stays, as does all after it. */
function withoutComments(html: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = html.indexOf('<!--', i);
    const end = start < 0 ? -1 : html.indexOf('-->', start + 4);
    if (end < 0) return out + html.slice(i);
    out += html.slice(i, start);
    i = end + 3;
  }
}

const NOT_CONTENT = /<(script|style|head|title|xml|template|noscript)\b/gi;

/**
 * `html` without the elements whose text is not content, each from its opening tag to the
 * first closing tag of its name after it. One never closed stays (and so does every later
 * one of that name, which cannot be closed either).
 */
function withoutNonContent(html: string): string {
  const open = new RegExp(NOT_CONTENT.source, 'gi');
  const neverClosed = new Set<string>();
  let out = '';
  let i = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const name = m[1]!.toLowerCase();
    if (neverClosed.has(name)) continue;
    const close = new RegExp(`<\\/${name}\\s*>`, 'gi');
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) {
      neverClosed.add(name);
      continue;
    }
    out += html.slice(i, m.index);
    i = c.index + c[0].length;
    open.lastIndex = i;
  }
  return out + html.slice(i);
}

/** Comments, Word's conditional markers, and elements whose text is not content. */
export function withoutNoise(html: string): string {
  return withoutNonContent(
    withoutComments(html)
      .replace(/<!\[(?:if|endif)[^\]<]*\]>/gi, '')
      .replace(/<!DOCTYPE[^<>]*>/gi, ''),
  );
}

/**
 * A forgiving tag reader: enough structure to tell what kind of HTML this is. The comments and
 * non-content are already cut out, and the style tests read each tag's attributes as written,
 * so it needs neither the tokenizer's rules nor the decoded values of `readTags` (html/blocks.ts).
 */
function readHtml(html: string): HtmlElement {
  const root: HtmlElement = { name: '#root', attrs: '', children: [], parent: null, text: false };
  let current = root;
  /** How many elements of each name are open around `current`: a closing tag with none open is passed over at once. */
  const open = new Map<string, number>();
  const token = /<(\/)?([a-zA-Z][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    if (m[4] !== undefined) {
      current.children.push(m[4]);
      if (hasWords(m[4])) for (let e: HtmlElement | null = current; e && !e.text; e = e.parent) e.text = true;
      continue;
    }
    if (m[2] === undefined) {
      current.children.push('<');
      for (let e: HtmlElement | null = current; e && !e.text; e = e.parent) e.text = true;
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (!open.get(name)) continue;
      for (let e: HtmlElement = current; e !== root; e = e.parent ?? root) {
        open.set(e.name, (open.get(e.name) ?? 1) - 1);
        if (e.name === name) {
          current = e.parent ?? root;
          break;
        }
      }
      continue;
    }
    const attrs = m[3] ?? '';
    const element: HtmlElement = { name, attrs, children: [], parent: current, text: false };
    current.children.push(element);
    if (!VOID_ELEMENTS.has(name) && !/\/\s*$/.test(attrs)) {
      current = element;
      open.set(name, (open.get(name) ?? 0) + 1);
    }
  }
  return root;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrOf(element: HtmlElement, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(element.attrs);
  return m ? decodeAttr(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const styleOf = (element: HtmlElement) => attrOf(element, 'style') ?? '';

export const BOLD_STYLE = /font-weight\s*:\s*(?:bold|bolder|[6-9]00)\b/i;
export const NORMAL_WEIGHT = /font-weight\s*:\s*(?:normal|lighter|[1-5]00)\b/i;
export const ITALIC_STYLE = /font-style\s*:\s*(?:italic|oblique)\b/i;
// Stops at the next `:` too: a style holding the property many times with no `;` is read once.
export const STRIKE_STYLE = /text-decoration(?:-line)?\s*:[^;":]*line-through/i;
export const WORD_LIST_STYLE = /mso-list\s*:\s*l\d+\s+level\d+/i;
const PREFORMATTED_STYLE = /white-space\s*:\s*pre/i;
const MONOSPACE =
  /monospace|consolas|courier|menlo|monaco|cascadia|jetbrains|fira ?code|source ?code|sf ?mono|dejavu sans mono|ubuntu mono|lucida console|inconsolata|roboto mono|plex mono|\bhack\b/i;

/** Tags that carry formatting markdown can write. */
const RICH_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'table',
  'hr',
  'img',
  'em',
  'i',
  's',
  'strike',
  'del',
  'mark',
  'dl',
]);

/** Elements that hold paragraphs rather than being one. */
const BLOCKISH_TAGS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'li',
  'table',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

/** What a code editor puts inside its one preformatted block. */
const CODE_EDITOR_TAGS = new Set(['span', 'div', 'br', 'font', 'code', 'b', 'i', 'em', 'strong', 'u', 's']);

const isText = (node: HtmlNode): node is string => typeof node === 'string';

/** The text holds something other than spaces and no-break spaces. */
export const hasWords = (text: string) => text.replace(/&nbsp;|&#160;|\xA0/g, ' ').trim() !== '';

/** Every element inside `root`, in document order. A loop, not recursion: clipboard HTML can nest without end. */
function* elements(root: HtmlElement): Generator<HtmlElement> {
  const stack: HtmlNode[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i]!);
  while (stack.length) {
    const node = stack.pop()!;
    if (isText(node)) continue;
    yield node;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
}

/** Some text with words in it lies inside (worked out once, as the HTML was read). */
function hasText(root: HtmlElement): boolean {
  return root.text;
}

/** b and strong set to normal weight wrap Google Docs' whole copy; they mean nothing. */
function isNormalWeightWrapper(element: HtmlElement): boolean {
  return (element.name === 'b' || element.name === 'strong') && NORMAL_WEIGHT.test(styleOf(element));
}

/** What the copy holds at its top: through html, body and do-nothing wrappers; no meta, no blank text. */
function topLevel(root: HtmlElement): HtmlNode[] {
  const content = (element: HtmlElement) =>
    element.children.filter((node) =>
      isText(node)
        ? hasWords(node)
        : !(
            node.name === 'meta' ||
            node.name === 'link' ||
            (node.name === 'br' && /Apple-interchange-newline/.test(node.attrs))
          ),
    );
  let nodes = content(root);
  for (;;) {
    const only = nodes.length === 1 ? nodes[0]! : null;
    if (!only || isText(only)) break;
    if (only.name !== 'html' && only.name !== 'body' && !isNormalWeightWrapper(only)) break;
    nodes = content(only);
  }
  return nodes;
}

/** One preformatted block in a monospace font holding only colored spans: a code editor's copy. */
function isCodeEditorCopy(top: HtmlNode[]): boolean {
  if (top.length !== 1 || isText(top[0]!)) return false;
  const block = top[0] as HtmlElement;
  const style = styleOf(block);
  const pre = block.name === 'pre';
  if (!pre && !(PREFORMATTED_STYLE.test(style) && MONOSPACE.test(style))) return false;
  for (const inner of elements(block)) if (!CODE_EDITOR_TAGS.has(inner.name)) return false;
  return true;
}

function isRich(root: HtmlElement): boolean {
  let blocks = 0;
  for (const element of elements(root)) {
    const name = element.name;
    if (RICH_TAGS.has(name)) return true;
    if (name === 'a' && attrOf(element, 'href')) return true;
    if (name === 'input' && /type\s*=\s*["']?checkbox/i.test(element.attrs)) return true;
    if ((name === 'b' || name === 'strong') && !isNormalWeightWrapper(element)) return true;
    const style = styleOf(element);
    if (style && !isNormalWeightWrapper(element)) {
      if (BOLD_STYLE.test(style) || ITALIC_STYLE.test(style) || STRIKE_STYLE.test(style)) return true;
      if (WORD_LIST_STYLE.test(style)) return true;
    }
    // Two paragraphs are structure: Word and Google Docs put one line break between
    // paragraphs in their plain text, which markdown would join into one.
    if (
      (name === 'p' || name === 'div') &&
      hasText(element) &&
      !element.children.some((c) => !isText(c) && BLOCKISH_TAGS.has(c.name))
    ) {
      blocks++;
      if (blocks >= 2) return true;
    }
  }
  return false;
}

type HtmlKind = 'empty' | 'images' | 'code' | 'wrapper' | 'rich';

/**
 * What clipboard HTML is: nothing; only images; a code editor's copy (its plain text is what
 * was copied); a plain wrapper of its text (spans and at most one paragraph); or rich.
 */
export function classifyHtml(html: string): HtmlKind {
  if (!html) return 'empty';
  const root = readHtml(withoutNoise(htmlFragment(html)));
  const text = hasText(root);
  let images = false;
  for (const element of elements(root)) if (element.name === 'img') images = true;
  if (!text) return images ? 'images' : 'empty';
  if (isCodeEditorCopy(topLevel(root))) return 'code';
  return isRich(root) ? 'rich' : 'wrapper';
}
