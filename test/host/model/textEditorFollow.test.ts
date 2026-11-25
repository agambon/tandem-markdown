// A text editor's place and reveal position, and which of its reports answer the host's own
// reveals: every case is a sequence of reports as VS Code sends them, with no clock.
import { describe, expect, it } from 'vitest';
import {
  EditorFollow,
  placeOfTop,
  revealPosition,
  shiftedBy,
  type LineRange,
} from '../../../src/host/model/textEditorFollow';

/** Visible ranges of whole lines, `[first, last]` each. */
function ranges(...spans: [number, number][]): LineRange[] {
  return spans.map(([a, b]) => ({ start: { line: a, character: 0 }, end: { line: b, character: 0 } }));
}

/** VS Code's default: sticky scroll keeps five lines above a revealed line. */
const PADDING = 5;
const LINES = 1000;

describe("a text editor's place", () => {
  it('is its top line, and the share of a wrapped line before its top row', () => {
    expect(placeOfTop({ line: 40, character: 0 }, 80)).toBe(40);
    expect(placeOfTop({ line: 40, character: 20 }, 80)).toBe(40.25);
    expect(placeOfTop({ line: 7, character: 0 }, 0)).toBe(7);
  });

  it('is revealed at its line, and inside it only where lines wrap', () => {
    const length = () => 80;
    expect(revealPosition(40.25, LINES, length, true)).toEqual({ line: 40, character: 20 });
    expect(revealPosition(40.25, LINES, length, false)).toEqual({ line: 40, character: 0 });
    expect(revealPosition(5000, LINES, length, true)).toEqual({ line: 999, character: 0 });
    expect(revealPosition(-2, LINES, length, true)).toEqual({ line: 0, character: 0 });
  });

  it('comes back from a reveal position as the place it was', () => {
    const length = (line: number) => 30 + (line % 50);
    for (const place of [0, 3.5, 12.1, 400.75]) {
      const at = revealPosition(place, LINES, length, true);
      expect(placeOfTop(at, length(at.line))).toBeCloseTo(place, 1);
    }
  });
});

describe('who leads, from a text editor', () => {
  it('leads when the user scrolls it', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    expect(f.report(ranges([3, 42]), LINES)).toBe('lead');
    expect(f.report(ranges([9, 48]), LINES)).toBe('lead');
  });

  it('takes the report of its own reveal as the answer, with the target a few lines below the top', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    expect(f.reveal({ line: 200, character: 0 }, PADDING, false)).toBe(true);
    expect(f.report(ranges([195, 234]), LINES)).toBe('answer');
    // The next scroll is the user's again.
    expect(f.report(ranges([197, 236]), LINES)).toBe('lead');
  });

  it('answers each of several reveals in flight, in order, and never leads with them', () => {
    const f = new EditorFollow({ line: 100, character: 0 });
    for (const line of [101, 102, 103, 104]) f.reveal({ line, character: 0 }, PADDING, false);
    for (const top of [96, 97, 98, 99]) expect(f.report(ranges([top, top + 39]), LINES)).toBe('answer');
    expect(f.report(ranges([90, 129]), LINES)).toBe('lead');
  });

  it('does not reveal where it already is', () => {
    const f = new EditorFollow({ line: 300, character: 0 });
    expect(f.reveal({ line: 300, character: 0 }, PADDING, false)).toBe(false);
    expect(f.reveal({ line: 310, character: 0 }, PADDING, false)).toBe(true);
    expect(f.report(ranges([305, 344]), LINES)).toBe('answer');
    expect(f.reveal({ line: 310, character: 0 }, PADDING, false)).toBe(false);
  });

  it('takes the report as the answer when the target is folded away and its fold shows instead', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    f.reveal({ line: 120, character: 0 }, PADDING, false);
    // Lines 101 to 150 are folded under line 100, which VS Code puts PADDING lines from the top.
    expect(f.report(ranges([95, 100], [151, 185]), LINES)).toBe('answer');
  });

  it('counts only visible lines above the target, so a fold between them is no lead', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    f.reveal({ line: 400, character: 0 }, PADDING, false);
    expect(f.report(ranges([300, 302], [398, 430]), LINES)).toBe('answer');
  });

  it('takes the answer near the end, where VS Code cannot put the target higher', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    f.reveal({ line: 990, character: 0 }, PADDING, false);
    expect(f.report(ranges([960, 999]), LINES)).toBe('answer');
  });

  it('leads when the user scrolls it away from a reveal', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    f.reveal({ line: 200, character: 0 }, PADDING, false);
    expect(f.report(ranges([150, 189]), LINES)).toBe('lead');
  });

  it('follows a smooth reveal through every step, and leads once the user turns back', () => {
    const f = new EditorFollow({ line: 0, character: 0 });
    f.reveal({ line: 500, character: 0 }, PADDING, true);
    for (const top of [40, 180, 390, 480, 494, 495]) {
      expect(f.report(ranges([top, top + 39]), LINES), `step to ${top}`).toBe('answer');
    }
    expect(f.report(ranges([470, 509]), LINES)).toBe('lead');
  });

  it('follows a smooth reveal upward to the line above its target', () => {
    const f = new EditorFollow({ line: 800, character: 0 });
    f.reveal({ line: 100, character: 0 }, PADDING, true);
    for (const top of [700, 300, 120, 100, 96, 95]) {
      expect(f.report(ranges([top, top + 39]), LINES), `step to ${top}`).toBe('answer');
    }
  });

  it('is the same place when only its bottom moves', () => {
    const f = new EditorFollow({ line: 50, character: 0 });
    expect(f.report(ranges([50, 80]), LINES)).toBe('same');
  });

  it('is the same place when VS Code keeps its text in place over an edit above it', () => {
    const f = new EditorFollow({ line: 50, character: 0 });
    f.documentChanged([{ from: 2, to: 2, lines: 3 }]);
    expect(f.report(ranges([53, 92]), LINES)).toBe('same');
  });

  it('leaves the top alone for an edit at or below it', () => {
    const f = new EditorFollow({ line: 50, character: 0 });
    f.documentChanged([{ from: 50, to: 50, lines: 1 }]);
    f.documentChanged([{ from: 70, to: 72, lines: 0 }]);
    expect(f.report(ranges([51, 90]), LINES)).toBe('lead');
  });
});

describe('a position moved by an edit', () => {
  it('moves by the lines inserted and removed above it', () => {
    expect(
      shiftedBy({ line: 50, character: 4 }, [
        { from: 1, to: 1, lines: 2 },
        { from: 10, to: 14, lines: 0 },
      ]),
    ).toEqual({ line: 48, character: 4 });
  });

  it('goes to where an edit ends that runs into its line', () => {
    expect(shiftedBy({ line: 50, character: 4 }, [{ from: 40, to: 55, lines: 1 }])).toEqual({
      line: 41,
      character: 0,
    });
  });

  it('counts a change of the same edit that ends on the line where the change it is in starts', () => {
    // The first change ends on line 5, where the second, which runs into the top's line, starts.
    expect(
      shiftedBy({ line: 7, character: 4 }, [
        { from: 3, to: 5, lines: 1 },
        { from: 5, to: 7, lines: 0 },
      ]),
    ).toEqual({ line: 4, character: 0 });
  });
});
