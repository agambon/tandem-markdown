// The file's footnotes (links/footnotes.ts): how notes are numbered, and that the index kept in
// step with edits says what an index built from scratch says.

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createEditorState } from '../../../src/panel/editor';
import { footnoteIndex, footnoteLabel } from '../../../src/panel/links/footnotes';
import { withFullTree } from '../../../src/panel/render/framework';
import { Rng } from '../../sync/world';
import { expectSameAsFresh, fakeContext, stateOf } from '../helpers';

/** Every footnote node, with what the index says of it. */
function summary(state: EditorState): string[] {
  const index = footnoteIndex(state)!;
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'InlineFootnote') out.push(`in place ${node.from}: ${index.inPlaceNumber(node.from)}`);
      if (node.name !== 'FootnoteRef' && node.name !== 'FootnoteLabel') return;
      const label = footnoteLabel(state.doc, node.node);
      const def = index.definition(label);
      const first = index.firstReference(label);
      out.push(
        `${node.name} ${node.from} ${label}: ${index.number(label)} def ${def?.from ?? '-'} first ${first?.from ?? '-'}`,
      );
    },
  });
  return out;
}

function numbers(text: string): string[] {
  const state = stateOf(text);
  const index = footnoteIndex(state)!;
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'InlineFootnote') out.push(`^${index.inPlaceNumber(node.from)}`);
      if (node.name === 'FootnoteRef')
        out.push(`${state.sliceDoc(node.from, node.to)}=${index.number(footnoteLabel(state.doc, node.node))}`);
    },
  });
  return out;
}

describe('footnote numbers', () => {
  it('follow the order of first reference, not of the labels or the definitions', () => {
    expect(numbers('a[^z] b[^a] c[^z]\n\n[^a]: A.\n[^z]: Z.')).toEqual(['[^z]=1', '[^a]=2', '[^z]=1']);
  });

  it('count notes written in place in the same sequence', () => {
    expect(numbers('a[^1] b^[here] c[^2]\n\n[^1]: One.\n[^2]: Two.')).toEqual(['[^1]=1', '^2', '[^2]=3']);
  });

  it('skip a reference to a label the file does not define', () => {
    expect(numbers('a[^gone] b[^1]\n\n[^1]: One.')).toEqual(['[^gone]=null', '[^1]=1']);
  });

  it('match labels with no regard to case, and take the first definition', () => {
    const state = stateOf('a[^Note]\n\n[^note]: First.\n\n[^NOTE]: Second.');
    const index = footnoteIndex(state)!;
    expect(index.number('NOTE')).toBe(1);
    expect(index.definition('NOTE')?.from).toBe(state.doc.toString().indexOf('[^note]:'));
  });

  it('are not read inside code', () => {
    expect(numbers('`[^1]` and [^1]\n\n```\n[^1]: no\n```\n\n[^1]: Yes.')).toEqual(['[^1]=1']);
  });
});

const start = `# Notes

A claim.[^a] Another.[^b] In place.^[here] Again.[^a]

- An item.[^c]

> Quoted.[^b]

[^a]: The first note,
    over two lines.

[^b]: The second.

[^c]: The third, *styled*.

[^unused]: Nobody refers here.
`;

/** Paragraphs between the notes, so an edit damages a small part of the file and the index is updated, not rebuilt. */
const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i}.`).join('\n\n');
const text = start
  .replace('\n- An item.', `\n${filler}\n\n- An item.`)
  .replace('\n[^b]: The', `\n${filler}\n\n[^b]: The`);

const snippets = ['[^a]', '[^b]', '[^new]', '\n[^new]: New.\n', '^[x]', '^[', ']', '[^', '\n\n', 'text ', '`', '    '];

describe('the footnote index after an edit', () => {
  it('says what an index built from scratch says, over random edits', () => {
    const { ctx } = fakeContext();
    const rng = new Rng(7);
    const opened = withFullTree(createEditorState({ ctx, text, mode: 'edit' }));
    expect(summary(opened).length).toBeGreaterThan(0);
    expectSameAsFresh({
      start: opened,
      steps: 200,
      edit: (state) => {
        const len = state.doc.length;
        if (rng.chance(0.6))
          return state.update({ changes: { from: rng.int(len + 1), insert: rng.pick(snippets) } }).state;
        if (len === 0) return state;
        const from = rng.int(len);
        return state.update({ changes: { from, to: Math.min(len, from + 1 + rng.int(10)) } }).state;
      },
      fresh: (state) => withFullTree(createEditorState({ ctx, text: state.doc.toString(), mode: 'edit' })),
      read: summary,
    });
  });
});
