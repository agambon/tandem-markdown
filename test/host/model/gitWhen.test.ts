// When git explains another program's write to a note, so that no conflict file is written for it.

import { describe, expect, it } from 'vitest';
import { committedBefore, sameText } from '../../../src/host/model/gitWhen';

const WRITE = Date.UTC(2026, 10, 17, 10, 31, 5, 400);

describe("git's check of a write", () => {
  it('explains a write whose text was committed before it reached the file (a checkout, a pull)', () => {
    expect(committedBefore(new Date(Date.UTC(2026, 10, 16, 9, 0, 0)), WRITE)).toBe(true);
    expect(committedBefore(new Date(Date.UTC(2026, 10, 17, 10, 31, 4)), WRITE)).toBe(true);
  });

  it('does not explain an agent that commits its own write after making it', () => {
    expect(committedBefore(new Date(Date.UTC(2026, 10, 17, 10, 31, 9)), WRITE)).toBe(false);
  });

  it('counts a commit in the same second as the write as later, since git gives whole seconds', () => {
    expect(committedBefore(new Date(Date.UTC(2026, 10, 17, 10, 31, 5)), WRITE)).toBe(false);
  });

  it('does not explain a write when git gives no commit date', () => {
    expect(committedBefore(undefined, WRITE)).toBe(false);
    expect(committedBefore(new Date(Number.NaN), WRITE)).toBe(false);
  });

  it('compares texts whatever their line endings', () => {
    expect(sameText('a\r\nb\r\n', 'a\nb\n')).toBe(true);
    expect(sameText('a\nb\n', 'a\nc\n')).toBe(false);
  });
});
