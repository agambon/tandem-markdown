// Clipboard HTML as markdown, with turndown and its GFM plugin, in a detached document that is
// never inserted into the page. Loaded on the first paste that needs it (paste/index.ts), so turndown
// is not part of what the panel loads to start.

import { gfm } from '@joplin/turndown-plugin-gfm';
import TurndownService from 'turndown';
import { longestRun } from '../markdown/writing';
import {
  BOLD_STYLE,
  hasWords,
  htmlFragment,
  ITALIC_STYLE,
  NORMAL_WEIGHT,
  STRIKE_STYLE,
  withoutNoise,
  WORD_LIST_STYLE,
} from './classifyHtml';

// `MARKDOWN_ESCAPES` is turndown 7.2.5's `markdownEscapes` (MIT) less its escape of `_`.
// turndown's notice:
//
//   Copyright (c) 2017 Dom Christie
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/** turndown's own escapes, less one: see `escapeMarkdown`. */
const MARKDOWN_ESCAPES: [RegExp, string][] = [
  [/\\/g, '\\\\'],
  [/\*/g, '\\*'],
  [/^-/g, '\\-'],
  [/^\+ /g, '\\+ '],
  [/^(=+)/g, '\\$1'],
  [/^(#{1,6}) /g, '\\$1 '],
  [/`/g, '\\`'],
  [/^~~~/g, '\\~~~'],
  [/\[/g, '\\['],
  [/\]/g, '\\]'],
  [/^>/g, '\\>'],
  [/^(\d+)\. /g, '$1\\. '],
];

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Text as markdown that reads as that text. An underscore inside a word cannot start or end emphasis, so it is left as it is. */
function escapeMarkdown(text: string): string {
  let out = text;
  for (const [pattern, replacement] of MARKDOWN_ESCAPES) out = out.replace(pattern, replacement);
  return out.replace(/_/g, (match: string, offset: number, whole: string) =>
    WORD_CHAR.test(whole[offset - 1] ?? '') && WORD_CHAR.test(whole[offset + 1] ?? '') ? match : '\\_',
  );
}

const SAFE_HREF = /^(?:https?:|mailto:)/i;
const SAFE_SRC = /^https?:/i;

let turndown: TurndownService | null = null;

function converter(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '\\',
  });
  td.use(gfm);
  // Rules added later are tried first.
  td.addRule('tmListItem', {
    filter: 'li',
    replacement(content, node) {
      const parent = node.parentNode as HTMLElement | null;
      let marker = '- ';
      if (parent && parent.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? '1');
        const index = Array.prototype.indexOf.call(parent.children, node) as number;
        marker = `${(Number.isFinite(start) ? start : 1) + index}. `;
      }
      const loose = /\n$/.test(content);
      const text = content.replace(/^\n+/, '').replace(/\n+$/, '') + (loose ? '\n' : '');
      const indented = text.replace(/\n/g, `\n${' '.repeat(marker.length)}`);
      return marker + indented + (node.nextSibling ? '\n' : '');
    },
  });
  td.addRule('tmPre', {
    filter: 'pre',
    replacement(_content, node) {
      const code = node.querySelector('code');
      const className = `${node.getAttribute('class') ?? ''} ${code?.getAttribute('class') ?? ''}`;
      const language = /(?:language|lang|highlight-source)-([\w+#.-]+)/.exec(className)?.[1] ?? '';
      const text = (node.textContent ?? '').replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });
  td.addRule('tmTable', {
    filter: 'table',
    replacement(content, node) {
      const table = node as HTMLTableElement;
      const rows = table.rows;
      const layout = (rows.length === 1 && rows[0]!.cells.length <= 1) || !!table.querySelector('table');
      if (layout) return `\n\n${content}\n\n`;
      const lines = content.replace(/\n+/g, '\n').trim().split('\n');
      if (!(lines[1] && /^\|\s*:?-{3,}/.test(lines[1]))) {
        // No header row: the first row is the header, as a spreadsheet paste does it.
        const columns = Math.max(1, (lines[0] ?? '').replace(/\\\|/g, '').split('|').length - 2);
        lines.splice(1, 0, `|${' --- |'.repeat(columns)}`);
      }
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
  td.addRule('tmMark', {
    filter: 'mark',
    replacement: (content) => (content.trim() ? `==${content}==` : content),
  });
  td.addRule('tmUnsafeLink', {
    filter: (node) => node.nodeName === 'A' && !SAFE_HREF.test(node.getAttribute('href') ?? ''),
    replacement: (content) => content,
  });
  td.addRule('tmUnsafeImage', {
    filter: (node) => node.nodeName === 'IMG' && !SAFE_SRC.test(node.getAttribute('src') ?? ''),
    replacement: () => '',
  });
  td.escape = escapeMarkdown;
  turndown = td;
  return td;
}

const REMOVE =
  'script, style, noscript, template, iframe, object, embed, svg, canvas, video, audio, button, select, textarea, head, meta, link, title, input:not([type="checkbox"])';
const BLOCK_NAMES = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

const isBlockElement = (node: Node | null) => !!node && node.nodeType === 1 && BLOCK_NAMES.has(node.nodeName);
const isBlankText = (node: Node | null) => !!node && node.nodeType === 3 && !hasWords(node.textContent ?? '');

function siblingSkippingBlank(node: Node, direction: 'previousSibling' | 'nextSibling'): Node | null {
  let s = node[direction];
  while (s && (isBlankText(s) || s.nodeType === 8)) s = s[direction];
  return s;
}

/**
 * The panel's content policy allows no style attributes, and a document made by DOMParser
 * takes the page's policy, so each `style` in pasted HTML would be reported as a violation
 * (and then ignored). The attributes are renamed before parsing and read under this name.
 */
const STYLE_ATTR = 'data-tm-style';

function renameStyles(html: string): string {
  return html.replace(/<([a-zA-Z][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g, (tag, name: string, attrs: string) =>
    /(?:^|\s)style\s*=/i.test(attrs) ? `<${name}${attrs.replace(/(^|\s)style(\s*=)/gi, `$1${STYLE_ATTR}$2`)}>` : tag,
  );
}

const styleAttr = (element: Element) => element.getAttribute(STYLE_ATTR) ?? '';

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}

function wrapChildren(element: Element, tag: string): void {
  const wrapper = element.ownerDocument.createElement(tag);
  while (element.firstChild) wrapper.appendChild(element.firstChild);
  element.appendChild(wrapper);
}

/** Word writes lists as paragraphs with `mso-list` styles and the bullet as text; make real lists. */
function wordLists(body: HTMLElement): void {
  const items = [...body.querySelectorAll('p')].filter((p) => WORD_LIST_STYLE.test(styleAttr(p)));
  let i = 0;
  while (i < items.length) {
    const run = [items[i]!];
    while (i + 1 < items.length && siblingSkippingBlank(run[run.length - 1]!, 'nextSibling') === items[i + 1])
      run.push(items[++i]!);
    i++;
    wordListRun(run);
  }
}

function wordListRun(run: HTMLElement[]): void {
  const doc = run[0]!.ownerDocument;
  const stack: { level: number; list: HTMLElement; ordered: boolean; item: HTMLElement | null }[] = [];
  for (const p of run) {
    const level = Number(/level(\d+)/i.exec(styleAttr(p))?.[1] ?? '1');
    const marker = [...p.querySelectorAll('span')].find((s) => /mso-list\s*:\s*ignore/i.test(styleAttr(s)));
    const markerText = (marker?.textContent ?? '').replace(/\xA0/g, ' ').trim();
    const ordered = /^(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]$/.test(markerText);
    const start = Number(/^\d+/.exec(markerText)?.[0] ?? '1');
    marker?.remove();

    while (stack.length && stack[stack.length - 1]!.level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.level === level && top.ordered !== ordered) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.level < level) {
      const list = doc.createElement(ordered ? 'ol' : 'ul');
      if (ordered && start !== 1) list.setAttribute('start', String(start));
      if (top) {
        let holder = top.item;
        if (!holder) {
          holder = doc.createElement('li');
          top.list.appendChild(holder);
          top.item = holder;
        }
        holder.appendChild(list);
      } else {
        p.parentNode?.insertBefore(list, p);
      }
      top = { level, list, ordered, item: null };
      stack.push(top);
    }
    const item = doc.createElement('li');
    while (p.firstChild) item.appendChild(p.firstChild);
    top.list.appendChild(item);
    top.item = item;
    p.remove();
  }
}

/** Google Docs and styled web pages say bold, italic and struck through in `style`; say it in tags. */
function styledSpans(body: HTMLElement): void {
  for (const span of [...body.querySelectorAll('span, font')]) {
    const style = styleAttr(span);
    if (!style || span.closest('h1, h2, h3, h4, h5, h6, th, pre, code')) continue;
    if (STRIKE_STYLE.test(style) && !span.closest('s, del, strike')) wrapChildren(span, 'del');
    if (ITALIC_STYLE.test(style) && !span.closest('i, em')) wrapChildren(span, 'em');
    if (BOLD_STYLE.test(style) && !span.closest('b, strong')) wrapChildren(span, 'strong');
  }
}

/** Lists as markdown needs them: a nested list inside its item, an item's lone paragraph unwrapped. */
function tidyLists(body: HTMLElement): void {
  for (const list of [...body.querySelectorAll('ul, ol')]) {
    const parent = list.parentElement;
    if (!parent || (parent.nodeName !== 'UL' && parent.nodeName !== 'OL')) continue;
    const previous = siblingSkippingBlank(list, 'previousSibling');
    if (previous && previous.nodeName === 'LI') (previous as Element).appendChild(list);
    else {
      const item = list.ownerDocument.createElement('li');
      parent.insertBefore(item, list);
      item.appendChild(list);
    }
  }
  for (const item of [...body.querySelectorAll('li')]) {
    const blocks = [...item.children].filter((c) => isBlockElement(c));
    const paragraphs = blocks.filter((c) => c.nodeName === 'P');
    if (
      paragraphs.length === 1 &&
      blocks.every((c) => c.nodeName === 'P' || c.nodeName === 'UL' || c.nodeName === 'OL')
    )
      unwrap(paragraphs[0]!);
  }
}

/** Line breaks that only separate blocks or end one would come out as stray backslashes. */
function tidyBreaks(body: HTMLElement): void {
  for (const br of [...body.querySelectorAll('br')]) {
    if (br.classList.contains('Apple-interchange-newline')) {
      br.remove();
      continue;
    }
    const before = siblingSkippingBlank(br, 'previousSibling');
    const after = siblingSkippingBlank(br, 'nextSibling');
    const parent = br.parentElement;
    const betweenBlocks = (before === null || isBlockElement(before)) && (after === null || isBlockElement(after));
    const endsBlock = after === null && parent !== null && isBlockElement(parent);
    if (betweenBlocks || endsBlock) br.remove();
  }
}

/** Clipboard HTML as markdown, parsed by `parse` into a detached document. '' when nothing is left. */
export function htmlToMarkdown(html: string, parse: (html: string) => Document): string {
  const doc = parse(renameStyles(withoutNoise(htmlFragment(html))));
  const body = doc.body;
  if (!body) return '';
  for (const element of [...body.querySelectorAll(REMOVE)]) element.remove();
  // The GFM plugin reads a cell's alignment from `align` or its style; the style is renamed.
  for (const cell of [...body.querySelectorAll('td, th')]) {
    const align = /text-align\s*:\s*(left|center|right)/i.exec(styleAttr(cell))?.[1];
    if (align && !cell.hasAttribute('align')) cell.setAttribute('align', align.toLowerCase());
  }
  wordLists(body);
  for (const element of [...body.querySelectorAll('b, strong')]) {
    if (NORMAL_WEIGHT.test(styleAttr(element))) unwrap(element);
  }
  styledSpans(body);
  tidyLists(body);
  tidyBreaks(body);
  for (const a of [...body.querySelectorAll('a[href]')])
    if (!SAFE_HREF.test(a.getAttribute('href') ?? '')) a.removeAttribute('href');
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue && node.nodeValue.includes('\xA0')) node.nodeValue = node.nodeValue.replace(/\xA0/g, ' ');
  }
  const markdown = converter().turndown(body);
  return markdown
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
