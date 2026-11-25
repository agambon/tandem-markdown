// A fault for tests: the panel's text goes wrong without the sync layer knowing, standing for a
// bug in the panel. The test hook's `corrupt` action, the browser harness's "Corrupt panel" and
// the core simulation's panels all make it here.
//
// What goes wrong is the text the panel's unconfirmed edits rest on, its text at its synced
// version, as when an update from the host is applied wrongly. Collab's state still describes
// the panel's text, as it always does in a page: collab records every change except those its
// own receive makes, so a page never holds unconfirmed edits that skip part of its text. On
// edits that do, collab's mapping never ends.

import { receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, type Annotation, type EditorState, type TransactionSpec } from '@codemirror/state';

/**
 * Inserts `text` into the text under the unconfirmed edits, where `at` in the panel's text
 * comes from (inside text typed and not yet confirmed: where that text was typed). Collab's own
 * receive maps the unconfirmed edits over it, as over any update from the host; its annotation,
 * with the synced version left where it was, keeps the change from being sent.
 */
export function corruption(state: EditorState, at: number, text: string): TransactionSpec {
  const unconfirmed = sendableUpdates(state);
  const base = unconfirmed.length > 0 ? unconfirmed[0]!.changes.length : state.doc.length;
  const local = unconfirmed.reduce((all, u) => all.compose(u.changes), ChangeSet.empty(base));
  const from = local.invertedDesc.mapPos(at, -1);
  const received = receiveUpdates(state, [
    { changes: ChangeSet.of({ from, insert: text }, base), clientID: 'corruption' },
  ]);
  // That receive counts one update from the host: collab's new state is kept at the version it had.
  const all = (received as unknown as { annotations: readonly Annotation<unknown>[] }).annotations;
  const annotations = all.map((a) => {
    const s = a.value as { version: number; unconfirmed: unknown } | null;
    if (!s || typeof s !== 'object' || !('unconfirmed' in s)) return a;
    return a.type.of(
      Object.assign(Object.create(Object.getPrototypeOf(s) as object) as object, s, { version: s.version - 1 }),
    );
  });
  return { changes: received.changes, annotations, filter: false };
}
