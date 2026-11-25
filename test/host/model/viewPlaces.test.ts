// Where a note opens again: the place it was left, kept for each note.

import { describe, expect, it } from 'vitest';
import type { ViewState } from '../../../src/core/protocol';
import { keep, keptPlaces, movedPlaceKey, placeOf, reopenAt, type KeptPlace } from '../../../src/host/model/viewPlaces';

/** A note of numbered paragraphs, one blank line between each: paragraph n is on line 2(n - 1). */
function note(paragraphs: number, first = 1): string {
  return Array.from({ length: paragraphs }, (_, i) => `Paragraph ${first + i} of the note.`).join('\n\n') + '\n';
}

function offsetOfLine(text: string, line: number): number {
  return text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
}

const left: ViewState = { selection: { anchor: 412, head: 420 }, topLine: 20, topOffsetPx: 7, mode: 'view' };

describe('where a note opens again', () => {
  it('opens a note whose text is the same at the place it was left, in the rich view it was left in', () => {
    const text = note(40);
    expect(reopenAt(placeOf(left, text, 1), text)).toEqual({ mode: 'view', viewState: left });
  });

  it('opens a note changed since with the line that was at the top at the top again', () => {
    const before = note(40);
    // Paragraph 11 was at the top (line 20); two paragraphs were inserted above it since.
    const after = 'A new opening.\n\nAnother.\n\n' + before;
    const at = reopenAt(placeOf(left, before, 1), after);
    expect(at?.mode).toBe('view');
    expect(at?.viewState?.topLine).toBe(24);
    const start = offsetOfLine(after, 24);
    expect(after.slice(start).startsWith('Paragraph 11 of the note.')).toBe(true);
    expect(at?.viewState?.selection).toEqual({ anchor: start, head: start });
  });

  it('takes the first line with text below a blank top line, and keeps the lines between', () => {
    const before = note(40);
    const atBlank: ViewState = { ...left, topLine: 21 };
    const after = 'Put in above.\n\n' + before;
    // Line 21 is blank; paragraph 12, on line 22, is found again on line 24, one line below the top.
    expect(reopenAt(placeOf(atBlank, before, 1), after)?.viewState?.topLine).toBe(23);
  });

  it('takes the copy of a repeated line nearest to where it was', () => {
    const lines = Array.from({ length: 40 }, (_, i) => (i === 10 || i === 30 ? '---' : `Line ${i}`));
    const before = lines.join('\n') + '\n';
    const after = 'Two lines\nput in.\n' + before;
    // The rule on line 30 was at the top; its copies are now on lines 12 and 32.
    expect(reopenAt(placeOf({ ...left, topLine: 30 }, before, 1), after)?.viewState?.topLine).toBe(32);
  });

  it('opens a note at the top, in the rich view it was left in, when the line at the top has gone', () => {
    const before = note(40);
    const after = note(40, 100);
    expect(reopenAt(placeOf(left, before, 1), after)).toEqual({ mode: 'view' });
  });

  it('opens a note with no place kept as if new', () => {
    expect(reopenAt(undefined, note(3))).toBeUndefined();
  });

  it('keeps no text of the note, only hashes of it', () => {
    const place = placeOf(left, note(40), 1);
    expect(JSON.stringify(place)).not.toContain('Paragraph');
  });
});

describe('the places kept', () => {
  const place = (at: number): KeptPlace => placeOf(left, note(40), at);

  it('keeps the last place reported for a note, whichever tab reported it', () => {
    let places = keep({}, 'file:///w/a.md', place(1));
    places = keep(places, 'file:///w/a.md', { ...place(2), viewState: { ...left, topLine: 3 } });
    expect(Object.keys(places)).toEqual(['file:///w/a.md']);
    expect(places['file:///w/a.md']?.viewState.topLine).toBe(3);
  });

  it('drops the place kept longest ago once there are more notes than the cap', () => {
    let places: Record<string, KeptPlace> = {};
    for (const [key, at] of [
      ['b', 5],
      ['a', 1],
      ['c', 9],
      ['d', 7],
    ] as const)
      places = keep(places, key, place(at), 3);
    expect(Object.keys(places).sort()).toEqual(['b', 'c', 'd']);
  });

  it('reads back only entries shaped as places from what the workspace holds', () => {
    const good = place(1);
    expect(keptPlaces({ good, bad: { length: 1 }, alsoBad: null })).toEqual({ good });
    expect(keptPlaces(undefined)).toEqual({});
    expect(keptPlaces(['x'])).toEqual({});
  });

  it('finds a unique deleted exact-text match for an externally moved note, and refuses copies or ties', () => {
    const text = note(20);
    const other = note(20, 50);
    const p = placeOf(left, text, 1);
    const places = {
      'file:///w/old.md': p,
      'file:///w/other.md': placeOf(left, other, 2),
    };
    expect(movedPlaceKey(places, text, () => false)).toBe('file:///w/old.md');
    // Still exists on disk (e.g. copied template): do not steal its place.
    expect(movedPlaceKey(places, text, (k) => k === 'file:///w/old.md')).toBeUndefined();
    // Ambiguous (two deleted copies with identical text): refuse to guess.
    expect(movedPlaceKey({ ...places, 'file:///w/dup.md': p }, text, () => false)).toBeUndefined();
    // Empty file never matches.
    expect(movedPlaceKey({ 'file:///w/empty.md': placeOf(left, '', 1) }, '', () => false)).toBeUndefined();
  });
});
