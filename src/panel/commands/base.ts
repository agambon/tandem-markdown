// What every editing command shares: how a state command becomes a panel command, the user event
// its transaction carries, and a state for lang-markdown's own commands. When a command may run
// is `canEdit` (modes.ts); the tree it reads is `treeFor` (markdown/tree.ts).
//
// A command is a pure function from an editor state to a transaction (or null when it does not
// apply). Its transaction carries the user event `input.format`, which is not typing, so the
// change is sent to the document at once and is one undo step there.

import { indentUnit, language, syntaxTree } from '@codemirror/language';
import { EditorState, StateEffect, type Transaction } from '@codemirror/state';
import { treeFor } from '../markdown/tree';
import type { PanelCommand } from './registry';

/** The user event of every formatting and block command: not typing, so it is pushed at once. */
export const COMMAND_EVENT = 'input.format';

/** A command as a pure function: the transaction it would dispatch, or null when it does not apply. */
export type StateCommand = (state: EditorState, args?: unknown) => Transaction | null;

/** Wraps a state command as a panel command: dispatches its transaction; false when it gave none. */
export function asPanelCommand(command: StateCommand): PanelCommand {
  return (view, args) => {
    const tr = command(view.state, args);
    if (!tr) return false;
    view.dispatch(tr);
    return true;
  };
}

/**
 * A state for lang-markdown's commands, which read `syntaxTree(state)` themselves: the text and
 * selection of `state`, with the tree parsed to `upto` stored in it. When `state` does not hold
 * that tree already, the new state keeps only the language and the settings those commands read,
 * so the drawing's fields are not worked out again for a state that is thrown away.
 */
export function parsedTo(state: EditorState, upto: number): EditorState {
  const tree = treeFor(state, upto);
  const lang = state.facet(language);
  if (tree === syntaxTree(state) || !lang) return state;
  // Reconfiguring keeps the language field's value as it was; the update after it stores the parse.
  const reduced = state.update({
    effects: StateEffect.reconfigure.of([
      lang.extension,
      indentUnit.of(state.facet(indentUnit)),
      EditorState.allowMultipleSelections.of(state.facet(EditorState.allowMultipleSelections)),
      EditorState.lineSeparator.of(state.lineBreak),
    ]),
  }).state;
  return reduced.update({}).state;
}
