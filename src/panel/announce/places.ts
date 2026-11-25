// What the sentences say of the news gathered (news.ts): how much, which block drawn as a picture
// it is in, and where. A place is the nearest heading above, as the Explorer's outline names it
// (core/outline.ts), an empty or a new one with the nearest heading with words beside it; above
// the first heading; or, in a note with no headings, a third of the note, with the first words of
// a line the change is at. The front matter and a table, pipe or grid, are read from the parser's
// tree, a table counted by its rows: each line of a pipe table is a row, a grid table's row spans
// its lines, and neither a line of dashes nor a border is a row. Lines taken out of a grid table
// are counted as lines, since which rows they were is gone with them. Any other drawn block is
// read from the widget the page draws for it (`DrawnAt`), so a block opened counts as its lines.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState, Line } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { buildOutline, type OutlineItem } from '../../core/outline';
import { emojiCodes } from '../render/emoji';
import { fileGrid } from '../tables/gridCells';
import type { NewsGone, NewsLine } from './news';
import {
  ANNOUNCE_WORDS,
  type NextTo,
  type Place,
  type Quote,
  type Shape,
  type Third,
  type Told,
  type ToldOnYourLine,
} from './words';

/** The drawn block at a position of the text, by the name a sentence gives it and where it starts; null for none. */
export type DrawnAt = (pos: number) => { name: string; from: number } | null;

/** How long the parser may take to reach the last change, before the tree as it stands is read. */
const PARSE_MS = 200;

/** A line added or changed, or a stretch of lines taken out, as the sentence reads it. */
interface Spot {
  pos: number;
  count: number;
  /** For a line taken out, the heading over it is the one before its point, never one starting there. */
  gone: boolean;
  added: boolean;
  frontMatter: boolean;
  /** The drawn block or the table it is in: its name and start. */
  block: { name: string; from: number } | null;
  /**
   * In a table, where the row it is counted as starts: its own line in a pipe table, the row's
   * first line in a grid table, and a line of dashes or a border is a row of its own. Null outside
   * a table, and for lines taken out of a grid table.
   */
  row: number | null;
  /** A table's line of dashes under its header, or a grid table's border. */
  delimiter: boolean;
  /** A blank line, which says nothing of where the change is when it changed lines with words. */
  blank: boolean;
}

/** What a spot inside a table is: the table, the row it is counted as, and whether it is a delimiter. */
type InTable = Pick<Spot, 'block' | 'row' | 'delimiter'>;

/**
 * The spot at `line` (taken out there when `gone`) in the grid table `node`; null for one that
 * does not read as a table, which is drawn as its lines.
 */
function inGridTable(state: EditorState, node: SyntaxNode, line: Line, gone: boolean): InTable | null {
  const grid = fileGrid(state, node);
  if (!grid) return null;
  const block = { name: ANNOUNCE_WORDS.table, from: node.from };
  if (gone) return { block, row: null, delimiter: false };
  const at = line.from - grid.start;
  const row = [...grid.table.head, ...grid.table.body].find((r) => r.lines.includes(at));
  return { block, row: row ? grid.start + row.lines[0]! : line.from, delimiter: !row };
}

function spotsOf(state: EditorState, lines: readonly NewsLine[], gone: readonly NewsGone[], drawnAt: DrawnAt): Spot[] {
  const byLine = new Map<number, boolean>();
  for (const l of lines) byLine.set(l.from, (byLine.get(l.from) ?? false) || l.added);
  const raw = [
    ...[...byLine].map(([pos, added]) => ({ pos, count: 1, gone: false, added })),
    ...gone.map((g) => ({ pos: g.at, count: g.count, gone: true, added: false })),
  ];
  const last = Math.max(0, ...raw.map((r) => r.pos));
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, last + 1), PARSE_MS) ?? syntaxTree(state);
  return raw.map((r) => {
    const line = state.doc.lineAt(r.pos);
    let frontMatter = false;
    let table: InTable | null = null;
    let child: SyntaxNode | null = null;
    for (let n: SyntaxNode | null = tree.resolveInner(r.pos, 1); n; child = n, n = n.parent) {
      if (n.name === 'Frontmatter') frontMatter = true;
      if (n.name === 'GridTable') table = inGridTable(state, n, line, r.gone);
      if (n.name !== 'Table') continue;
      const block = { name: ANNOUNCE_WORDS.table, from: n.from };
      // A table's line of dashes is a `TableDelimiter` of its own; inside a row the name is a pipe's.
      table = { block, row: r.pos, delimiter: child?.name === 'TableDelimiter' };
    }
    const blank = !r.gone && line.text.trim() === '';
    if (frontMatter) return { ...r, frontMatter, blank, block: null, row: null, delimiter: false };
    return { ...r, frontMatter, blank, ...(table ?? { block: drawnAt(r.pos), row: null, delimiter: false }) };
  });
}

/** Spots counted: a table's line of dashes, or a grid table's border, only where nothing else of its table changed. */
function counted(spots: readonly Spot[]): Spot[] {
  return spots.filter(
    (s) => !s.delimiter || !spots.some((o) => o !== s && !o.delimiter && o.block?.from === s.block?.from),
  );
}

/** The note's headings, named as the Explorer's outline and a contents list name them. */
function headingsOf(state: EditorState): OutlineItem[] {
  return buildOutline(state.doc.toString(), emojiCodes(state));
}

function third(state: EditorState, pos: number): Third {
  const share = state.doc.lineAt(pos).number / state.doc.lines;
  return share <= 1 / 3 ? 'first' : share <= 2 / 3 ? 'middle' : 'last';
}

/** A line's marks of a quote, a list item, a task or a heading, before its words. */
const LINE_MARKS = /^(?:[ \t]*(?:[>*+-]|\d{1,9}[.)]|#{1,6}|\[[ xX]\])(?=[ \t]|$))*[ \t]*/;
/** How far into a line its first words are looked for: text from another program can be any length. */
const READ_LENGTH = 200;
/** How many words, and characters at most, a line is quoted by. */
const QUOTE_WORDS = 5;
const QUOTE_LENGTH = 40;

/** The first words of `text` after its marks, exactly as the line holds them, so Find reaches them; empty for none. */
function firstWords(text: string): string {
  const head = text.slice(0, READ_LENGTH);
  const rest = head.slice(LINE_MARKS.exec(head)![0].length).slice(0, QUOTE_LENGTH);
  let end = 0;
  let words = 0;
  for (const word of rest.matchAll(/\S+/g)) {
    if (++words > QUOTE_WORDS) break;
    end = word.index + word[0].length;
  }
  return rest.slice(0, end);
}

/** The first words of a line `spots` are at, the first of them in the note: see `Quote`. */
function quoteOf(state: EditorState, spots: readonly Spot[]): Quote | null {
  const first = [...spots].sort((a, b) => a.pos - b.pos || Number(a.gone) - Number(b.gone))[0];
  if (!first) return null;
  const line = state.doc.lineAt(first.pos);
  const words = firstWords(line.text);
  if (!first.gone) return words ? { words, at: 'on' } : null;
  if (words && line.from === first.pos) return { words, at: 'above' };
  // Taken out at the start of a line with no words, or inside one: the line it follows.
  const number = line.from === first.pos ? line.number - 1 : line.number;
  const before = number >= 1 ? firstWords(state.doc.line(number).text) : '';
  return before ? { words: before, at: 'below' } : null;
}

/** The nearest heading with words before `outline[i]`, or else after it; null where there is none. */
function nextToOf(outline: readonly OutlineItem[], i: number): NextTo | null {
  for (let j = i - 1; j >= 0; j--) if (outline[j]!.text !== '') return { side: 'after', name: outline[j]!.text };
  for (let j = i + 1; j < outline.length; j++)
    if (outline[j]!.text !== '') return { side: 'before', name: outline[j]!.text };
  return null;
}

/** Where `all` are: under which headings (by `outline`), above the first, or in which thirds. */
function placeOf(state: EditorState, all: readonly Spot[], outline: readonly OutlineItem[]): Place {
  const spots = all.some((s) => !s.blank) ? all.filter((s) => !s.blank) : all;
  if (outline.length === 0) {
    const thirds = new Set(spots.map((s) => third(state, s.pos)));
    return {
      aboveFirst: false,
      headings: [],
      thirds: (['first', 'middle', 'last'] as const).filter((t) => thirds.has(t)),
      quote: quoteOf(state, spots),
    };
  }
  const added = new Set(spots.filter((s) => s.added).map((s) => s.pos));
  const under = new Set<number>();
  let aboveFirst = false;
  for (const s of spots) {
    let index = -1;
    for (let i = 0; i < outline.length; i++) {
      const start = outline[i]!.from;
      if (start < s.pos || (start === s.pos && !s.gone)) index = i;
      else break;
    }
    if (index < 0) aboveFirst = true;
    else under.add(index);
  }
  const headings = [...under]
    .sort((a, b) => a - b)
    .map((i) => {
      const { text: name, from } = outline[i]!;
      const isNew = added.has(from);
      return { name, isNew, nextTo: name === '' || isNew ? nextToOf(outline, i) : null };
    });
  return { aboveFirst, headings, thirds: [], quote: null };
}

function shapeOf(lines: readonly NewsLine[], gone: readonly NewsGone[]): Shape {
  const shapes = new Set<Shape>([...lines.map((l) => l.shape), ...gone.map((g) => g.shape)]);
  return shapes.size === 1 ? [...shapes][0]! : 'changed';
}

/** The news as a sentence tells it (words.ts, outsideSentence); null when there is none. */
export function toldOf(
  state: EditorState,
  lines: readonly NewsLine[],
  gone: readonly NewsGone[],
  drawnAt: DrawnAt,
  fileName: string,
  problems: boolean,
): Told | null {
  const spots = counted(spotsOf(state, lines, gone, drawnAt));
  if (spots.length === 0) return null;
  const count = spots.reduce((n, s) => n + s.count, 0);
  const blocks = new Map<string, { name: string; lines: number }>();
  for (const s of spots) {
    if (!s.block) continue;
    const key = `${s.block.name}@${s.block.from}`;
    const b = blocks.get(key) ?? { name: s.block.name, lines: 0 };
    b.lines += s.count;
    blocks.set(key, b);
  }
  const frontMatter = spots.every((s) => s.frontMatter);
  const block = blocks.size === 1 ? [...blocks.values()][0]! : null;
  // Only a table's spots have rows: where all of them do, the change is all in that one table.
  const rows = block && spots.every((s) => s.row !== null) ? rowsOf(spots) : null;
  return {
    fileName,
    shape: shapeOf(lines, gone),
    count: rows ?? count,
    unit: rows === null ? 'line' : 'row',
    block: block && rows !== null ? { ...block, lines: rows } : block,
    frontMatter,
    place: placeOf(state, spots, headingsOf(state)),
    problems,
  };
}

/** How many rows `spots`, all in one table, count: each row a line of it is in once, and each row taken out. */
function rowsOf(spots: readonly Spot[]): number {
  const rows = new Set<number>();
  let taken = 0;
  for (const s of spots) {
    if (s.gone) taken += s.count;
    else if (s.row !== null) rows.add(s.row);
  }
  return rows.size + taken;
}

/**
 * The news as the sentence for the line the cursor is on tells it (words.ts, yourLineSentence),
 * with `kept` as its second sentence; null when that line is not among the lines changed.
 */
export function toldOnYourLine(
  state: EditorState,
  lines: readonly NewsLine[],
  gone: readonly NewsGone[],
  kept: ToldOnYourLine['kept'],
): ToldOnYourLine | null {
  const at = state.doc.lineAt(state.selection.main.head).from;
  const yours = lines.find((l) => l.from === at && !l.added);
  if (!yours) return null;
  const outline = headingsOf(state);
  const others = spotsOf(
    state,
    lines.filter((l) => l.from !== at),
    gone,
    () => null,
  );
  const more = others.reduce((n, s) => n + s.count, 0);
  return {
    more,
    place: more > 0 ? placeOf(state, others, outline) : null,
    yours: placeOf(
      state,
      spotsOf(state, [yours], [], () => null),
      outline,
    ),
    kept,
  };
}
