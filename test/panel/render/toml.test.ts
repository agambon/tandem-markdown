// The TOML reader behind the front matter's table.
import { describe, expect, it } from 'vitest';
import type { FrontmatterEntry, FrontmatterValue } from '../../../src/panel/render/frontmatter';
import { tomlEntries } from '../../../src/panel/render/toml';

/** Entries as plain data: text as itself, a list as an array, a map as an object. */
function plain(entries: FrontmatterEntry[] | null): unknown {
  if (!entries) return null;
  const value = (v: FrontmatterValue): unknown =>
    v.kind === 'text' ? v.text : v.kind === 'list' ? v.items.map(value) : plain(v.entries);
  return Object.fromEntries(entries.map((e) => [e.name, value(e.value)]));
}

describe('tomlEntries', () => {
  it('keeps every scalar as written and every string as its text', () => {
    const text = [
      'title = "A \\"quoted\\" \\u00e9"',
      "path = 'C:\\Users\\x'",
      'count = 1_000',
      'ratio = 3.0',
      'hex = 0xDEAD_BEEF',
      'big = -inf',
      'on = true',
      'when = 1979-05-27T07:32:00-08:00',
      'local = 1979-05-27 07:32:00',
      'day = 1979-05-27',
      'time = 07:32:00',
    ].join('\n');
    expect(plain(tomlEntries(text))).toEqual({
      title: 'A "quoted" é',
      path: 'C:\\Users\\x',
      count: '1_000',
      ratio: '3.0',
      hex: '0xDEAD_BEEF',
      big: '-inf',
      on: 'true',
      when: '1979-05-27T07:32:00-08:00',
      local: '1979-05-27 07:32:00',
      day: '1979-05-27',
      time: '07:32:00',
    });
  });

  it('reads tables, arrays of tables, dotted and quoted keys, in the order written', () => {
    const text = [
      '# a comment',
      'name = "site"  # after a value',
      'a.b.c = 1',
      '"quoted key" = 2',
      '',
      '[params]',
      'author = "Jane"',
      '',
      '[params.social]',
      'site = "x"',
      '',
      '[[menu.main]]',
      'name = "Home"',
      '[[menu.main]]',
      'name = "About"',
    ].join('\n');
    const entries = tomlEntries(text)!;
    expect(entries.map((e) => e.name)).toEqual(['name', 'a', 'quoted key', 'params', 'menu']);
    expect(plain(entries)).toEqual({
      name: 'site',
      a: { b: { c: '1' } },
      'quoted key': '2',
      params: { author: 'Jane', social: { site: 'x' } },
      menu: { main: [{ name: 'Home' }, { name: 'About' }] },
    });
  });

  it('reads arrays over several lines, nested arrays and inline tables', () => {
    const text = 'tags = [\n  "a", # first\n  "b",\n]\ngrid = [[1, 2], [3]]\npoint = { x = 1, y = "two" }\nempty = {}';
    expect(plain(tomlEntries(text))).toEqual({
      tags: ['a', 'b'],
      grid: [['1', '2'], ['3']],
      point: { x: '1', y: 'two' },
      empty: {},
    });
  });

  it('reads strings over several lines, a backslash at a line end joining them', () => {
    const text = 'a = """\nOne\nTwo"""\nb = """\\\n   joined \\\n   up"""\nc = \'\'\'\nraw \\n\'\'\'';
    expect(plain(tomlEntries(text))).toEqual({ a: 'One\nTwo', b: 'joined up', c: 'raw \\n' });
  });

  it('gives null for what is not TOML, a key written twice, or nothing at all', () => {
    for (const text of [
      'a = valid = no',
      'a = "unclosed',
      'a = 1\na = 2',
      '[t]\n[t]',
      'a = [1, 2',
      'a = word',
      'a = "\\q"',
      'just text',
      '',
      '# only a comment',
    ]) {
      expect(tomlEntries(text), text).toBeNull();
    }
  });
});
