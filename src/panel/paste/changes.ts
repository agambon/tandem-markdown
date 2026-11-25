// What each paste rule writes, as a transaction spec for an editor state. Every paste is one
// change with the user event `input.paste` (`input.drop` for a drop), which is not typing, so
// it is sent to the document at once and is one undo step.

import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { placeBlock } from '../commands/placeBlock';
import { linkDestination } from '../markdown/writing';

/** Each selected stretch becomes `[stretch](address)`, the cursor after it. */
export function linkChange(state: EditorState, address: string): TransactionSpec {
  const destination = linkDestination(address);
  return {
    ...state.changeByRange((range) => {
      const insert = `[${state.sliceDoc(range.from, range.to)}](${destination})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    }),
    userEvent: 'input.paste',
    scrollIntoView: true,
  };
}

/** Text in place of every selected stretch, with no conversion. */
export function plainChange(state: EditorState, text: string, userEvent = 'input.paste'): TransactionSpec {
  return { ...state.replaceSelection(text), userEvent, scrollIntoView: true };
}

/**
 * `block` in place of the main selection, as a block of its own (`placeBlock`). The cursor
 * goes after it.
 */
export function blockChange(state: EditorState, block: string): TransactionSpec {
  const placed = placeBlock(state, block, state.selection.main);
  return {
    changes: { from: placed.from, to: placed.to, insert: placed.insert },
    selection: { anchor: placed.end },
    userEvent: 'input.paste',
    scrollIntoView: true,
  };
}

/** Converted markdown: one plain line is inserted as typed; anything with a block in it as its own block. */
export function markdownChange(state: EditorState, markdown: string): TransactionSpec {
  const isBlock =
    markdown.includes('\n') || /^(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|```|~~~|\||---$|\*\*\*$)/.test(markdown);
  return isBlock ? blockChange(state, markdown) : plainChange(state, markdown);
}

/** The markdown for saved images: `![](path)`, one per line. */
export function imageMarkdown(paths: readonly string[]): string {
  return paths.map((path) => `![](${linkDestination(path)})`).join('\n');
}
