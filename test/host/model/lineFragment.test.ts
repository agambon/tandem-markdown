// The line a link's `#L` fragment names.

import { describe, expect, it } from 'vitest';
import { findLine } from '../../../src/host/model/lineFragment';

describe('findLine', () => {
  const text = 'one\ntwo\nthree\n';

  it('finds the line a fragment names, with or without the L, in either case', () => {
    expect(findLine(text, 'L1')).toBe(0);
    expect(findLine(text, 'L2')).toBe(text.indexOf('two'));
    expect(findLine(text, '3')).toBe(text.indexOf('three'));
    expect(findLine(text, 'l3')).toBe(text.indexOf('three'));
  });

  it('goes to the first line of a range, and ignores a column', () => {
    expect(findLine(text, 'L2,3')).toBe(text.indexOf('two'));
    expect(findLine(text, 'L2-L3')).toBe(text.indexOf('two'));
    expect(findLine(text, 'L2,1-L3,4')).toBe(text.indexOf('two'));
  });

  it('takes a line past the end as the last line', () => {
    expect(findLine(text, 'L99')).toBe(text.length);
    expect(findLine('no newline', 'L5')).toBe(0);
  });

  it('reads no line from a heading name, line zero or an empty fragment', () => {
    expect(findLine(text, 'usage')).toBe(-1);
    expect(findLine(text, 'L2x')).toBe(-1);
    expect(findLine(text, 'L0')).toBe(-1);
    expect(findLine(text, '')).toBe(-1);
  });
});
