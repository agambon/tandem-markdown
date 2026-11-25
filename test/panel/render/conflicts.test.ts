// A conflict git left in a note: what each of its buttons leaves in the file, and where it is
// drawn. The drawing itself, and its buttons pressed, are checked in Chrome by
// harness/tests/drawn.spec.mjs.

import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { settleConflict, type Keep } from '../../../src/panel/render/conflicts';
import { drawn, fakeContext, stateOf } from '../helpers';

const CONFLICT = '<<<<<<< HEAD\nBudget: 4,200.\n=======\nBudget: 4,500.\n>>>>>>> north-wall';

/** The note after keeping `keep` of the conflict in it, which starts at its first `<`. */
function keep(note: string, keep: Keep): string {
  const doc = Text.of(note.split('\n'));
  const from = note.indexOf('<<<<<<<');
  const to = note.indexOf('\n', note.indexOf('>>>>>>>'));
  const change = settleConflict(doc, from, to < 0 ? note.length : to, keep)!;
  return doc.replace(change.from, change.to, Text.of(change.insert.split('\n'))).toString();
}

describe('the buttons of a conflict', () => {
  const note = `Above.\n\n${CONFLICT}\n\nBelow.\n`;

  it('Accept Current Change keeps the current lines and nothing else of the block', () => {
    expect(keep(note, 'current')).toBe('Above.\n\nBudget: 4,200.\n\nBelow.\n');
  });

  it('Accept Incoming Change keeps the incoming lines', () => {
    expect(keep(note, 'incoming')).toBe('Above.\n\nBudget: 4,500.\n\nBelow.\n');
  });

  it('Accept Both Changes keeps the current lines, then the incoming ones', () => {
    expect(keep(note, 'both')).toBe('Above.\n\nBudget: 4,200.\nBudget: 4,500.\n\nBelow.\n');
  });

  it('leave out the part as it was before either change', () => {
    const diff3 = 'a\n<<<<<<< ours\nx\n||||||| base\nold\n=======\ny\n>>>>>>> theirs\nb';
    expect(keep(diff3, 'current')).toBe('a\nx\nb');
    expect(keep(diff3, 'both')).toBe('a\nx\ny\nb');
  });

  it('take the lines of a side with none away with the block', () => {
    expect(keep('a\n<<<<<<< ours\n=======\ny\n>>>>>>> theirs\nb', 'current')).toBe('a\nb');
  });

  it('give a note that ended with the block no final line break', () => {
    expect(keep(`a\n${CONFLICT}`, 'incoming')).toBe('a\nBudget: 4,500.');
    expect(keep(`a\n${CONFLICT}\n`, 'incoming')).toBe('a\nBudget: 4,500.\n');
  });

  it('keep the ending of a note that ended with the block when they keep a side with no lines', () => {
    const empty = '<<<<<<< ours\n=======\ny\n>>>>>>> theirs';
    expect(keep(`a\n${empty}`, 'current')).toBe('a');
    expect(keep(`a\n${empty}\n`, 'current')).toBe('a\n');
    expect(keep(empty, 'current')).toBe('');
  });
});

describe('where a conflict is drawn', () => {
  const drawings = (text: string, options: Parameters<typeof stateOf>[1] = {}) =>
    drawn(stateOf(text, options)).filter((d) => d.feature === 'conflicts' && d.kind === 'replaceLines');

  it('as one drawing in place of its lines, in the Rich editor and in Rich view', () => {
    const text = `Above.\n\n${CONFLICT}\n\nBelow.‸`;
    expect(drawings(text).map((d) => [d.from, d.to])).toEqual([[8, 8 + CONFLICT.length]]);
    expect(drawings(text, { mode: 'view' })).toHaveLength(1);
  });

  it('not inside a code block', () => {
    expect(drawings(`\`\`\`\n${CONFLICT}\n\`\`\`\n‸`)).toEqual([]);
  });

  it('not with its setting off', () => {
    const ctx = fakeContext({ settings: { syntax: { conflictMarkers: false } } }).ctx;
    expect(drawings(`${CONFLICT}\n‸`, { ctx })).toEqual([]);
  });
});
