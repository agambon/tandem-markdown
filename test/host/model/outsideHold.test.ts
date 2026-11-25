// Whether an outside change waits while the user may be typing in another rich editor.

import { describe, expect, it } from 'vitest';
import { holdsOutsideChange, OUTSIDE_QUIET_MS, type OutsideHoldState } from '../../../src/host/model/outsideHold';

const typing: OutsideHoldState = {
  otherRichEditorActive: true,
  windowFocused: true,
  sinceChangeMs: 0,
};

describe('holdsOutsideChange', () => {
  it('holds while the user may be typing in another rich editor', () => {
    expect(holdsOutsideChange(typing)).toBe(true);
    expect(holdsOutsideChange({ ...typing, sinceChangeMs: OUTSIDE_QUIET_MS - 1 })).toBe(true);
  });

  it('lets go when another rich editor is not the active tab', () => {
    expect(holdsOutsideChange({ ...typing, otherRichEditorActive: false })).toBe(false);
  });

  it('lets go when the window loses focus', () => {
    expect(holdsOutsideChange({ ...typing, windowFocused: false })).toBe(false);
  });

  it('lets go once the document has had no change for the quiet period', () => {
    expect(holdsOutsideChange({ ...typing, sinceChangeMs: OUTSIDE_QUIET_MS })).toBe(false);
    expect(holdsOutsideChange({ ...typing, sinceChangeMs: 60_000 })).toBe(false);
  });

  it('holds only when every condition holds at once', () => {
    for (const otherRichEditorActive of [false, true])
      for (const windowFocused of [false, true])
        for (const sinceChangeMs of [0, OUTSIDE_QUIET_MS]) {
          const s = { otherRichEditorActive, windowFocused, sinceChangeMs };
          const expected = otherRichEditorActive && windowFocused && sinceChangeMs === 0;
          expect(holdsOutsideChange(s), JSON.stringify(s)).toBe(expected);
        }
  });
});
