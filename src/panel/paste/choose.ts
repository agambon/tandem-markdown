// Which paste rule applies: a pure function of the editor state and what is on the clipboard.

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { tsvToTable } from '../../core/tableModel';
import { webAddress } from '../links/read';
import { LINK_NODES } from '../markdown/nodes';
import { codeAt, treeForLine } from '../markdown/tree';
import { classifyHtml } from './classifyHtml';

/** Marks text copied from a Tandem Markdown panel. */
export const OWN_TYPE = 'application/x-tandem-markdown';
/** VS Code's editors put this beside the text and HTML they copy. */
const VSCODE_TYPE = 'vscode-editor-data';

/**
 * Clipboard HTML longer than this (2 MB of text) is not read: the plain text is pasted. Every
 * step of reading and converting HTML takes time in proportion to its length, so this bounds
 * how long a paste can hold up the panel.
 */
export const MAX_PASTE_HTML = 2 * 1024 * 1024;

export interface ClipboardInput {
  /** text/plain ('' when absent). */
  text: string;
  /** text/html ('' when absent). */
  html: string;
  types: readonly string[];
  /** Image files on the clipboard or in the drop. */
  images: readonly { name: string; type: string }[];
}

type PasteRule =
  | { rule: 'plain'; why: 'readOnly' | 'code' | 'own' | 'codeEditor' | 'wrapper' | 'text' | 'tooLong' }
  | { rule: 'image' }
  | { rule: 'link'; address: string }
  | { rule: 'table'; table: string }
  | { rule: 'html' };

// ---------------------------------------------------------------------------
// Where the selection is

/**
 * A paste at `pos` is the plain text: it is inside code (`codeAt`). Two places differ from
 * `codeAt`: at the first position of a fenced code block or front matter the paste lands before
 * the block, and a link reference definition takes a paste as any other text does.
 */
export function inPlainBlock(state: EditorState, pos: number): boolean {
  const code = codeAt(treeForLine(state, pos), pos);
  if (!code) return false;
  const { name, from } = code.node;
  if (name === 'LinkReference') return false;
  return !(from === pos && (name === 'FencedCode' || name === 'Frontmatter'));
}

function inTable(state: EditorState, pos: number): boolean {
  const tree = treeForLine(state, pos);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolve(pos, side); node; node = node.parent)
      if (node.name === 'Table' && node.from <= pos && pos <= node.to) return true;
  }
  return false;
}

/** True when [from, to] overlaps a link of any kind (a link inside a link would break both). */
function touchesLink(state: EditorState, from: number, to: number): boolean {
  let found = false;
  treeForLine(state, to).iterate({
    from,
    to,
    enter(node) {
      if (found) return false;
      if (LINK_NODES.has(node.name) && node.from < to && node.to > from) found = true;
      return undefined;
    },
  });
  return found;
}

// ---------------------------------------------------------------------------
// The decision

/**
 * Which paste rule applies to `clip` in `state`: the first of these that does.
 *   1. The editor takes no edits (Rich view): plain, which CodeMirror then refuses.
 *   2. Inside a code block, a code span, front matter or an HTML block (`inPlainBlock`): the
 *      plain text.
 *   3. Image data, when the clipboard holds no text, or HTML that is only images: the image.
 *      Excel and OneNote put a picture of the selection beside the text, and the text is what
 *      was meant.
 *   4. Text that is one web address (`webAddress`), with text selected on one line in every
 *      range and no link touched: `[selection](address)`.
 *   5. Text copied from a Tandem Markdown panel (it carries OWN_TYPE): the plain text, so a copy
 *      and paste between panels keeps the markdown exactly as written.
 *   6. Tab-separated text with at least two columns and two rows, outside a table: a table.
 *   7. HTML longer than MAX_PASTE_HTML, or from VS Code or another code editor (one
 *      preformatted block of colored spans): the plain text.
 *   8. HTML that is more than a plain wrapper of its text, or a wrapper with no text beside it:
 *      the HTML, converted to markdown.
 *   9. Otherwise the plain text.
 */
export function choosePaste(state: EditorState, clip: ClipboardInput): PasteRule {
  if (state.readOnly) return { rule: 'plain', why: 'readOnly' };
  const main = state.selection.main;
  if (inPlainBlock(state, main.from) || (main.to !== main.from && inPlainBlock(state, main.to)))
    return { rule: 'plain', why: 'code' };

  const tooLong = clip.html.length > MAX_PASTE_HTML;
  const html = clip.html && !tooLong ? classifyHtml(clip.html) : 'empty';
  if (clip.images.length > 0 && (!clip.text.trim() || html === 'images')) return { rule: 'image' };

  const address = webAddress(clip.text);
  if (address) {
    const ranges = state.selection.ranges;
    const fits = ranges.every(
      (r) =>
        !r.empty &&
        state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number &&
        !touchesLink(state, r.from, r.to),
    );
    if (fits) return { rule: 'link', address };
  }

  if (clip.types.includes(OWN_TYPE)) return { rule: 'plain', why: 'own' };

  if (!inTable(state, main.from) && !inTable(state, main.to)) {
    const table = tsvToTable(clip.text);
    if (table) return { rule: 'table', table };
  }

  if (tooLong) return { rule: 'plain', why: 'tooLong' };
  if (clip.html) {
    if (clip.types.includes(VSCODE_TYPE) || html === 'code') return { rule: 'plain', why: 'codeEditor' };
    if (html === 'rich') return { rule: 'html' };
    if (html === 'wrapper') return clip.text ? { rule: 'plain', why: 'wrapper' } : { rule: 'html' };
  }
  return { rule: 'plain', why: 'text' };
}
