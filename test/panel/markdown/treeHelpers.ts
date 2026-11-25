import type { Tree } from '@lezer/common';
import { markdownParser } from '../../../src/panel/markdown';

export interface FoundNode {
  name: string;
  from: number;
  to: number;
  text: string;
}

/** Every node of the given names in `text`'s parse, in document order. */
export function find(text: string, ...names: string[]): FoundNode[] {
  return findIn(markdownParser.parse(text), text, names);
}

export function findIn(tree: Tree, text: string, names: string[]): FoundNode[] {
  const out: FoundNode[] = [];
  tree.iterate({
    enter(node) {
      if (names.length === 0 || names.includes(node.name)) {
        out.push({ name: node.name, from: node.from, to: node.to, text: text.slice(node.from, node.to) });
      }
    },
  });
  return out;
}

/** The names of the top-level blocks. */
export function topLevel(text: string): string[] {
  const out: string[] = [];
  const cursor = markdownParser.parse(text).cursor();
  if (cursor.firstChild()) {
    do out.push(cursor.name);
    while (cursor.nextSibling());
  }
  return out;
}
