// The place a rich view shows at its top and the scroll position that shows a place, over a
// stand-in for CodeMirror's line blocks, and which scroll events are the user's.
import { describe, expect, it } from 'vitest';
import { heightOfPlace, LeadWatch, placeAtHeight, type Block, type BlockGeometry } from '../../src/panel/scrollFollow';

/**
 * Blocks drawn one under another, each standing for `lines` source lines and `height` pixels
 * tall; every line is 10 characters plus its break.
 */
function geometry(blocks: { lines: number; height: number }[]): BlockGeometry {
  const laid: Block[] = [];
  let top = 0;
  let line = 0;
  for (const b of blocks) {
    laid.push({ from: line * 11, top, height: b.height, firstLine: line, lastLine: line + b.lines - 1 });
    top += b.height;
    line += b.lines;
  }
  const last = laid[laid.length - 1]!;
  return {
    lines: line,
    blockAtHeight: (h) => laid.find((b) => h < b.top + b.height) ?? last,
    blockAtLine: (l) => laid.find((b) => l >= b.firstLine && l <= b.lastLine) ?? last,
  };
}

describe('the place at a rich view’s top', () => {
  const g = geometry([
    { lines: 1, height: 20 }, // line 0
    { lines: 1, height: 60 }, // line 1, wrapped over three rows
    { lines: 10, height: 50 }, // lines 2 to 11, a table drawn short
    { lines: 1, height: 400 }, // line 12, a picture
    { lines: 1, height: 20 }, // line 13
  ]);

  it('is a line and the share of it above the top', () => {
    expect(placeAtHeight(g, 0).line).toBe(0);
    expect(placeAtHeight(g, 10).line).toBe(0.5);
    expect(placeAtHeight(g, 20 + 30).line).toBe(1.5);
  });

  it('passes through a block drawn shorter or taller than its source in proportion', () => {
    // Two fifths into the table's 50 pixels is four of its ten lines.
    expect(placeAtHeight(g, 80 + 20).line).toBeCloseTo(6);
    // A quarter of the way down the picture is a quarter of its one line.
    expect(placeAtHeight(g, 130 + 100).line).toBeCloseTo(12.25);
  });

  it('gives back the height it was read from', () => {
    for (const h of [0, 7, 20, 55, 80, 101.5, 129, 130, 333, 529, 540]) {
      expect(heightOfPlace(g, placeAtHeight(g, h).line), `height ${h}`).toBeCloseTo(h, 6);
    }
  });

  it('shows a place from Source on its own line, in proportion inside a block', () => {
    expect(heightOfPlace(g, 1)).toBe(20);
    expect(heightOfPlace(g, 1 + 1 / 3)).toBeCloseTo(40);
    expect(heightOfPlace(g, 7)).toBeCloseTo(80 + 25);
    expect(heightOfPlace(g, 12)).toBe(130);
  });

  it('keeps a place past the last line or before the first on the document', () => {
    expect(heightOfPlace(g, -3)).toBe(0);
    expect(heightOfPlace(g, 99)).toBe(530 + 20);
  });
});

describe('the user’s scroll and the view’s own', () => {
  const at = (from: number, offset: number, line = 0) => ({ line, from, offset });

  it('takes a scroll after the user acted that puts another place at the top for the user’s', () => {
    const w = new LeadWatch();
    w.reset(at(0, 0));
    w.userActed();
    expect(w.scrolled(at(11, 4))).toBe(true);
    expect(w.scrolled(at(11, 30))).toBe(true);
  });

  it('passes over a scroll event that leaves the same place at the top', () => {
    const w = new LeadWatch();
    w.reset(at(11, 4));
    w.userActed();
    expect(w.scrolled(at(11, 4.6))).toBe(false);
    // The user's place, reported once, is the place to compare with next.
    expect(w.scrolled(at(22, 0))).toBe(true);
    expect(w.scrolled(at(22, 0))).toBe(false);
  });

  it('never takes the scroll events of a follow for the user’s, nor what moves the view after it', () => {
    const w = new LeadWatch();
    w.reset(at(0, 0));
    w.userActed();
    w.begin();
    w.userActed();
    expect(w.scrolled(at(110, 0))).toBe(false);
    expect(w.scrolled(at(220, 0))).toBe(false);
    w.end(at(220, 12));
    // The view settling by a few pixels as lines are measured, and the browser rounding.
    expect(w.scrolled(at(220, 14.5))).toBe(false);
    expect(w.scrolled(at(209, 25.6))).toBe(false);
    w.userActed();
    expect(w.scrolled(at(220, 40))).toBe(true);
  });

  it('takes no scroll for the user’s until the user acts, as when an edit elsewhere moves the text', () => {
    const w = new LeadWatch();
    w.reset(at(110, 3));
    expect(w.scrolled(at(115, 3))).toBe(false);
    expect(w.scrolled(at(330, 0))).toBe(false);
  });

  it('carries the place through an edit above it, so the text moving down is not a scroll', () => {
    const w = new LeadWatch();
    w.reset(at(110, 3));
    w.userActed();
    // Five characters inserted above.
    w.map((pos) => pos + 5);
    expect(w.scrolled(at(115, 3))).toBe(false);
  });

  it('takes the user’s scrolls again once a follow is given up', () => {
    const w = new LeadWatch();
    w.begin();
    w.end(null);
    w.reset(at(33, 0));
    w.userActed();
    expect(w.scrolled(at(33, 0))).toBe(false);
    expect(w.scrolled(at(44, 0))).toBe(true);
  });
});
