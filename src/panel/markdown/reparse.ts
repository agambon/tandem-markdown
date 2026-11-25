// The base parser's wrapper, which runs at the start of every parse. Lezer reuses parsed nodes
// from before an edit, but whether some blocks are what they are depends on lines further down:
// line 1 opens front matter only when a closing line follows, and a term is a term only when a
// definition follows. Without this, typing the closing `---` on line 3 would leave line 1's rule
// (from the previous parse) in place and turn line 2 into a Setext heading, until something
// edited line 1. So the wrapper drops the reusable pieces of the old tree over the front matter,
// over the lines just above each change (those are always parsed fresh), and back to the line
// that may open a git conflict above a change that may close, divide or split it; and it records
// the parse's text and the front matter's end for the block parsers, which cannot look ahead
// (blockContext.ts). markdown/index.ts configures it into the base parser on its own, first.

import { TreeFragment, type Input, type PartialParse, type SyntaxNode } from '@lezer/common';
import { BlockContext, type MarkdownConfig } from '@lezer/markdown';
import { CODE_LF } from '../../core/markdownText';
import { recordParse } from './blockContext';
import { CONFLICT_OPENER, mayDivideOrClose } from './conflictMarkers';
import { frontmatterEnd } from './frontmatter';
import { MAX_MATH_BLOCK_SCAN } from './math';

/** `fragments` less what they hold before `keepFrom`. */
function trimFragments(fragments: readonly TreeFragment[], keepFrom: number): readonly TreeFragment[] {
  const out: TreeFragment[] = [];
  for (const f of fragments) {
    if (f.to <= keepFrom) continue;
    if (f.from >= keepFrom) out.push(f);
    else out.push(new TreeFragment(keepFrom, f.to, f.tree, f.offset, true, f.openEnd));
  }
  return out;
}

// BlockContext's constructor is not in the published typings, but the class is exported and
// MarkdownParser.createParse builds it with exactly these arguments.
type BlockContextConstructor = new (
  parser: unknown,
  input: Input,
  fragments: readonly TreeFragment[],
  ranges: readonly { from: number; to: number }[],
) => PartialParse;

/**
 * How many lines above a change a block may look down past to it: a term, over a blank line,
 * to the definition below it (definitions.ts).
 */
const LOOK_AHEAD_LINES = 2;

/** How much is read at a time when looking back for line starts. */
const READ_BACK = 1024;

/** The start of the line `lines` lines above the one holding `pos`. */
function lineStartAbove(input: Input, pos: number, lines: number): number {
  let found = 0;
  for (let at = pos; at > 0;) {
    const from = Math.max(0, at - READ_BACK);
    const chunk = input.read(from, at);
    for (let i = chunk.length - 1; i >= 0; i--)
      if (chunk.charCodeAt(i) === CODE_LF && ++found > lines) return from + i + 1;
    at = from;
  }
  return 0;
}

/**
 * Whether the change that cuts `f` short may close, divide or split a git conflict: its text
 * from `f.to` to `to` has a line that may divide or close one, or it starts on a conflict of
 * the old parse (`f.tree`), whose marker lines it may have taken away.
 */
function mayChangeConflict(input: Input, f: TreeFragment, to: number): boolean {
  for (let n: SyntaxNode | null = f.tree.resolveInner(f.to + f.offset, 1); n; n = n.parent)
    if (n.name === 'ConflictBlock') return true;
  const rest = input.read(to, Math.min(input.length, to + READ_BACK));
  const end = rest.includes('\n') ? to + rest.indexOf('\n') : to + rest.length;
  return mayDivideOrClose(input.read(lineStartAbove(input, f.to, 0), end));
}

/**
 * The start of the nearest line above the one holding `pos` that may open a git conflict, which
 * looks down from its first line to its last, however far apart they are; -1 when there is none.
 */
function conflictOpenerAbove(input: Input, pos: number): number {
  const start = lineStartAbove(input, pos, 0);
  for (let at = start; at > 0;) {
    const chunkFrom = Math.max(0, at - READ_BACK);
    const chunk = input.read(chunkFrom, Math.min(input.length, at + CONFLICT_OPENER.length));
    const found = chunk.lastIndexOf(`\n${CONFLICT_OPENER}`, at - chunkFrom - 1);
    if (found >= 0) return chunkFrom + found + 1;
    at = chunkFrom;
  }
  return start > 0 && input.read(0, CONFLICT_OPENER.length) === CONFLICT_OPENER ? 0 : -1;
}

/** Whether a change cutting `f` short may open, close, or split a `$$` math block with blank lines. */
function mayChangeMathBlock(input: Input, f: TreeFragment, to: number): boolean {
  for (let n: SyntaxNode | null = f.tree.resolveInner(f.to + f.offset, 1); n; n = n.parent)
    if (n.name === 'DisplayMathBlock' || n.name === 'DisplayMath') return true;
  const lineStart = lineStartAbove(input, f.to, 0);
  const rest = input.read(to, Math.min(input.length, to + READ_BACK));
  const end = rest.includes('\n') ? to + rest.indexOf('\n') : to + rest.length;
  const span = input.read(lineStart, end);
  return span.includes('$$') || span.includes('\n');
}

/** The start of the nearest `$$` fence line above `pos` within `MAX_MATH_BLOCK_SCAN`, or -1. */
function mathOpenerAbove(input: Input, pos: number): number {
  const start = lineStartAbove(input, pos, 0);
  if (start === 0) return -1;
  const floor = Math.max(0, start - MAX_MATH_BLOCK_SCAN);
  const chunk = input.read(floor, start);
  let end = chunk.endsWith('\n') ? chunk.length - 1 : chunk.length;
  for (;;) {
    const nl = end > 0 ? chunk.lastIndexOf('\n', end - 1) : -1;
    const lineStart = nl + 1;
    const line = chunk.slice(lineStart, end);
    const stripped = line.replace(/^(?: {0,3}> ?)*/, '');
    if (/^ {0,3}\$\$[ \t]*$/.test(stripped)) return floor + lineStart;
    if (nl < 0) break;
    end = nl;
  }
  return -1;
}

/**
 * `fragments`, each one that a change cuts short ending LOOK_AHEAD_LINES lines higher, or higher
 * still, at the line that may open a git conflict or `$$` math block the change may affect.
 */
function trimBeforeChanges(fragments: readonly TreeFragment[], input: Input): readonly TreeFragment[] {
  const out: TreeFragment[] = [];
  fragments.forEach((f, i) => {
    if (!f.openEnd) {
      out.push(f);
      return;
    }
    const nextFrom = fragments[i + 1]?.from ?? input.length;
    let to = lineStartAbove(input, f.to, LOOK_AHEAD_LINES);
    if (mayChangeConflict(input, f, nextFrom)) {
      const opener = conflictOpenerAbove(input, f.to);
      if (opener >= 0) to = Math.min(to, opener);
    }
    if (mayChangeMathBlock(input, f, nextFrom)) {
      const opener = mathOpenerAbove(input, f.to);
      if (opener >= 0) to = Math.min(to, opener);
    }
    if (to > f.from) out.push(new TreeFragment(f.from, to, f.tree, f.offset, f.openStart, true));
  });
  return out;
}

/** The parse `inner` with the pieces of `fragments` that lines below may change left out, as the header says. */
function wrap(
  inner: PartialParse,
  input: Input,
  fragments: readonly TreeFragment[],
  ranges: readonly { from: number; to: number }[],
): PartialParse {
  if (!(inner instanceof BlockContext)) {
    // Another wrapper ran before this one, so the block parsers cannot be told what their parse
    // reads. markdown/index.ts configures this one into the base parser on its own so that it
    // runs first.
    throw new Error('The base parse wrapper must run before every other wrapper');
  }
  const end = ranges[0]!.from === 0 ? frontmatterEnd(input) : -1;
  let kept = trimBeforeChanges(fragments, input);
  if (end >= 0) kept = trimFragments(kept, end);
  let parse: PartialParse = inner;
  if (kept.length !== fragments.length || kept.some((f, i) => f !== fragments[i])) {
    const Ctor = BlockContext as unknown as BlockContextConstructor;
    parse = new Ctor(inner.parser, input, kept, ranges);
  }
  recordParse(parse, input, end);
  return parse;
}

/** The base parser's wrapper; markdown/index.ts configures it first. */
export const Reparse: MarkdownConfig = { wrap };
