// What a tab lost when it reloaded: the text the user typed there that the note does not have,
// and the text they deleted there that the note has again; and the short form a notice shows of
// lost text.

import { sendableUpdates } from '@codemirror/collab';
import type { EditorState } from '@codemirror/state';
import type { TextChange } from '../core/diff';

/** The most characters a notice shows of lost text, the "…" that ends a cut included. */
export const LOST_SHOWN_CHARS = 80;

/** What a reload lost of a view's unconfirmed changes. Pieces from separate places are joined by line breaks. */
export interface LostEdit {
  /** Text the changes inserted that the new text does not have. */
  typed: string;
  /** Text the changes deleted that the new text has again. */
  restored: string;
}

const NOTHING_LOST: LostEdit = { typed: '', restored: '' };

/**
 * What the view in `old` loses when it reloads with a new text, given `toNext`, the changes
 * from `old`'s text to the new one (core/diff's `diffChanges`). Its unconfirmed local changes
 * are compared with them: what they typed is lost where `toNext` deletes it again, and what
 * they deleted comes back where `toNext` inserts text at that place. A change that did reach
 * the note is already in the new text, so it is not counted; what another program typed or deleted
 * is not counted, since this view did not make that change.
 */
export function lostEdit(old: EditorState, toNext: readonly TextChange[]): LostEdit {
  const updates = sendableUpdates(old);
  if (updates.length === 0) return NOTHING_LOST;
  let mine = updates[0]!.changes;
  for (const u of updates.slice(1)) mine = mine.compose(u.changes);
  /** Where the changes inserted text, and where they deleted text, as spans of the view's text. */
  const inserted: [number, number][] = [];
  const removed: [number, number][] = [];
  mine.iterChanges((fromA, toA, fromB, toB) => {
    if (toB > fromB) inserted.push([fromB, toB]);
    if (toA > fromA) removed.push([fromB, toB]);
  });
  const text = old.doc.toString();
  const typed: string[] = [];
  const restored: string[] = [];
  let last = -1;
  for (const change of toNext) {
    for (const [from, to] of inserted) {
      const start = Math.max(from, change.from);
      const end = Math.min(to, change.to);
      if (end <= start) continue;
      // A piece that carries straight on from the last one is the same stretch of typing.
      if (start === last && typed.length > 0) typed[typed.length - 1] += text.slice(start, end);
      else typed.push(text.slice(start, end));
      last = end;
    }
    if (change.insert !== '' && removed.some((span) => putBackAt(text, span, change))) restored.push(change.insert);
  }
  return { typed: typed.join('\n'), restored: restored.join('\n') };
}

/**
 * True when `change` inserts its text where `span` deleted text: at that place, or at a place
 * the same insertion can slide to. A diff may write an insertion anywhere along a run of its
 * own text (one dash deleted from `----` comes back at the run's end): inserting `t` at `q` is
 * inserting it, rotated by one, at `q + 1` when the text at `q` is `t`'s first character.
 */
function putBackAt(text: string, span: [number, number], change: TextChange): boolean {
  if (change.from <= span[1] && change.to >= span[0]) return true;
  if (change.from !== change.to) return false;
  let t = change.insert;
  let q = change.from;
  while (q < span[0]) {
    if (text[q] !== t[0]) return false;
    t = t.slice(1) + t[0];
    q++;
  }
  while (q > span[1]) {
    if (text[q - 1] !== t[t.length - 1]) return false;
    t = t[t.length - 1] + t.slice(0, -1);
    q--;
  }
  return true;
}

/**
 * What the tab says of what a reload lost: the typing, with the whole of it to copy; else a
 * deletion that came back; else nothing, when the lost edit had nothing in it but spaces and
 * line breaks.
 */
export function lostNotice(lost: LostEdit): { text: string; copy?: string } | null {
  if (lost.typed.trim() !== '')
    return { text: `This tab reloaded and lost what you had just typed: ${shortLost(lost.typed)}`, copy: lost.typed };
  if (lost.restored.trim() !== '')
    return { text: 'This tab reloaded and lost your last deletion, so the deleted text is back.' };
  return null;
}

/**
 * Lost text as a notice shows it: its first line with anything on it, without the spaces
 * around it, cut to LOST_SHOWN_CHARS characters ending "…" when there is more. Copy text still
 * copies all of it.
 */
export function shortLost(text: string): string {
  const first = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const chars = Array.from(first);
  if (chars.length <= LOST_SHOWN_CHARS && first === text.trim()) return first;
  return `${chars.slice(0, LOST_SHOWN_CHARS - 1).join('')}…`;
}
