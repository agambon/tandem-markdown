// Tasks with another mark in the box: `- [?] a question`, `- [-] dropped`, `- [/] half done`.
// Obsidian takes any one character in the box as a mark; GFM's task list (`Task`) reads `[ ]`,
// `[x]` and `[X]`, which are left to it. GitLab's `[~]` ("does not apply") stays as typed, and so
// does a box holding a space of another kind, a bracket or a backslash. As for GFM's tasks, the
// box opens a list item's first paragraph and a space or tab follows it.
//
// Nodes: `MarkedTask`, the paragraph, holding `MarkedTaskMarker` (the `[?]`) and its inline
// content. Being no `Task`, it is neither checked nor counted as a task for the list commands.

import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from '@lezer/markdown';

const MARKED = /^\[[^\s[\]\\xX~]\][ \t]/;
/** The length of `[?]`. */
const MARKER_LENGTH = 3;

class MarkedTaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt('MarkedTask', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('MarkedTaskMarker', leaf.start, leaf.start + MARKER_LENGTH),
        ...cx.parser.parseInline(leaf.content.slice(MARKER_LENGTH), leaf.start + MARKER_LENGTH),
      ]),
    );
    return true;
  }
}

export const TaskMarks: MarkdownConfig = {
  defineNodes: [{ name: 'MarkedTask', block: true }, { name: 'MarkedTaskMarker' }],
  parseBlock: [
    {
      name: 'MarkedTask',
      leaf: (cx, leaf) =>
        MARKED.test(leaf.content) && cx.parentType().name === 'ListItem' ? new MarkedTaskParser() : null,
      after: 'SetextHeading',
    },
  ],
};
