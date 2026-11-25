// VS Code's completion items as the panel's suggestion list takes them: one place where the
// suggested text starts, a plain text for each with the cursor's place in it, sorted as VS Code
// sorts them. Left out: VS Code's own snippets (`[[` and paths are what is asked for), items
// that would also change text elsewhere (`additionalTextEdits`: half of such a suggestion would
// be applied), and items whose text starts on another line or after the cursor.

import type { Text } from '@codemirror/state';
import type { CompletionsResult, SuggestionItem } from '../../core/featureProtocol';

/** The most suggestions sent for one request. */
export const MAX_SUGGESTIONS = 200;
/** The longest label, detail or text taken from an item. */
const MAX_ITEM_CHARS = 1000;
/** How deeply snippet placeholders may nest. */
const MAX_SNIPPET_DEPTH = 8;

interface Position {
  line: number;
  character: number;
}

/** What the host reads off one `vscode.CompletionItem`. */
export interface RawSuggestion {
  label: string;
  /** The label's detail and description, or the item's detail. */
  detail: string;
  filterText?: string | undefined;
  sortText?: string | undefined;
  /** The text to insert; the label when the item gives none. */
  insertText?: string | undefined;
  /** `insertText` is a snippet (`$1`, `${1:name}`). */
  snippet: boolean;
  /** The range the inserted text replaces up to the cursor; undefined for the word before the cursor. */
  range?: { start: Position; end: Position } | undefined;
  /** The item's kind is a snippet. */
  snippetKind: boolean;
  hasExtraEdits: boolean;
  /** The item's command asks for suggestions again. */
  again: boolean;
}

/** Characters that end the text a suggestion with no range of its own replaces. */
const STOPS = new Set([' ', '\t', '/', '\\', '#', '(', ')', '[', ']', '<', '>', '"', "'", '`', '|']);

/** Where the text before `at` that a suggestion without a range replaces starts. */
function defaultStart(doc: Text, at: number): number {
  const line = doc.lineAt(at);
  let i = at - line.from;
  while (i > 0 && !STOPS.has(line.text.charAt(i - 1))) i--;
  return line.from + i;
}

function offsetOf(doc: Text, p: Position): number | null {
  if (!Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.line >= doc.lines) return null;
  const line = doc.line(p.line + 1);
  return p.character >= 0 && p.character <= line.length ? line.from + p.character : null;
}

const PLAIN_STOP = /\$(\d+|[A-Za-z_]\w*)/y;
const BRACED = /\$\{(\d+|[A-Za-z_]\w*)([:|}]?)/y;

/** The index just after the `}` that closes a `${` whose inside starts at `i`, braces nesting. */
function afterClosing(snippet: string, i: number): number {
  let open = 1;
  for (; i < snippet.length; i++) {
    const c = snippet.charAt(i);
    if (c === '\\') i++;
    else if (c === '{') open++;
    else if (c === '}' && --open === 0) return i + 1;
  }
  return snippet.length;
}

/**
 * A snippet's text with every placeholder replaced by its default (`${1:name}` gives `name`, a
 * choice its first option, a variable its default or nothing), and the cursor where the first
 * tab stop is: `$1` before `$2`, `$0` last, the end when there is none.
 */
export function snippetText(snippet: string): { text: string; cursor: number } {
  let text = '';
  // The lowest tab stop seen, with $0 ranked last, and where it is in `text`.
  let stopRank = Infinity;
  let cursor = -1;
  const stopAt = (n: number) => {
    const rank = n === 0 ? Number.MAX_SAFE_INTEGER : n;
    if (rank < stopRank) {
      stopRank = rank;
      cursor = text.length;
    }
  };
  // One pass, `i` only moving forward; `depth` counts the placeholders open around it.
  let i = 0;
  let depth = 0;
  while (i < snippet.length) {
    const c = snippet.charAt(i);
    if (c === '\\' && i + 1 < snippet.length && '$}\\,|'.includes(snippet.charAt(i + 1))) {
      text += snippet.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === '}' && depth > 0) {
      depth--;
      i++;
      continue;
    }
    if (c !== '$') {
      text += c;
      i++;
      continue;
    }
    PLAIN_STOP.lastIndex = i;
    const plain = PLAIN_STOP.exec(snippet);
    if (plain) {
      if (/^\d/.test(plain[1]!)) stopAt(Number(plain[1]));
      i = PLAIN_STOP.lastIndex;
      continue;
    }
    BRACED.lastIndex = i;
    const braced = BRACED.exec(snippet);
    if (!braced || depth >= MAX_SNIPPET_DEPTH) {
      text += c;
      i++;
      continue;
    }
    if (/^\d/.test(braced[1]!)) stopAt(Number(braced[1]));
    i = BRACED.lastIndex;
    if (braced[2] === ':') {
      depth++;
    } else if (braced[2] === '|') {
      // A choice: its first option is the text.
      const end = snippet.indexOf('|}', i);
      const options = end < 0 ? snippet.slice(i) : snippet.slice(i, end);
      text += (options.split(/(?<!\\),/)[0] ?? '').replace(/\\(.)/g, '$1');
      i = end < 0 ? snippet.length : end + 2;
    } else if (braced[2] === '') {
      // A variable with a transform (`${name/(.*)/x/}`): it inserts nothing here.
      i = afterClosing(snippet, i);
    }
  }
  return { text, cursor: cursor < 0 ? text.length : cursor };
}

export function suggestions(doc: Text, at: number, raw: readonly RawSuggestion[]): CompletionsResult {
  const line = doc.lineAt(at);
  const placed: { start: number; item: SuggestionItem; sort: string }[] = [];
  for (const r of raw) {
    if (r.snippetKind || r.hasExtraEdits || typeof r.label !== 'string' || r.label === '') continue;
    const start = r.range ? offsetOf(doc, r.range.start) : defaultStart(doc, at);
    if (start === null || start > at || start < line.from) continue;
    const source = (r.insertText ?? r.label).slice(0, MAX_ITEM_CHARS);
    const { text, cursor } = r.snippet ? snippetText(source) : { text: source, cursor: source.length };
    if (text.includes('\n')) continue;
    const label = r.label.slice(0, MAX_ITEM_CHARS);
    placed.push({
      start,
      sort: r.sortText ?? label,
      item: {
        label,
        filter: (r.filterText ?? label).slice(0, MAX_ITEM_CHARS),
        detail: r.detail.slice(0, MAX_ITEM_CHARS),
        insert: text,
        cursor,
        again: r.again,
      },
    });
  }
  if (placed.length === 0) return { from: at, items: [] };
  // One list has one start: the one most items share.
  const counts = new Map<number, number>();
  for (const p of placed) counts.set(p.start, (counts.get(p.start) ?? 0) + 1);
  let from = placed[0]!.start;
  for (const [start, n] of counts) if (n > counts.get(from)! || (n === counts.get(from) && start > from)) from = start;
  const items = placed
    .filter((p) => p.start === from)
    .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
    .slice(0, MAX_SUGGESTIONS)
    .map((p) => p.item);
  return { from, items };
}
