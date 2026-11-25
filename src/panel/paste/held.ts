// Pastes whose text comes later: an image the host is saving, or HTML whose converter is still
// loading. Each is held where it was made, kept in step with every edit made meanwhile.

import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state';
import { resyncPending } from '../sync';

/** What a held paste needs of the editor: a view, or a stand-in for one in tests. */
export interface PasteTarget {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

interface HeldPaste {
  id: number;
  /** Where the text goes. */
  target: EditorSelection;
  /** The selection when the paste was made: while it is unchanged, the cursor follows the text. */
  selection: EditorSelection;
}

const hold = StateEffect.define<HeldPaste>();
const releasePaste = StateEffect.define<number>();

/**
 * A target follows the text around it. A point keeps text typed at it after it. A selected
 * stretch that an edit reached into becomes a point before that edit, so the paste replaces
 * nothing typed after it was made.
 */
function mapTarget(range: SelectionRange, changes: ChangeDesc): SelectionRange {
  if (!range.empty) {
    let reached = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA < range.to && toA > range.from) reached = true;
    });
    if (reached) return EditorSelection.cursor(changes.mapPos(range.from, -1));
  }
  return range.map(changes);
}

/** The held pastes, in the order they were made. */
export const heldPastes = StateField.define<readonly HeldPaste[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.length) {
      next = next.map((held) => ({
        id: held.id,
        target: EditorSelection.create(
          held.target.ranges.map((range) => mapTarget(range, tr.changes)),
          held.target.mainIndex,
        ),
        selection: held.selection.map(tr.changes),
      }));
    }
    for (const effect of tr.effects) {
      if (effect.is(hold)) next = [...next, effect.value];
      else if (effect.is(releasePaste)) next = next.filter((held) => held.id !== effect.value);
    }
    return next;
  },
});

let lastId = 0;

/** Holds a paste that will go at `target`; its id. */
export function holdPaste(view: PasteTarget, target: EditorSelection): number {
  const id = ++lastId;
  view.dispatch({ effects: hold.of({ id, target, selection: view.state.selection }) });
  return id;
}

/** The held paste with this id; undefined once released, or when the state was rebuilt (a resync). */
function heldPaste(state: EditorState, id: number): HeldPaste | undefined {
  return state.field(heldPastes, false)?.find((held) => held.id === id);
}

/** Ends a held paste with nothing inserted. */
export function dropHeldPaste(view: PasteTarget, id: number): void {
  if (heldPaste(view.state, id)) view.dispatch({ effects: releasePaste.of(id) });
}

/**
 * Inserts what a held paste writes and ends it. `change` works on a state whose selection is
 * the paste's target. False, with nothing inserted, when the state was rebuilt meanwhile or is
 * about to be (`resyncPending`): the text would be lost with it.
 */
export function insertHeldPaste(
  view: PasteTarget,
  id: number,
  change: (state: EditorState) => TransactionSpec,
): boolean {
  const held = heldPaste(view.state, id);
  if (!held || resyncPending(view.state)) {
    dropHeldPaste(view, id);
    return false;
  }
  const spec = change(view.state.update({ selection: held.target, filter: false }).state);
  const effects = spec.effects instanceof StateEffect ? [spec.effects] : (spec.effects ?? []);
  // The cursor follows the text only when nobody has moved it or typed since the paste.
  const follow = view.state.selection.eq(held.selection);
  view.dispatch({
    ...spec,
    ...(follow ? {} : { selection: undefined, scrollIntoView: false }),
    effects: [...effects, releasePaste.of(id)],
  });
  return true;
}
