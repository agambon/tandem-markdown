// Whether an outside change may be merged into a document now. A rich editor of another
// extension on the same document reloads its whole text on any change it did not make itself
// and drops keystrokes still on their way to the document; VS Code 1.146's Markdown Editor then
// moves its cursor to the far end of the changed stretch, so the next keystrokes land inside
// the merged lines. While the user may be typing in such an editor, a merge outside the save
// step waits for a moment when no keystroke can be on its way. Whether the document has unsaved
// edits does not enter into it: auto-save leaves the document clean in the user's pause, and a
// merge let through then lands on the first keystroke after it.

/**
 * A document that has not changed for this long has no keystroke on its way to it: a keystroke
 * reaches the document in well under half a second even in a large file. It is longer than VS
 * Code's default `files.autoSaveDelay` (1000 ms), so with auto-save on, a change found while the
 * user types is merged by the save step at the user's pause, not by a retry that can fall on the
 * next keystroke. A shorter `files.autoSaveDelay` makes the save step, and its merge, come sooner;
 * nothing here can delay a save.
 */
export const OUTSIDE_QUIET_MS = 1500;

export interface OutsideHoldState {
  /** The active tab of the active group is another extension's custom editor showing the document. */
  otherRichEditorActive: boolean;
  windowFocused: boolean;
  /** Milliseconds since the document last changed. */
  sinceChangeMs: number;
}

/** True while an outside change must not be merged into the document, except by the save step. */
export function holdsOutsideChange(s: OutsideHoldState): boolean {
  return s.otherRichEditorActive && s.windowFocused && s.sinceChangeMs < OUTSIDE_QUIET_MS;
}
