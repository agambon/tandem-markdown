// The outline view's tree of headings, and the heading at the top of the view.

import { describe, expect, it } from 'vitest';
import type { OutlineItem } from '../../../src/core/outline';
import { HeadingFollower, headingAtTop, nestOutline } from '../../../src/host/model/outlineTree';

const heading = (level: number, line: number, text = `H${line}`): OutlineItem => ({
  level,
  text,
  line,
  from: line * 10,
});

describe('nestOutline', () => {
  const shape = (levels: number[]) => {
    const { roots, flat } = nestOutline(levels.map((level, i) => heading(level, i)));
    const draw = (n: (typeof roots)[number]): unknown =>
      n.children.length ? [n.index, n.children.map(draw)] : n.index;
    return { tree: roots.map(draw), flat: flat.map((n) => n.index), parents: flat.map((n) => n.parent?.index ?? null) };
  };

  it('puts each heading under the nearest heading before it with a lower level', () => {
    expect(shape([1, 2, 3, 2, 1]).tree).toEqual([[0, [[1, [2]], 3]], 4]);
    expect(shape([1, 3, 2]).tree).toEqual([[0, [1, 2]]]);
    expect(shape([2, 1, 2]).tree).toEqual([0, [1, [2]]]);
    expect(shape([3, 1]).tree).toEqual([0, 1]);
    expect(shape([2, 2, 2]).tree).toEqual([0, 1, 2]);
    expect(shape([]).tree).toEqual([]);
  });

  it('keeps document order in the flat list, with each heading knowing its parent', () => {
    expect(shape([1, 2, 3, 2, 1]).flat).toEqual([0, 1, 2, 3, 4]);
    expect(shape([1, 2, 3, 2, 1]).parents).toEqual([null, 0, 1, 0, null]);
  });
});

describe('headingAtTop', () => {
  const items = [heading(1, 2), heading(2, 10), heading(2, 20)];

  it('is -1 with no headings, and the first heading above them all', () => {
    expect(headingAtTop([], 5, 0)).toBe(-1);
    expect(headingAtTop(items, 0, 0)).toBe(0);
    expect(headingAtTop(items, 1, 0)).toBe(0);
  });

  it('is the last heading on or above the first line whose start is in view', () => {
    expect(headingAtTop(items, 10, 0)).toBe(1);
    expect(headingAtTop(items, 10, 12)).toBe(1);
    expect(headingAtTop(items, 15, 3)).toBe(1);
    expect(headingAtTop(items, 25, 0)).toBe(2);
    // The top edge inside the line above a heading, as a reveal leaves it: that heading.
    expect(headingAtTop(items, 9, 18)).toBe(1);
    // The top edge at the start of the line above a heading: that line is in view, so the heading before.
    expect(headingAtTop(items, 9, 0)).toBe(0);
  });

  it('reads a missing or broken top line as the top of the file', () => {
    expect(headingAtTop(items, Number.NaN, 0)).toBe(0);
    expect(headingAtTop(items, -4, 0)).toBe(0);
    expect(headingAtTop(items, 10, Number.NaN)).toBe(1);
  });
});

describe('HeadingFollower', () => {
  it('follows the heading at the top when nothing was chosen', () => {
    const f = new HeadingFollower();
    expect(f.target(3)).toBe(3);
    f.viewStateReported(40);
    expect(f.target(1)).toBe(1);
  });

  it('keeps a chosen heading while the panel settles on it, until the reader scrolls', () => {
    const f = new HeadingFollower();
    f.choose(5, 2);
    expect(f.target(2)).toBe(5);
    // The panel scrolls as far as it can (the end of the file) and reports it.
    f.viewStateReported(80);
    expect(f.target(3)).toBe(5);
    // A selection change at the same top line keeps it.
    f.viewStateReported(80);
    expect(f.target(3)).toBe(5);
    // The reader scrolls.
    f.viewStateReported(70);
    expect(f.target(2)).toBe(2);
  });

  it('needs to keep nothing when the chosen heading is already the one at the top', () => {
    const f = new HeadingFollower();
    f.choose(2, 2);
    f.viewStateReported(30);
    f.viewStateReported(31);
    expect(f.target(1)).toBe(1);
  });

  it('drops a choice on reset', () => {
    const f = new HeadingFollower();
    f.choose(4, 0);
    f.reset();
    expect(f.target(0)).toBe(0);
  });
});
