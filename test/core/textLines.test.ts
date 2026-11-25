// The search of a sorted list of offsets.

import { describe, expect, it } from 'vitest';
import { firstFrom } from '../../src/core/textLines';

describe('firstFrom', () => {
  it('finds the first entry at or after a value, or -1', () => {
    expect(firstFrom([2, 5, 9], 0)).toBe(2);
    expect(firstFrom([2, 5, 9], 5)).toBe(5);
    expect(firstFrom([2, 5, 9], 6)).toBe(9);
    expect(firstFrom([2, 5, 9], 10)).toBe(-1);
    expect(firstFrom([], 0)).toBe(-1);
  });
});
