// Where each note opens in a rich tab: the place last reported for it (the top line, the
// selection and the rich view), kept with a fingerprint of the note's text. A note whose text
// is the same opens at that place. A note changed since opens with the line that was at the
// top (the first one there that holds more than white space) at the top again, where that
// line's text is still in the note, and at the top of the note otherwise. That line is kept as a
// hash, so no text of a note is kept. Offsets and lines are those of the LF text, as in a view
// state.

import { textHash } from '../../core/hash';
import type { Mode, ViewState } from '../../core/protocol';

/** How many notes keep a place: past it, the place kept longest ago goes first. */
const PLACES_KEPT = 200;
/** How much of the line at the top is hashed to find it again. */
const LINE_TEXT_MAX = 200;
/** How far below the top a line that holds more than white space is looked for. */
const LINES_LOOKED_AT = 50;

export interface KeptPlace {
  /** The note's text when the place was kept: its length and hash (core/hash.ts). */
  length: number;
  hash: string;
  viewState: ViewState;
  /**
   * The first line at or below the top that holds more than white space: the hash of its text,
   * cut to LINE_TEXT_MAX characters, and how many lines below the top it is.
   */
  line?: { hash: string; below: number };
  /** When it was kept, in milliseconds: the oldest goes first. */
  at: number;
}

/** What a note opens at: always the rich view, and the place unless it opens at the top. */
export interface ReopenAt {
  mode: Mode;
  viewState?: ViewState;
}

/** The place to keep for a note whose LF text is `text`, from the view state last reported for it. */
export function placeOf(viewState: ViewState, text: string, at: number): KeptPlace {
  const place: KeptPlace = { length: text.length, hash: textHash(text), viewState, at };
  // The start of the top line, found by its line breaks: a long note is not split into lines.
  let start = 0;
  for (let line = 0; line < Math.floor(viewState.topLine); line++) {
    const end = text.indexOf('\n', start);
    if (end < 0) break;
    start = end + 1;
  }
  for (let below = 0; below < LINES_LOOKED_AT && start <= text.length; below++) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end < 0 ? text.length : end);
    if (line.trim() !== '') {
      place.line = { hash: lineHash(line), below };
      break;
    }
    if (end < 0) break;
    start = end + 1;
  }
  return place;
}

/** `places` with `place` kept for the note `key`, the oldest dropped past `cap`. */
export function keep(
  places: Record<string, KeptPlace>,
  key: string,
  place: KeptPlace,
  cap = PLACES_KEPT,
): Record<string, KeptPlace> {
  const next = { ...places, [key]: place };
  const keys = Object.keys(next);
  if (keys.length > cap) {
    const oldest = keys.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, keys.length - cap);
    for (const k of oldest) delete next[k];
  }
  return next;
}

/**
 * `places` with the place of each note `moves` names (old key to new) kept under its new key,
 * in place of any the new key held, and none left under the old.
 */
export function moved(
  places: Record<string, KeptPlace>,
  moves: ReadonlyMap<string, string>,
): Record<string, KeptPlace> {
  const next = { ...places };
  for (const from of moves.keys()) delete next[from];
  for (const [from, to] of moves) {
    const place = places[from];
    if (place) next[to] = place;
  }
  return next;
}

/**
 * When a note has no place kept under its own key (for example after `git mv` or a file-manager
 * move outside VS Code), finds the unique kept place whose exact non-empty text matches `text`
 * and whose old file is gone (`exists(key) === false`). Returns undefined if none or more than
 * one matches.
 */
export function movedPlaceKey(
  places: Record<string, KeptPlace>,
  text: string,
  exists: (key: string) => boolean,
): string | undefined {
  if (text.length === 0) return undefined;
  const hash = textHash(text);
  let found: string | undefined;
  for (const [key, place] of Object.entries(places)) {
    if (place.length !== text.length || place.hash !== hash) continue;
    if (exists(key)) continue;
    if (found !== undefined) return undefined;
    found = key;
  }
  return found;
}

/** Where a note whose LF text is now `text` opens, from the place kept for it; undefined with none. */
export function reopenAt(place: KeptPlace | undefined, text: string): ReopenAt | undefined {
  if (!place) return undefined;
  const mode = place.viewState.mode;
  if (text.length === place.length && textHash(text) === place.hash) return { mode, viewState: place.viewState };
  if (!place.line) return { mode };
  const lines = text.split('\n');
  const was = place.viewState.topLine + place.line.below;
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '' || lineHash(lines[i]!) !== place.line.hash) continue;
    if (found < 0 || Math.abs(i - was) < Math.abs(found - was)) found = i;
  }
  if (found < 0) return { mode };
  let start = 0;
  for (let i = 0; i < found; i++) start += lines[i]!.length + 1;
  return {
    mode,
    viewState: {
      selection: { anchor: start, head: start },
      topLine: Math.max(0, found - place.line.below),
      topOffsetPx: 0,
      mode,
    },
  };
}

function lineHash(line: string): string {
  return textHash(line.slice(0, LINE_TEXT_MAX));
}

/** The places in what the workspace's state holds, leaving out any entry not shaped as one. */
export function keptPlaces(value: unknown): Record<string, KeptPlace> {
  const out: Record<string, KeptPlace> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, place] of Object.entries(value as Record<string, unknown>)) {
    if (isKeptPlace(place)) out[key] = place;
  }
  return out;
}

function isKeptPlace(x: unknown): x is KeptPlace {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Partial<KeptPlace>;
  const v = p.viewState;
  const line = p.line;
  return (
    typeof p.length === 'number' &&
    typeof p.hash === 'string' &&
    typeof p.at === 'number' &&
    typeof v === 'object' &&
    v !== null &&
    typeof v.topLine === 'number' &&
    typeof v.topOffsetPx === 'number' &&
    (v.mode === 'view' || v.mode === 'edit') &&
    typeof v.selection === 'object' &&
    v.selection !== null &&
    typeof v.selection.anchor === 'number' &&
    typeof v.selection.head === 'number' &&
    (line === undefined || (typeof line.hash === 'string' && typeof line.below === 'number'))
  );
}
