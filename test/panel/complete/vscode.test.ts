// Where the panel asks VS Code for suggestions: only where a link's address or a reference is
// being typed.

import { describe, expect, it } from 'vitest';
import { typedPart } from '../../../src/panel/complete/vscode';

describe('the places that ask VS Code for suggestions', () => {
  it("finds the part of a link's or picture's address typed so far", () => {
    expect(typedPart('See [the notes](')).toBe('');
    expect(typedPart('See [the notes](./notes/to')).toBe('./notes/to');
    expect(typedPart('![a picture](img/')).toBe('img/');
    expect(typedPart('[a heading](#intro')).toBe('#intro');
    expect(typedPart('[x](<my file')).toBe('my file');
    expect(typedPart('[x](my file')).toBeNull();
  });

  it("finds a reference definition's address and a reference link's label", () => {
    expect(typedPart('[notes]: ./no')).toBe('./no');
    expect(typedPart('   [notes]:')).toBe('');
    expect(typedPart('[notes]: <my no')).toBe('my no');
    expect(typedPart('See [the notes][no')).toBe('no');
  });

  it('finds an HTML src or href', () => {
    expect(typedPart('<img src="img/pi')).toBe('img/pi');
    expect(typedPart("<a href='./do")).toBe('./do');
  });

  it('finds nothing in ordinary text, after a finished link, or in a link title', () => {
    expect(typedPart('Plain words (in parentheses')).toBeNull();
    expect(typedPart('[x](done.md) and more')).toBeNull();
    expect(typedPart('[x](done.md "a title')).toBeNull();
    expect(typedPart('[[Wikilink')).toBeNull();
    expect(typedPart('    [indented]: code')).toBeNull();
  });

  it('looks only at the end of a long line', () => {
    expect(typedPart(`${'x'.repeat(5000)} [a](./b`)).toBe('./b');
    expect(typedPart(`[a](${'y'.repeat(5000)}`)).toBeNull();
  });
});
