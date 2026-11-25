// The part of a note a link to a block or a heading shows, and the block ids it is found by.

import { describe, expect, it } from 'vitest';
import { blockIdOf } from '../../../src/core/blockId';
import { notePreviewOf } from '../../../src/host/model/notePreviewText';
import { notePart } from '../../../src/host/model/noteSection';

const NOTE = [
  '---',
  'title: x',
  '---',
  '# Note',
  '',
  'Intro.',
  '',
  '## One',
  '',
  'First paragraph,',
  'over two lines. ^para-1',
  '',
  '### Inside one',
  '',
  'Deeper.',
  '',
  '## Two',
  '',
  '- a',
  '- b ^item-b',
  '  - nested',
  '',
  '| x |',
  '|---|',
  '| 1 |',
  '',
  '^table-1',
  '',
  '```',
  'code ^not-an-id',
  '```',
].join('\n');

describe('blockIdOf', () => {
  it('reads an id after a space at the end of a line, or alone on its line', () => {
    expect(blockIdOf('Text. ^quote-1')).toBe('quote-1');
    expect(blockIdOf('Text.\t^Q2  ')).toBe('Q2');
    expect(blockIdOf('^alone')).toBe('alone');
    expect(blockIdOf('  ^indented')).toBe('indented');
  });

  it('reads no id where the caret is not a block id', () => {
    expect(blockIdOf('x^2')).toBeNull();
    expect(blockIdOf('x ^ 2')).toBeNull();
    expect(blockIdOf('a note [^1]')).toBeNull();
    expect(blockIdOf('escaped \\^abc')).toBeNull();
    expect(blockIdOf('`code ^a`')).toBeNull();
    expect(blockIdOf('ends ^with_underscore')).toBeNull();
    expect(blockIdOf('no caret')).toBeNull();
  });
});

describe('notePart', () => {
  it('gives the whole note after its front matter when the embed names no part', () => {
    expect(notePart(NOTE, undefined)).toEqual({ text: NOTE.slice(NOTE.indexOf('# Note')).trimEnd() });
  });

  it("gives a heading's section, its subheadings included, up to the next heading of its level", () => {
    expect(notePart(NOTE, 'One')).toEqual({
      text: '## One\n\nFirst paragraph,\nover two lines. ^para-1\n\n### Inside one\n\nDeeper.',
    });
    expect(notePart(NOTE, 'inside-one')).toEqual({ text: '### Inside one\n\nDeeper.' });
    expect(notePart(NOTE, 'Note#Inside one')).toEqual({ text: '### Inside one\n\nDeeper.' });
  });

  it('gives the paragraph, the list item or the block above an id on its own line', () => {
    expect(notePart(NOTE, '^para-1')).toEqual({ text: 'First paragraph,\nover two lines. ^para-1' });
    expect(notePart(NOTE, '^item-b')).toEqual({ text: '- b ^item-b' });
    expect(notePart(NOTE, '^table-1')).toEqual({ text: '| x |\n|---|\n| 1 |' });
  });

  it('says what is missing, and finds no id inside code', () => {
    expect(notePart(NOTE, 'Three')).toEqual({ missing: 'heading' });
    expect(notePart(NOTE, '^nope')).toEqual({ missing: 'block' });
    expect(notePart(NOTE, '^not-an-id')).toEqual({ missing: 'block' });
  });
});

describe('notePreviewOf for a link to a block', () => {
  it('shows the start of the block, and the note when the block is not there', () => {
    expect(notePreviewOf(NOTE, 'Note.md', 'item-b')).toEqual({ title: 'Note', text: '- b ^item-b' });
    expect(notePreviewOf(NOTE, 'Note.md', 'nope').text.startsWith('Intro.')).toBe(true);
  });
});
