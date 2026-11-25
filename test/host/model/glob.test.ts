// Globs read as regular expressions over a path, as VS Code reads them.

import { describe, expect, it } from 'vitest';
import { extensionsGlob, globToRegExp } from '../../../src/host/model/glob';

describe('globToRegExp', () => {
  it('reads globs as VS Code does', () => {
    expect(globToRegExp('**/*.md').test('a/b/c.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('c.md')).toBe(true);
    expect(globToRegExp('*.md').test('deep/c.md')).toBe(true);
    expect(globToRegExp('docs/*.{md,markdown}').test('docs/a.markdown')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/x/a.md')).toBe(false);
  });

  it('reads a range of characters as VS Code does, and one it cannot read as matching nothing', () => {
    expect(globToRegExp('202[0-9]-*.md').test('2024-trip.md')).toBe(true);
    expect(globToRegExp('202[0-9]-*.md').test('202x-trip.md')).toBe(false);
    expect(globToRegExp('[!_]*.md').test('draft.md')).toBe(true);
    expect(globToRegExp('[!_]*.md').test('_draft.md')).toBe(false);
    expect(globToRegExp('[]{]*.md').test('{a.md')).toBe(true);
    expect(globToRegExp('[z-a].md').test('b.md')).toBe(false);
    expect(globToRegExp(']a.md').test(']a.md')).toBe(false);
    expect(globToRegExp('').test('')).toBe(false);
  });

  it('treats ** as a globstar only when it is a whole path segment, as VS Code does', () => {
    expect(globToRegExp('a**b.md').test('axxb.md')).toBe(true);
    expect(globToRegExp('a**b.md').test('dir/axxb.md')).toBe(true);
    expect(globToRegExp('a**b.md').test('a/b.md')).toBe(false);
    expect(globToRegExp('docs/a**b.md').test('docs/axb.md')).toBe(true);
    expect(globToRegExp('docs/a**b.md').test('docs/a/b.md')).toBe(false);
    expect(globToRegExp('docs/**/**/a.md').test('docs/x/y/a.md')).toBe(true);
    expect(globToRegExp('docs/**/**/a.md').test('docs/a.md')).toBe(true);
  });

  it('matches trailing **/ and /** patterns and slash-bearing braces as VS Code does', () => {
    expect(globToRegExp('**/').test('a.md')).toBe(true);
    expect(globToRegExp('**/').test('docs/sub/a.md')).toBe(true);
    expect(globToRegExp('docs/**/').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/**/').test('docs/sub/a.md')).toBe(true);
    expect(globToRegExp('docs/**/').test('other/a.md')).toBe(false);
    expect(globToRegExp('docs/**').test('docs/sub/a.md')).toBe(true);
    expect(globToRegExp('{docs/*.md,notes/**/*.markdown}').test('docs/a.md')).toBe(true);
    expect(globToRegExp('{docs/*.md,notes/**/*.markdown}').test('docs/sub/a.md')).toBe(false);
    expect(globToRegExp('{docs/*.md,notes/**/*.markdown}').test('notes/a.markdown')).toBe(true);
    expect(globToRegExp('{docs/*.md,notes/**/*.markdown}').test('notes/sub/deep/a.markdown')).toBe(true);
    expect(globToRegExp('file:/**/{docs,notes}/*.md').test('file:/w/notes/a.md')).toBe(true);
    expect(globToRegExp('file:/**/{docs,notes}/*.md').test('file:/w/other/a.md')).toBe(false);
  });
});

describe('extensionsGlob', () => {
  it('names each extension in any letter case', () => {
    const glob = extensionsGlob(['md', 'markdown']);
    expect(glob.startsWith('**/*.{') && glob.endsWith('}')).toBe(true);
    // Read with letter case, as findFiles reads it.
    const alternatives = glob.slice('**/*.{'.length, -1).split(',').join('|');
    const withCase = new RegExp(`\\.(?:${alternatives})$`);
    for (const name of ['a.md', 'a.MD', 'a.Md', 'b/c.MarkDown']) expect(withCase.test(name), name).toBe(true);
    for (const name of ['a.mdx', 'a.txt', 'a.m']) expect(withCase.test(name), name).toBe(false);
  });
});
