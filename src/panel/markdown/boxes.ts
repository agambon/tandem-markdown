// Boxes: a block fenced by `:::` lines (Pandoc, Quarto, VitePress, Docusaurus, Azure DevOps),
// an admonition written `!!!` or `???` over a body indented four spaces (Python-Markdown,
// Material for MkDocs, PyMdown) and, behind settings of their own, MkDocs' content tabs
// (`=== "Tab"`) and GitLab's quote between `>>>` lines. The rule, in docs/ARCHITECTURE.md,
// "Boxes": the first word, or the first class in braces, names a box; the rest of the line, or
// text in `[...]` or `"..."`, is its title; a closing line closes the innermost open box at its
// own level; a box never closed runs to the end of what holds it. Inside, the text is ordinary
// markdown. `::: mermaid` is read as a code block in the `mermaid` language, which draws it.
//
// Nodes: `Box`, a container block whose first line holds a `BoxMark` (`:::`, `!!!`, `???`,
// `===`, `>>>`), a `BoxName` or `Attributes`, and a `BoxTitle` (inline content) between two
// `BoxMark`s when it is bracketed or quoted; a fenced box's closing line is a `BoxMark`.

import type { BlockContext, Element, Line, MarkdownConfig } from '@lezer/markdown';
import { attributesEnd, readAttributes } from '../../core/attributes';
import {
  CODE_BACKSLASH,
  CODE_CLOSE_BRACKET,
  CODE_COLON,
  CODE_DOUBLE_QUOTE,
  CODE_OPEN_BRACE,
  CODE_OPEN_BRACKET,
  CODE_PLUS,
  isSpaceOrTab,
} from '../../core/markdownText';
import { reached } from './blockContext';
import { CODE_BANG, CODE_QUESTION_MARK, indentedAsCode, skipSpaces } from './chars';

/** How far a `!!!` or `???` box's body is indented, in columns. */
export const ADMONITION_INDENT = 4;

/** A bracketed title longer than this is text. */
const MAX_TITLE = 1000;

function restIsBlank(text: string, from: number): boolean {
  return skipSpaces(text, from) === text.length;
}

const NAME_START = /^\p{L}/u;
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

function nameEnd(text: string, from: number): number {
  if (!NAME_START.test(text.slice(from, from + 2))) return -1;
  let i = from;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (!NAME_CHAR.test(ch)) break;
    i += ch.length;
  }
  return i;
}

function closingEnd(text: string, from: number): number {
  let i = from;
  while (text.charCodeAt(i) === CODE_COLON) i++;
  return i - from >= 3 && restIsBlank(text, i) ? i : -1;
}

interface Part {
  type: 'BoxMark' | 'BoxName' | 'Attributes' | 'BoxTitle';
  from: number;
  to: number;
}

interface Opener {
  parts: Part[];
  /** Lowercase box type (word or first class in braces), or '' for none. */
  name: string;
}

/** End index (`]`) of a balanced bracketed title opening at `from`, or -1. */
function bracketEnd(text: string, from: number): number {
  let depth = 0;
  const limit = Math.min(text.length, from + MAX_TITLE);
  for (let i = from; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code === CODE_BACKSLASH) i++;
    else if (code === CODE_OPEN_BRACKET) depth++;
    else if (code === CODE_CLOSE_BRACKET && --depth === 0) return i;
  }
  return -1;
}

function title(text: string, from: number, to: number, parts: Part[]): void {
  let a = from;
  let b = to;
  while (a < b && isSpaceOrTab(text.charCodeAt(a))) a++;
  while (b > a && isSpaceOrTab(text.charCodeAt(b - 1))) b--;
  if (b > a) parts.push({ type: 'BoxTitle', from: a, to: b });
}

function fencedOpener(text: string, pos: number): Opener | null {
  let i = pos;
  while (text.charCodeAt(i) === CODE_COLON) i++;
  if (i - pos < 3) return null;
  const parts: Part[] = [{ type: 'BoxMark', from: pos, to: i }];
  const at = skipSpaces(text, i);
  let name: string;
  let after: number;
  if (text.charCodeAt(at) === CODE_OPEN_BRACE) {
    after = attributesEnd(text, at);
    const attributes = after < 0 ? null : readAttributes(text.slice(at, after));
    if (!attributes) return null;
    parts.push({ type: 'Attributes', from: at, to: after });
    name = (attributes.classes[0] ?? '').toLowerCase();
  } else {
    after = nameEnd(text, at);
    if (after < 0) return null;
    parts.push({ type: 'BoxName', from: at, to: after });
    name = text.slice(at, after).toLowerCase();
    if (text.charCodeAt(after) === CODE_OPEN_BRACKET) {
      // Docusaurus: `:::note[Title]`, then nothing but colons.
      const close = bracketEnd(text, after);
      if (close < 0) return null;
      parts.push({ type: 'BoxMark', from: after, to: after + 1 });
      title(text, after + 1, close, parts);
      parts.push({ type: 'BoxMark', from: close, to: close + 1 });
      return restIsBlank(text, close + 1) ? { parts, name } : null;
    }
  }
  if (after < text.length && !isSpaceOrTab(text.charCodeAt(after))) return null;
  // The rest of the line is the title, less a closing run of colons (Pandoc's `::: Warning :::`).
  let end = text.trimEnd().length;
  let colons = end;
  while (colons > after && text.charCodeAt(colons - 1) === CODE_COLON) colons--;
  if (end - colons >= 3 && isSpaceOrTab(text.charCodeAt(colons - 1))) {
    parts.push({ type: 'BoxMark', from: colons, to: end });
    end = colons;
  }
  title(text, after, end, parts);
  parts.sort((a, b) => a.from - b.from);
  return { parts, name };
}

function admonitionOpener(text: string, pos: number): Opener | null {
  const code = text.charCodeAt(pos);
  if (
    (code !== CODE_BANG && code !== CODE_QUESTION_MARK) ||
    text.charCodeAt(pos + 1) !== code ||
    text.charCodeAt(pos + 2) !== code
  )
    return null;
  let i = pos + 3;
  if (code === CODE_QUESTION_MARK && text.charCodeAt(i) === CODE_PLUS) i++;
  const parts: Part[] = [{ type: 'BoxMark', from: pos, to: i }];
  let at = skipSpaces(text, i);
  // The type, then any further classes (`!!! danger highlight blink`), which only style it.
  let name = '';
  let words = 0;
  for (let end = nameEnd(text, at); end > 0; end = nameEnd(text, at)) {
    if (!name) {
      parts.push({ type: 'BoxName', from: at, to: end });
      name = text.slice(at, end).toLowerCase();
    }
    words++;
    const next = skipSpaces(text, end);
    if (next === end && next < text.length) return null;
    at = next;
  }
  if (text.charCodeAt(at) === CODE_DOUBLE_QUOTE) {
    const close = text.trimEnd().length - 1;
    if (close <= at || text.charCodeAt(close) !== CODE_DOUBLE_QUOTE) return null;
    parts.push({ type: 'BoxMark', from: at, to: at + 1 });
    if (close > at + 1) parts.push({ type: 'BoxTitle', from: at + 1, to: close });
    parts.push({ type: 'BoxMark', from: close, to: close + 1 });
    // `???` may have a title and no type; `!!!` always names its type.
    return name || code === CODE_QUESTION_MARK ? { parts, name } : null;
  }
  // Without a quoted title, one word alone: `??? no idea` is a sentence, not a box.
  return at === text.length && words === 1 ? { parts, name } : null;
}

/** The opening line of a content tab, `=== "Title"` (PyMdown's tabbed, Material), read from `pos`, or null. */
function tabOpener(text: string, pos: number): Opener | null {
  if (!text.startsWith('===', pos)) return null;
  let i = pos + 3;
  if (text[i] === '!' || text[i] === '+') i++;
  const at = skipSpaces(text, i);
  const close = text.trimEnd().length - 1;
  if (
    at === i ||
    text.charCodeAt(at) !== CODE_DOUBLE_QUOTE ||
    close <= at + 1 ||
    text.charCodeAt(close) !== CODE_DOUBLE_QUOTE
  )
    return null;
  return {
    parts: [
      { type: 'BoxMark', from: pos, to: i },
      { type: 'BoxMark', from: at, to: at + 1 },
      { type: 'BoxTitle', from: at + 1, to: close },
      { type: 'BoxMark', from: close, to: close + 1 },
    ],
    name: '',
  };
}

/** The end of `>>>` alone on the line from `from`, the opening and closing line of GitLab's fenced quote, or -1. */
function quoteFenceEnd(text: string, from: number): number {
  return text.startsWith('>>>', from) && restIsBlank(text, from + 3) ? from + 3 : -1;
}

// ---------------------------------------------------------------------------
// Parsing

type Kind = 'colons' | 'quote' | 'indented';

const KINDS: readonly Kind[] = ['colons', 'quote', 'indented'];

function closerEnd(kind: Kind, text: string, from: number): number {
  return kind === 'colons' ? closingEnd(text, from) : kind === 'quote' ? quoteFenceEnd(text, from) : -1;
}

/**
 * What a parse knows about its open boxes, by their place in the block stack: how each is
 * written, and the end of the line that closed a fenced one, so that the box ends on the next
 * line. Every open box was opened in the same parse, since only finished blocks are reused
 * from an earlier tree.
 */
interface BoxState {
  kinds: Map<number, Kind>;
  closedAt: Map<number, number>;
}

const states = new WeakMap<BlockContext, BoxState>();

function stateOf(cx: BlockContext): BoxState {
  let state = states.get(cx);
  if (!state) states.set(cx, (state = { kinds: new Map(), closedAt: new Map() }));
  return state;
}

function boxKind(cx: BlockContext, index: number): Kind | null {
  return index > 0 && cx.parentType(index).name === 'Box' ? (stateOf(cx).kinds.get(index) ?? null) : null;
}

/** Where the closing marks end when `line` closes the box at `index` in the block stack, at its own level; else -1. */
function closes(cx: BlockContext, line: Line, index: number): number {
  const kind = boxKind(cx, index);
  return kind && !indentedAsCode(line) ? closerEnd(kind, line.text, line.pos) : -1;
}

function continueBox(cx: BlockContext, line: Line, value: number): boolean {
  if (KINDS[value % 4] === 'indented') {
    if (line.next < 0) return true;
    if (line.indent < line.baseIndent + ADMONITION_INDENT) return false;
    line.moveBaseColumn(line.baseIndent + ADMONITION_INDENT);
    return true;
  }
  const index = value >> 2;
  const state = stateOf(cx);
  if (state.closedAt.get(index) !== cx.prevLineEnd()) return true;
  state.closedAt.delete(index);
  return false;
}

function elements(cx: BlockContext, text: string, parts: readonly Part[]): Element[] {
  return parts.map((part) => {
    const from = cx.lineStart + part.from;
    const to = cx.lineStart + part.to;
    const inside = part.type === 'BoxTitle' ? cx.parser.parseInline(text.slice(part.from, part.to), from) : undefined;
    return cx.elt(part.type, from, to, inside);
  });
}

/** `::: mermaid` up to its closing line, as a code block in the `mermaid` language, as lezer reads a fence. */
function diagram(cx: BlockContext, line: Line, opener: Opener): true {
  const from = cx.lineStart + line.pos;
  const nameAt = opener.parts[1]!;
  const marks: Element[] = [
    cx.elt('CodeMark', from, cx.lineStart + opener.parts[0]!.to),
    cx.elt('CodeInfo', cx.lineStart + nameAt.from, cx.lineStart + nameAt.to),
  ];
  const texts: [number, number][] = [];
  const addText = (a: number, b: number) => {
    const last = texts[texts.length - 1];
    if (last && last[1] === a) last[1] = b;
    else texts.push([a, b]);
  };
  for (let first = true, empty = true, hasLine = false; cx.nextLine() && reached(line) >= cx.depth; first = false) {
    const close = line.indent - line.baseIndent < 4 ? closingEnd(line.text, line.pos) : -1;
    if (close >= 0) {
      marks.push(...line.markers);
      if (empty && hasLine) addText(cx.lineStart - 1, cx.lineStart);
      marks.push(cx.elt('CodeMark', cx.lineStart + line.pos, cx.lineStart + close));
      cx.nextLine();
      break;
    }
    hasLine = true;
    if (!first) {
      addText(cx.lineStart - 1, cx.lineStart);
      empty = false;
    }
    marks.push(...line.markers);
    const textFrom = cx.lineStart + line.basePos;
    const textTo = cx.lineStart + line.text.length;
    if (textFrom < textTo) {
      addText(textFrom, textTo);
      empty = false;
    }
  }
  for (const [a, b] of texts) marks.push(cx.elt('CodeText', a, b));
  marks.sort((a, b) => a.from - b.from);
  cx.addElement(cx.elt('FencedCode', from, cx.prevLineEnd(), marks));
  return true;
}

function startBox(cx: BlockContext, line: Line, kind: Kind, opener: Opener): null {
  const index = cx.depth;
  cx.startComposite('Box', line.pos, index * 4 + KINDS.indexOf(kind));
  const state = stateOf(cx);
  state.kinds.set(index, kind);
  state.closedAt.delete(index);
  for (const element of elements(cx, line.text, opener.parts)) cx.addElement(element);
  line.moveBase(line.text.length);
  return null;
}

function openBox(cx: BlockContext, line: Line): boolean | null {
  if (indentedAsCode(line)) return false;
  if (line.next === CODE_COLON) {
    const opener = fencedOpener(line.text, line.pos);
    if (!opener) return false;
    if (opener.name === 'mermaid' && opener.parts[1]?.type === 'BoxName') return diagram(cx, line, opener);
    return startBox(cx, line, 'colons', opener);
  }
  const opener = line.indent === line.baseIndent ? admonitionOpener(line.text, line.pos) : null;
  return opener ? startBox(cx, line, 'indented', opener) : false;
}

function closeBox(cx: BlockContext, line: Line): boolean {
  const index = cx.depth - 1;
  const end = closes(cx, line, index);
  if (end < 0) return false;
  stateOf(cx).closedAt.set(index, cx.lineStart + line.text.length);
  cx.addElement(cx.elt('BoxMark', cx.lineStart + line.pos, cx.lineStart + end));
  cx.nextLine();
  return true;
}

function closesParagraph(cx: BlockContext, line: Line): boolean {
  return closes(cx, line, reached(line) - 1) >= 0;
}

function opensBox(line: Line): boolean {
  if (line.next === CODE_COLON) return fencedOpener(line.text, line.pos) !== null;
  return line.indent === line.baseIndent && admonitionOpener(line.text, line.pos) !== null;
}

const BOX_NODES = [
  { name: 'Box', block: true, composite: continueBox },
  'BoxMark',
  'BoxName',
  'BoxTitle',
  'Attributes',
];

const CLOSE_BOX = { name: 'BoxClose', parse: closeBox, endLeaf: closesParagraph, before: 'LinkReference' };

export const Boxes: MarkdownConfig = {
  defineNodes: BOX_NODES,
  parseBlock: [
    CLOSE_BOX,
    { name: 'Box', parse: openBox, endLeaf: (_cx, line) => opensBox(line), before: 'FencedCode' },
  ],
};

/** MkDocs content tabs, `=== "Title"` over an indented body, each read as an indented box. */
export const ContentTabs: MarkdownConfig = {
  defineNodes: BOX_NODES,
  parseBlock: [
    {
      name: 'ContentTab',
      parse(cx, line) {
        const opener = line.indent === line.baseIndent ? tabOpener(line.text, line.pos) : null;
        return opener ? startBox(cx, line, 'indented', opener) : false;
      },
      endLeaf: (_cx, line) => line.indent === line.baseIndent && tabOpener(line.text, line.pos) !== null,
      before: 'FencedCode',
    },
  ],
};

/** GitLab's quote between `>>>` lines, read as a box between those lines that is drawn as a quote. */
export const FencedQuotes: MarkdownConfig = {
  defineNodes: BOX_NODES,
  parseBlock: [
    CLOSE_BOX,
    {
      name: 'FencedQuote',
      parse(cx, line) {
        if (indentedAsCode(line)) return false;
        const end = quoteFenceEnd(line.text, line.pos);
        if (end < 0) return false;
        return startBox(cx, line, 'quote', { parts: [{ type: 'BoxMark', from: line.pos, to: end }], name: '' });
      },
      endLeaf: (_cx, line) => !indentedAsCode(line) && quoteFenceEnd(line.text, line.pos) >= 0,
      before: 'FencedCode',
    },
  ],
};
