// Front matter drawing without a browser: the names and values read from the YAML, and what
// each display setting draws.

import type { EditorState } from '@codemirror/state';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Mode, PanelSettings } from '../../../src/core/protocol';
import { createEditorState } from '../../../src/panel/editor';
import { withFullTree } from '../../../src/panel/render/framework';
import { frontmatterEntries, yamlReader } from '../../../src/panel/render/frontmatter';
import { drawn, fakeContext } from '../helpers';

function stateOf(
  text: string,
  options: { mode?: Mode; cursor?: number; display?: PanelSettings['frontmatterDisplay'] } = {},
): EditorState {
  const ctx = fakeContext({ settings: { frontmatterDisplay: options.display ?? 'table' } }).ctx;
  const at = options.cursor ?? text.length;
  return withFullTree(
    createEditorState({ ctx, text, mode: options.mode ?? 'edit', selection: { anchor: at, head: at } }),
  );
}

function fm(state: EditorState) {
  return drawn(state)
    .filter((d) => d.feature === 'frontmatter')
    .map((d) => ({ kind: d.kind, from: d.from, to: d.to, className: d.className, widget: d.widget }));
}

beforeAll(() => yamlReader.load());

const NESTED = `---
title: My note
version: 3.0
empty:
tags: [one, two]
links:
  - x
  - k: v
    z: 2
nested:
  a: 1
  b:
    c: deep
block: |
  line one
  line two
quoted: "a \\"b\\""
---

Body text.
`;

describe('reading the YAML', () => {
  it('gives names and values, nested maps as maps and lists as lists, scalars as written', () => {
    const yaml = NESTED.split('\n').slice(1, -4).join('\n');
    expect(frontmatterEntries(yaml)).toEqual([
      { name: 'title', value: { kind: 'text', text: 'My note' } },
      { name: 'version', value: { kind: 'text', text: '3.0' } },
      { name: 'empty', value: { kind: 'text', text: '' } },
      {
        name: 'tags',
        value: {
          kind: 'list',
          items: [
            { kind: 'text', text: 'one' },
            { kind: 'text', text: 'two' },
          ],
        },
      },
      {
        name: 'links',
        value: {
          kind: 'list',
          items: [
            { kind: 'text', text: 'x' },
            {
              kind: 'map',
              entries: [
                { name: 'k', value: { kind: 'text', text: 'v' } },
                { name: 'z', value: { kind: 'text', text: '2' } },
              ],
            },
          ],
        },
      },
      {
        name: 'nested',
        value: {
          kind: 'map',
          entries: [
            { name: 'a', value: { kind: 'text', text: '1' } },
            { name: 'b', value: { kind: 'map', entries: [{ name: 'c', value: { kind: 'text', text: 'deep' } }] } },
          ],
        },
      },
      { name: 'block', value: { kind: 'text', text: 'line one\nline two' } },
      { name: 'quoted', value: { kind: 'text', text: 'a "b"' } },
    ]);
  });

  it('gives nothing for YAML that does not parse or is not a map of names', () => {
    expect(frontmatterEntries('a: [1, 2')).toBeNull();
    expect(frontmatterEntries('a: b: c')).toBeNull();
    expect(frontmatterEntries('- a\n- b')).toBeNull();
    expect(frontmatterEntries('just text')).toBeNull();
    expect(frontmatterEntries('')).toBeNull();
  });
});

describe('drawing front matter', () => {
  const end = NESTED.indexOf('---\n\nBody') + 3;

  it('replaces exactly its lines with a table', () => {
    expect(fm(stateOf(NESTED))).toEqual([
      { kind: 'replaceLines', from: 0, to: end, className: '', widget: 'FrontmatterTable' },
    ]);
  });

  it('shows the raw text while the selection is in it, and only in Rich editor', () => {
    // Shown as text: each of its lines styled, none replaced or hidden.
    const items = fm(stateOf(NESTED, { cursor: 10 }));
    expect(items.every((d) => d.kind === 'line')).toBe(true);
    expect(items.length).toBe(NESTED.slice(0, end).split('\n').length);
    expect(fm(stateOf(NESTED, { cursor: 10, mode: 'view' })).map((d) => d.widget)).toEqual(['FrontmatterTable']);
  });

  it('shows YAML that does not parse as its text, with no error', () => {
    const text = '---\ntitle: [unclosed\n---\n\nBody\n';
    const { ctx, logs } = fakeContext({ settings: { frontmatterDisplay: 'table' } });
    const state = withFullTree(
      createEditorState({ ctx, text, mode: 'edit', selection: { anchor: text.length, head: text.length } }),
    );
    const items = fm(state);
    expect(items.map((d) => d.kind)).toEqual(['line', 'line', 'line']);
    expect(logs.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('draws nothing for a file that starts with a rule that is not front matter', () => {
    const state = stateOf('---\n\nText under a rule.\n');
    expect(fm(state)).toEqual([]);
    expect(drawn(state).some((d) => d.feature === 'rules')).toBe(true);
  });

  it('follows settings.frontmatterDisplay', () => {
    expect(
      fm(stateOf(NESTED, { display: 'source' })).every((d) => d.kind === 'line' && !d.className.includes('open')),
    ).toBe(true);
    expect(fm(stateOf(NESTED, { display: 'hidden', mode: 'view' }))).toEqual([
      { kind: 'hideLines', from: 0, to: end, className: '', widget: undefined },
    ]);
    expect(fm(stateOf(NESTED, { display: 'hidden' })).map((d) => d.widget)).toEqual(['FrontmatterBar']);
    expect(fm(stateOf(NESTED, { display: 'hidden', cursor: 10 })).every((d) => d.kind === 'line')).toBe(true);
  });
});
