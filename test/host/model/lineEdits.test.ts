// Where a line goes after an edit: here as a conflict file's warning moves, to the start of a range
// replaced around it. Scroll sync's own case, to the end, is in textEditorFollow.test.ts.

import { describe, expect, it } from 'vitest';
import { lineAfter } from '../../../src/host/model/lineEdits';

describe("a warning's line as the note is edited", () => {
  it('moves with lines added or taken out above it', () => {
    expect(lineAfter(10, [{ from: 2, to: 2, lines: 3 }], 'start')).toBe(13);
    expect(lineAfter(10, [{ from: 2, to: 5, lines: 0 }], 'start')).toBe(7);
  });

  it('stays for edits below it, or on its own line, and goes to the start of a range replaced around it', () => {
    expect(lineAfter(10, [{ from: 12, to: 14, lines: 0 }], 'start')).toBe(10);
    expect(lineAfter(10, [{ from: 10, to: 10, lines: 1 }], 'start')).toBe(10);
    expect(lineAfter(10, [{ from: 8, to: 12, lines: 0 }], 'start')).toBe(8);
  });

  it('takes several changes of one edit against the text before it', () => {
    expect(
      lineAfter(
        10,
        [
          { from: 1, to: 1, lines: 1 },
          { from: 5, to: 6, lines: 0 },
        ],
        'start',
      ),
    ).toBe(10);
  });
});
