// Lines no writer makes but a file can hold: each parses in about the time its length takes,
// because each syntax looks at a character a bounded number of times.

import { describe, expect, it } from 'vitest';
import { wikilinksIn } from '../../../src/panel/links/read';
import { parserFor } from '../../../src/panel/markdown';
import { testSettings } from '../helpers';

const LENGTH = 100_000;
const parser = parserFor({ ...testSettings, syntax: { tilde: 'strikethrough' } });
const subscript = parserFor({ ...testSettings, syntax: { tilde: 'subscript' } });

describe('a line 100,000 characters long parses', () => {
  for (const [name, unit] of [
    ['notes written in place that never close', '^['],
    ['notes written in place full of brackets', '^[[['],
    ['comment marks that never close', '%% '],
    ['single tildes', 'a~ ~b '],
    ['emoji shapes that share their colons', ':a'],
    ['highlight marks in runs', '+==='],
    ['footnote references to nothing', '[^x]'],
  ] as const) {
    it(name, () => {
      const text = `Start ${unit.repeat(LENGTH / unit.length)}\n`;
      expect(parser.parse(text).length).toBe(text.length);
    });
  }

  it('under subscript, carets and tildes that never close', () => {
    const text = `Start ${'^a ~b '.repeat(LENGTH / 6)}\n`;
    expect(subscript.parse(text).length).toBe(text.length);
  });
});

describe('wikilinks in a long front matter value', () => {
  it('are found in one pass over brackets that never pair', () => {
    const value = `${'[['.repeat(LENGTH / 2)}a]]`;
    expect(wikilinksIn(value, false).map((w) => w.link.target)).toEqual(['a']);
  });
});
