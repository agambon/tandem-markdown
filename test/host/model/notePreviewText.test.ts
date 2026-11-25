// What a link's hover card shows of the note it points to: its title and the start of its text.

import { nameToEmoji } from 'gemoji';
import { describe, expect, it } from 'vitest';
import { NOTE_PREVIEW_CHARS, notePreviewOf } from '../../../src/host/model/notePreviewText';

describe('notePreviewOf', () => {
  it('takes the first heading as the title and leaves its line out when the note starts with it', () => {
    expect(notePreviewOf('# My Note\n\nFirst paragraph with **bold**.\n\n- a list\n', 'My Note.md')).toEqual({
      title: 'My Note',
      text: 'First paragraph with bold.\n\n- a list',
    });
  });

  it('starts after the front matter', () => {
    expect(notePreviewOf('---\ntitle: x\ntags: [a]\n---\n\n# Heading\nBody.\n', 'n.md')).toEqual({
      title: 'Heading',
      text: 'Body.',
    });
  });

  it('uses the file name when there is no heading, and keeps a heading that is not first', () => {
    expect(notePreviewOf('Just text.\n\n## Later\n', 'Plain note.md')).toEqual({
      title: 'Later',
      text: 'Just text.\n\nLater',
    });
    expect(notePreviewOf('Just text.\n', 'Plain note.markdown')).toEqual({ title: 'Plain note', text: 'Just text.' });
    expect(notePreviewOf('', 'Empty.md')).toEqual({ title: 'Empty', text: '' });
  });

  it('reads the text as plain text, block by block, code as typed', () => {
    const note = [
      '**Status:** done &amp; dusted. See [the plan](plan.md) and <kbd>Ctrl</kbd> %%draft%%',
      '',
      '> Quoted *note*',
      '',
      '- [ ] a ==task==',
      '1. one',
      '',
      '```js',
      'const a = **b**;',
      '```',
      '',
      '[plan]: plan.md',
      '',
      '| A | B |',
      '|---|---|',
      '| `x` | *y* |',
    ].join('\n');
    expect(notePreviewOf(note, 'n.md').text).toBe(
      [
        'Status: done & dusted. See the plan and Ctrl',
        'Quoted note',
        '- [ ] a task',
        '1. one',
        'const a = **b**;',
        'A | B\nx | y',
      ].join('\n\n'),
    );
  });

  it('shows at most 600 characters, and says when there is more', () => {
    const long = 'word '.repeat(400);
    const { text } = notePreviewOf(long, 'Long.md');
    expect(text.endsWith('…')).toBe(true);
    expect(Array.from(text).length).toBeLessThanOrEqual(NOTE_PREVIEW_CHARS + 1);
    expect(notePreviewOf('x'.repeat(NOTE_PREVIEW_CHARS), 'Fits.md').text).toBe('x'.repeat(NOTE_PREVIEW_CHARS));
  });

  it('never cuts a character in half', () => {
    const { text } = notePreviewOf('😀'.repeat(700), 'Emoji.md');
    expect(Array.from(text.slice(0, -1)).every((c) => c === '😀')).toBe(true);
  });

  it('decodes entities in the title as the outline does', () => {
    expect(notePreviewOf('# Salt &amp; Pepper\n', 'n.md').title).toBe('Salt & Pepper');
  });

  it("leaves out a heading's attributes as the outline does, and keeps math as typed", () => {
    const note = 'Intro.\n\n## Part {#part .wide}\n\n> ### Quoted {-}\n\nThe $a*b*c$ case\n\n$$\nx *y*\n$$\n';
    expect(notePreviewOf(note, 'n.md').text).toBe('Intro.\n\nPart\n\nQuoted\n\nThe $a*b*c$ case\n\n$$\nx *y*\n$$');
  });

  it('shows emoji codes as emoji in the title and the text with the emoji list, and as typed without it', () => {
    const note = '# Launch :rocket:\n\nReady :+1: but `:x:` stays.\n\n- [ ] Go :rocket:\n';
    expect(notePreviewOf(note, 'n.md', undefined, { names: nameToEmoji })).toEqual({
      title: 'Launch 🚀',
      text: `Ready ${nameToEmoji['+1']} but :x: stays.\n\n- [ ] Go 🚀`,
    });
    expect(notePreviewOf(note, 'n.md')).toEqual({
      title: 'Launch :rocket:',
      text: 'Ready :+1: but :x: stays.\n\n- [ ] Go :rocket:',
    });
  });
});
