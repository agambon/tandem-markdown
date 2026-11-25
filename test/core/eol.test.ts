// Every position, hash, diff and merge is over LF text.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toLf } from '../../src/core/eol';
import { seeded } from '../random';

describe('toLf', () => {
  it('turns every CRLF and every lone CR into LF', () => {
    expect(toLf('a\r\nb\r\n')).toBe('a\nb\n');
    expect(toLf('a\rb\n')).toBe('a\nb\n');
    expect(toLf('a\r\r\nb')).toBe('a\n\nb'); // a lone CR, then a CRLF: two line breaks
    expect(toLf('\r')).toBe('\n');
    expect(toLf('a\n\rb')).toBe('a\n\nb');
    expect(toLf('')).toBe('');
    expect(toLf('no breaks')).toBe('no breaks');
  });

  it('keeps every line: the lines are those VS Code sees (split on CRLF, CR or LF)', () => {
    const unit = fc.constantFrom('a', ' ', '\r', '\n', '\r\n', '😀');
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 80 }), (s) => {
        const lf = toLf(s);
        expect(lf).not.toContain('\r');
        expect(lf.split('\n')).toEqual(s.split(/\r\n|\r|\n/));
        expect(toLf(lf)).toBe(lf);
        if (!s.includes('\r')) expect(lf).toBe(s);
      }),
      seeded(),
    );
  });
});
