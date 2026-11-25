import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdownLanguage } from '../../../src/panel/markdown';
import { find, findIn, topLevel } from './treeHelpers';

const definitions = (text: string) => find(text, 'Definition').map((n) => n.text);

describe('definition lists', () => {
  it('reads a term and its definition (Pandoc, PHP Markdown Extra)', () => {
    const text = 'Term\n: Its definition\n\nAfter';
    expect(topLevel(text)).toEqual(['DefinitionList', 'Paragraph']);
    expect(find(text, 'DefinitionList', 'Paragraph').map((n) => `${n.name}:${n.text}`)).toEqual([
      'DefinitionList:Term\n: Its definition',
      'Paragraph:Term',
      'Paragraph:Its definition',
      'Paragraph:After',
    ]);
    expect(find(text, 'DefinitionMark').map((n) => n.text)).toEqual([':']);
  });

  it('allows a blank line between term and definition, and several definitions', () => {
    const text = 'Term\n\n:   First\n\n:   Second\n    continued\n\nNext';
    expect(topLevel(text)).toEqual(['DefinitionList', 'Paragraph']);
    expect(definitions(text)).toEqual([':   First', ':   Second\n    continued']);
  });

  it('holds blocks indented to its text', () => {
    const text = 'Term\n:   First paragraph.\n\n    - a list\n    - in it\n\nOut';
    expect(find(text, 'Definition', 'BulletList').map((n) => n.name)).toEqual(['Definition', 'BulletList']);
    expect(topLevel(text)).toEqual(['DefinitionList', 'Paragraph']);
  });

  it('reads one inside a list item and inside a quote', () => {
    expect(find('- Term\n  : Def', 'Definition').length).toBe(1);
    expect(find('> Term\n> : Def', 'Definition').length).toBe(1);
  });

  it('needs a one-line term just before it', () => {
    expect(definitions(': no term')).toEqual([]);
    expect(definitions('Two lines\nof text\n: not a definition')).toEqual([]);
    expect(definitions('# Heading\n: not a definition')).toEqual([]);
    expect(definitions('Term\n\n\n: two blank lines')).toEqual([]);
    expect(definitions('- item\n\n: after a list')).toEqual([]);
  });

  it('needs a space after the colon', () => {
    expect(definitions('Term\n:no space')).toEqual([]);
    expect(definitions('Ratio\n:: double')).toEqual([]);
  });

  it('a colon line inside a paragraph of several lines stays its text', () => {
    expect(find('One\nTwo\n: three', 'Paragraph').map((n) => n.text)).toEqual(['One\nTwo\n: three']);
  });

  // The term looks down for its definition; Lezer reuses old nodes after an edit.
  it('appears when a definition is typed below a term, past a blank line, and stays while it is edited', () => {
    const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of plain words.`).join('\n\n');
    let state = EditorState.create({ doc: `${body}\n\nTerm\n\n\n\n${body}`, extensions: markdownLanguage() });
    const tree = (s: EditorState) => ensureSyntaxTree(s, s.doc.length, 5000)!;
    const lists = () => findIn(tree(state), state.doc.toString(), ['Definition']).map((n) => n.text);
    expect(lists()).toEqual([]);
    const at = state.doc.toString().indexOf('Term\n\n') + 6;
    for (const ch of ': It means') {
      state = state.update({ changes: { from: state.doc.lineAt(at).to, insert: ch } }).state;
      tree(state);
    }
    expect(lists()).toEqual([': It means']);
    const end = state.doc.lineAt(at).to;
    state = state.update({ changes: { from: end, insert: '\n  more of it\n\n  and more' } }).state;
    tree(state);
    state = state.update({ changes: { from: state.doc.lineAt(end + 20).to, insert: ' still' } }).state;
    expect(lists()).toEqual([': It means\n  more of it\n\n  and more still']);
  });
});
