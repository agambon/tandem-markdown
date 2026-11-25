import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdownLanguage, parserFor } from '../../../src/panel/markdown';
import { testSettings } from '../helpers';
import { find, findIn, topLevel } from './treeHelpers';

describe('frontmatter', () => {
  it('reads a block that opens on line 1 and closes with ---', () => {
    const text = '---\ntitle: x\ntags: [a]\n---\n# Head\n';
    const [fm] = find(text, 'Frontmatter');
    expect(fm!.text).toBe('---\ntitle: x\ntags: [a]\n---');
    expect(find(text, 'FrontmatterMark').map((m) => m.from)).toEqual([0, 23]);
    expect(topLevel(text)).toEqual(['Frontmatter', 'ATXHeading1']);
  });

  it('closes with ... as well', () => {
    expect(find('---\na: 1\n...\ntext', 'Frontmatter')[0]!.text).toBe('---\na: 1\n...');
  });

  it('is never a rule plus a Setext heading', () => {
    const text = '---\ntitle: x\n---\n';
    expect(find(text, 'HorizontalRule', 'SetextHeading2', 'Paragraph')).toEqual([]);
  });

  it('keeps blank lines and markdown-looking lines inside', () => {
    const text = '---\n# not a heading\n\n- not a list\n---\nafter';
    expect(find(text, 'Frontmatter')[0]!.text).toBe('---\n# not a heading\n\n- not a list\n---');
    expect(find(text, 'ATXHeading1', 'BulletList')).toEqual([]);
  });

  it('allows an empty block', () => {
    expect(find('---\n---\nx', 'Frontmatter')[0]!.text).toBe('---\n---');
  });

  it('is not front matter when unclosed', () => {
    const text = '---\ntitle: x\n\nBody';
    expect(find(text, 'Frontmatter')).toEqual([]);
    expect(topLevel(text)[0]).toBe('HorizontalRule');
  });

  it('is not front matter when line 1 is not exactly ---', () => {
    expect(find('--- \na: 1\n---\n', 'Frontmatter')).toEqual([]);
    expect(find('----\na: 1\n---\n', 'Frontmatter')).toEqual([]);
    expect(find(' ---\na: 1\n---\n', 'Frontmatter')).toEqual([]);
  });

  it('is not front matter in the middle of a file', () => {
    const text = 'Intro\n\n---\ntitle: x\n---\n';
    expect(find(text, 'Frontmatter')).toEqual([]);
    expect(find(text, 'HorizontalRule').length).toBe(1);
    expect(find(text, 'SetextHeading2').length).toBe(1);
  });

  it('a closing line with trailing spaces does not close it', () => {
    expect(find('---\na: 1\n--- \nb\n', 'Frontmatter')).toEqual([]);
  });

  // Lezer reuses old nodes after an edit; front matter depends on a later line.
  // The body is long enough that Lezer would otherwise reuse line 1's rule from the old tree.
  it('appears when the closing line is typed later, and goes when it is removed', () => {
    const body = Array.from({ length: 30 }, (_, i) => `key${i}: value ${i}`).join('\n\n');
    let state = EditorState.create({ doc: `---\n${body}\n\nBody text`, extensions: markdownLanguage() });
    const tree = (s: EditorState) => ensureSyntaxTree(s, s.doc.length, 5000)!;
    expect(findIn(tree(state), state.doc.toString(), ['Frontmatter'])).toEqual([]);

    // Type the closing line one character at a time on the empty line before "Body text".
    const at = state.doc.line(state.doc.lines - 1).from;
    for (let i = 0; i < 3; i++) {
      state = state.update({ changes: { from: at, insert: '-' } }).state;
      tree(state);
    }
    const text = state.doc.toString();
    expect(text).toBe(`---\n${body}\n---\nBody text`);
    expect(findIn(tree(state), text, ['Frontmatter']).map((n) => n.text)).toEqual([`---\n${body}\n---`]);
    expect(findIn(tree(state), text, ['HorizontalRule', 'SetextHeading2', 'Paragraph']).map((n) => n.text)).toEqual([
      'Body text',
    ]);

    state = state.update({ changes: { from: at, to: at + 3 } }).state;
    expect(findIn(tree(state), state.doc.toString(), ['Frontmatter'])).toEqual([]);
  });

  it('a later edit below the block keeps it', () => {
    let state = EditorState.create({ doc: '---\na: 1\n---\n\npara', extensions: markdownLanguage() });
    state = state.update({ changes: { from: state.doc.length, insert: ' more' } }).state;
    const text = state.doc.toString();
    expect(findIn(ensureSyntaxTree(state, text.length, 5000)!, text, ['Frontmatter']).length).toBe(1);
  });
});

describe('frontmatter in other forms', () => {
  const blocks = (text: string, syntax: Record<string, boolean> = {}) =>
    findIn(parserFor({ ...testSettings, syntax }).parse(text), text, ['Frontmatter']).map((n) => n.text);

  it('reads TOML between +++ lines, with its two marks, unless its setting is off', () => {
    const text = '+++\ntitle = "x"\n+++\n# Head';
    expect(blocks(text)).toEqual(['+++\ntitle = "x"\n+++']);
    expect(find(text, 'FrontmatterMark').map((m) => m.text)).toEqual(['+++', '+++']);
    expect(blocks(text, { tomlFrontmatter: false })).toEqual([]);
  });

  it('reads JSON between ;;; lines and a bare object only when its setting is on', () => {
    const fenced = ';;;\n{ "a": 1 }\n;;;\nText';
    const bare = '{\n  "a": [1, {"b": "}"}]\n}\nText';
    expect(blocks(fenced)).toEqual([]);
    expect(blocks(bare)).toEqual([]);
    expect(blocks(fenced, { jsonFrontmatter: true })).toEqual([';;;\n{ "a": 1 }\n;;;']);
    expect(blocks(bare, { jsonFrontmatter: true })).toEqual(['{\n  "a": [1, {"b": "}"}]\n}']);
    expect(blocks('{ "title": "One line" }\nText', { jsonFrontmatter: true })).toEqual(['{ "title": "One line" }']);
  });

  it('a bare object must parse, hold a name, and end its line', () => {
    for (const text of ['{not json}\nText', '{}\nText', '{ "a": 1 } trailing\nText', '[1, 2]\nText', ' { "a": 1 }']) {
      expect(blocks(text, { jsonFrontmatter: true }), text).toEqual([]);
    }
  });

  it('is never read below the top', () => {
    expect(blocks('Text\n\n+++\na = 1\n+++')).toEqual([]);
  });

  it('appears when the closing +++ is typed later', () => {
    const body = Array.from({ length: 30 }, (_, i) => `key${i} = ${i}`).join('\n\n');
    let state = EditorState.create({ doc: `+++\n${body}\n\nBody text`, extensions: markdownLanguage() });
    const tree = (s: EditorState) => ensureSyntaxTree(s, s.doc.length, 5000)!;
    expect(findIn(tree(state), state.doc.toString(), ['Frontmatter'])).toEqual([]);
    const at = state.doc.line(state.doc.lines - 1).from;
    for (let i = 0; i < 3; i++) {
      state = state.update({ changes: { from: at, insert: '+' } }).state;
      tree(state);
    }
    expect(findIn(tree(state), state.doc.toString(), ['Frontmatter']).map((n) => n.text)).toEqual([
      `+++\n${body}\n+++`,
    ]);
  });
});
