// What a grid table's cells (src/panel/tables/gridCells.ts) give the rest of the file.
import { describe, expect, it } from 'vitest';
import { footnoteIndex } from '../../../src/panel/links/footnotes';
import { stateOf } from '../helpers';

describe("a grid table's notes", () => {
  it('are numbered cell by cell, as Pandoc numbers them, not line by line', () => {
    const text = [
      'Before.',
      '',
      '+-----------+-----------+',
      '| first     | b[^y]     |',
      '| a^[one]   | more      |',
      '+-----------+-----------+',
      '',
      'After^[three].',
      '',
      '[^y]: Why.',
    ].join('\n');
    const index = footnoteIndex(stateOf(text, { mode: 'view' }))!;
    expect(index.inPlaceNumber(text.indexOf('^[one]'))).toBe(1);
    expect(index.number('Y')).toBe(2);
    expect(index.inPlaceNumber(text.indexOf('^[three]'))).toBe(3);
  });
});
