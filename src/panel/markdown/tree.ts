// Reading the syntax tree. A state keeps the tree it was made with, which may stop short of the
// place a reader looks at: the commands, the typing rules, the cards and the readers of links
// read it through `treeFor`, parsed far enough (`treeForLine` for a line), and ask `codeAt`
// whether a place is inside code.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { CODE_SPANS, NO_INLINE } from './nodes';

/**
 * How far past what it reads a reader has the text parsed. A line alone is not enough: the line
 * after it can make it a setext heading or a table's header, and a block that holds it runs on.
 */
export const PARSE_PAST = 2000;

/**
 * The syntax tree, parsed at least to `upto`. A state keeps the tree it was made with, which may
 * stop short of a place a command reads: read the tree through this, never through
 * `syntaxTree(state)`. With no `budgetMs` the parse goes as far as it must however long that
 * takes, so a command never acts on a shorter one; with one, it stops when the time is up. The
 * parse is kept in the state's parse context, which the states after it take over, so it is
 * paid for once.
 */
export function treeFor(state: EditorState, upto: number, budgetMs = Infinity): Tree {
  return ensureSyntaxTree(state, Math.min(state.doc.length, Math.max(0, upto)), budgetMs) ?? syntaxTree(state);
}

/** The syntax tree, parsed `PARSE_PAST` past the line holding `pos`: what a reader of that line needs. */
export function treeForLine(state: EditorState, pos: number): Tree {
  return treeFor(state, state.doc.lineAt(pos).to + PARSE_PAST);
}

/**
 * The code holding `pos`: a block no command changes inside (`block`: code, HTML, front matter
 * or a link reference definition, NO_INLINE), or an inline code span or formula that holds
 * `pos` strictly inside it (`span`). Null elsewhere.
 */
export function codeAt(tree: Tree, pos: number): { kind: 'block' | 'span'; node: SyntaxNode } | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (NO_INLINE.has(n.name) && n.from <= pos && pos <= n.to) return { kind: 'block', node: n };
    }
  }
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 0); n; n = n.parent) {
    if (CODE_SPANS.has(n.name) && n.from < pos && pos < n.to) return { kind: 'span', node: n };
  }
  return null;
}
