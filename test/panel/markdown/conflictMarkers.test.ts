import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdownLanguage, parserFor } from '../../../src/panel/markdown';
import { readConflict } from '../../../src/panel/markdown/conflictMarkers';
import { testSettings } from '../helpers';
import { find, findIn, topLevel } from './treeHelpers';

const CONFLICT = '<<<<<<< HEAD\nBudget: 4,200.\n=======\nBudget: 4,500.\n>>>>>>> north-wall';

const blocks = (text: string) => find(text, 'ConflictBlock').map((n) => n.text);

describe("git's conflict markers", () => {
  it('read as one block, its marker lines marked, never as a heading', () => {
    const text = `Before.\n\n${CONFLICT}\n\nAfter.`;
    expect(topLevel(text)).toEqual(['Paragraph', 'ConflictBlock', 'Paragraph']);
    expect(blocks(text)).toEqual([CONFLICT]);
    expect(find(text, 'ConflictMark').map((n) => n.text)).toEqual(['<<<<<<< HEAD', '=======', '>>>>>>> north-wall']);
    expect(find(text, 'SetextHeading1')).toEqual([]);
  });

  it('end the paragraph and the list above them', () => {
    expect(topLevel(`Text\n${CONFLICT}\nMore`)).toEqual(['Paragraph', 'ConflictBlock', 'Paragraph']);
    expect(topLevel(`- item\n${CONFLICT}`)).toEqual(['BulletList', 'ConflictBlock']);
    expect(topLevel(`> quote\n${CONFLICT}`)).toEqual(['Blockquote', 'ConflictBlock']);
  });

  it('hold the part as it was before either change, when git writes it', () => {
    const text = '<<<<<<< ours\na\n||||||| 1a2b3c4\nbase\n=======\nb\n>>>>>>> theirs';
    expect(blocks(text)).toEqual([text]);
    expect(find(text, 'ConflictMark')).toHaveLength(4);
  });

  it('take the length of the first marker, as conflict-marker-size sets it', () => {
    const text = '<<<<<<<<< HEAD\nTitle\n=======\nmore\n=========\nb\n>>>>>>>>> x';
    expect(blocks(text)).toEqual([text]);
    expect(readConflict(text)!.current.lines).toEqual(['Title', '=======', 'more']);
  });

  it('are text inside a code block', () => {
    const text = `\`\`\`\n${CONFLICT}\n\`\`\``;
    expect(blocks(text)).toEqual([]);
    expect(blocks(`    <<<<<<< HEAD\n    a\n    =======\n    b\n    >>>>>>> x`)).toEqual([]);
  });

  it('are text inside a quote or a list item, which git never writes', () => {
    expect(blocks('> <<<<<<< HEAD\n> a\n> =======\n> b\n> >>>>>>> x')).toEqual([]);
    expect(blocks('- <<<<<<< HEAD\n  a\n  =======\n  b\n  >>>>>>> x')).toEqual([]);
  });

  it('are text without every marker in its place', () => {
    expect(blocks('<<<<<<< HEAD\na\n=======\nb')).toEqual([]);
    expect(blocks('<<<<<<< HEAD\na\n>>>>>>> x\n=======\nb')).toEqual([]);
    expect(blocks('<<<<<<< HEAD\na\nb\n>>>>>>> x')).toEqual([]);
    expect(blocks('<<<<<<<HEAD\na\n=======\nb\n>>>>>>> x')).toEqual([]);
    expect(blocks('<<<<<< HEAD\na\n======\nb\n>>>>>> x')).toEqual([]);
  });

  it('take the second of two openers when the first is not closed before it', () => {
    const text = `<<<<<<< stray\nwords\n${CONFLICT}`;
    expect(blocks(text)).toEqual([CONFLICT]);
  });

  it('are read as any other markdown with their setting off', () => {
    const tree = parserFor({ ...testSettings, syntax: { conflictMarkers: false } }).parse(CONFLICT);
    expect(findIn(tree, CONFLICT, ['ConflictBlock'])).toEqual([]);
    expect(findIn(tree, CONFLICT, ['SetextHeading1'])).toHaveLength(1);
  });

  it('come and go as their closing line far below goes and comes back, in an editor that parses again', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}.\n`).join('\n');
    const incoming = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const doc = `${filler}\n<<<<<<< HEAD\na\n=======\n${incoming}\n>>>>>>> x\n\n${filler}`;
    const count = (s: EditorState) => {
      let n = 0;
      ensureSyntaxTree(s, s.doc.length, 5000)!.iterate({
        enter: (node) => {
          if (node.name === 'ConflictBlock') n++;
        },
      });
      return n;
    };
    const closer = doc.indexOf('>>>>>>> x');
    const line = { from: closer, to: closer + '>>>>>>> x\n'.length };
    const state = EditorState.create({ doc, extensions: [markdownLanguage()] });
    const without = state.update({ changes: line }).state;
    const back = without.update({ changes: { from: closer, insert: '>>>>>>> x\n' } }).state;
    expect([count(state), count(without), count(back)]).toEqual([1, 0, 1]);
  });

  it('start at the opener above when the opener below it is deleted, in an editor that parses again', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const doc = `Intro.\n\n<<<<<<< stray\n\n${filler}\n\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n`;
    const state = EditorState.create({ doc, extensions: [markdownLanguage()] });
    const opener = doc.indexOf('<<<<<<< HEAD');
    const without = state.update({ changes: { from: opener, to: opener + '<<<<<<< HEAD\n'.length } }).state;
    const starts = (s: EditorState) => {
      const out: number[] = [];
      ensureSyntaxTree(s, s.doc.length, 5000)!.iterate({
        enter: (node) => {
          if (node.name === 'ConflictBlock') out.push(node.from);
        },
      });
      return out;
    };
    expect(starts(state)).toEqual([opener]);
    expect(starts(without)).toEqual([doc.indexOf('<<<<<<< stray')]);
  });
});

describe('readConflict', () => {
  it('gives each side its name and its lines', () => {
    expect(readConflict(CONFLICT)).toEqual({
      current: { name: 'HEAD', lines: ['Budget: 4,200.'] },
      base: null,
      incoming: { name: 'north-wall', lines: ['Budget: 4,500.'] },
    });
  });

  it('gives a side with no lines no lines, and a marker with no name no name', () => {
    expect(readConflict('<<<<<<<\n=======\n\nb\n>>>>>>>')).toEqual({
      current: { name: '', lines: [] },
      base: null,
      incoming: { name: '', lines: ['', 'b'] },
    });
  });

  it('reads the base part', () => {
    expect(readConflict('<<<<<<< a\nx\n||||||| merged common ancestors\ny\n=======\nz\n>>>>>>> b')!.base).toEqual({
      name: 'merged common ancestors',
      lines: ['y'],
    });
  });
});
