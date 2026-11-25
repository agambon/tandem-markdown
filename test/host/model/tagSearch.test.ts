// What VS Code's search is given to find a tag in the workspace's markdown files.

import { describe, expect, it } from 'vitest';
import { tagMayFollow, tagNameLength } from '../../../src/core/markdownText';
import { isSearchableTag, tagSearchPattern } from '../../../src/host/model/tagSearch';

/** The PCRE2 pattern as a JavaScript one, which reads the same look-arounds. */
function asJs(tag: string): RegExp {
  return new RegExp(tagSearchPattern(tag).replace(/\\x\{([0-9A-F]+)\}/g, '\\u{$1}'), 'imu');
}

describe('searching for a tag', () => {
  it('finds the tag after a line start or a space, in any letter case', () => {
    const find = asJs('project');
    expect(find.test('#project')).toBe(true);
    expect(find.test('Plan #Project here')).toBe(true);
    expect(find.test('a\n#project, b')).toBe(true);
  });

  it('finds the nested tags under it, and not a longer tag or a tag inside a word', () => {
    const find = asJs('area');
    expect(find.test('see #area/sub')).toBe(true);
    expect(find.test('see #areas')).toBe(false);
    expect(find.test('see #area-two')).toBe(false);
    expect(find.test('page#area')).toBe(false);
  });

  it('accepts what the panel reads as a tag, and nothing else', () => {
    expect(isSearchableTag('area/sub')).toBe(true);
    expect(isSearchableTag('日本語')).toBe(true);
    expect(isSearchableTag('ff0000')).toBe(true);
    expect(isSearchableTag('1984')).toBe(false);
    expect(isSearchableTag('two words')).toBe(false);
    expect(isSearchableTag('a(b)')).toBe(false);
    expect(isSearchableTag('')).toBe(false);
  });
});

describe('the search pattern and the panel', () => {
  it('start and end a tag at the same characters', () => {
    const find = asJs('a');
    const differ: string[] = [];
    for (let code = 0; code < 0x10000; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const c = String.fromCharCode(code);
      if (find.test(`#a${c}`) !== (c === '/' || tagNameLength(`a${c}`, 0) === 1))
        differ.push(`after ${code.toString(16)}`);
      if (find.test(`x${c}#a`) !== tagMayFollow(c)) differ.push(`before ${code.toString(16)}`);
    }
    expect(differ).toEqual([]);
  });
});
