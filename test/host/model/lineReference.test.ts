// Copy Relative Path with Line Numbers: the lines a selection covers, numbered as Source numbers
// them.

import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';
import {
  copiedMessage,
  lineReference,
  NO_PATH_YET,
  referencePath,
  selectedLines,
} from '../../../src/host/model/lineReference';

// Copy Relative Path with Line Numbers: what it copies and what it says.

/** A note of 30 numbered lines, with front matter on its first three. */
const TEXT = ['---', 'title: Field notes', '---', ...Array.from({ length: 27 }, (_, i) => `Line ${i + 4}.`)].join('\n');

/** The offset of a column of a one-based line of TEXT. */
function at(line: number, column = 0): number {
  return (
    TEXT.split('\n')
      .slice(0, line - 1)
      .join('\n').length +
    (line > 1 ? 1 : 0) +
    column
  );
}

describe('the lines a selection covers', () => {
  it('numbers the lines as Source does, front matter included', () => {
    expect(selectedLines(TEXT, at(12, 2), at(18, 4))).toEqual({ first: 12, last: 18 });
  });

  it('is the same whichever way the selection was made', () => {
    expect(selectedLines(TEXT, at(18, 4), at(12, 2))).toEqual({ first: 12, last: 18 });
  });

  it('is the line the cursor is on when nothing is selected', () => {
    expect(selectedLines(TEXT, at(7, 3), at(7, 3))).toEqual({ first: 7, last: 7 });
    expect(selectedLines(TEXT, 0, 0)).toEqual({ first: 1, last: 1 });
  });

  it('leaves out the line a selection of whole lines ends at the start of', () => {
    expect(selectedLines(TEXT, at(12), at(19))).toEqual({ first: 12, last: 18 });
  });
});

describe('what is copied', () => {
  it('gives the path from the workspace folder, then the lines', () => {
    const note = { path: '/c:/work/notes/Field notes.md', fsPath: 'c:\\work\\notes\\Field notes.md' };
    const path = referencePath(note, '/c:/work');
    expect(lineReference(path, { first: 12, last: 18 })).toBe('notes/Field notes.md:12-18');
    expect(lineReference(path, { first: 12, last: 12 })).toBe('notes/Field notes.md:12');
  });

  it('finds the note in its folder whatever the case of the drive letter', () => {
    expect(referencePath({ path: '/C:/work/notes/a.md', fsPath: 'C:\\work\\notes\\a.md' }, '/c:/work')).toBe(
      'notes/a.md',
    );
  });

  it('gives the full path, with forward slashes, for a note outside the workspace', () => {
    const note = { path: '/c:/elsewhere/Field notes.md', fsPath: 'c:\\elsewhere\\Field notes.md' };
    expect(referencePath(note, undefined)).toBe('c:/elsewhere/Field notes.md');
    expect(referencePath(note, '/c:/work')).toBe('c:/elsewhere/Field notes.md');
  });
});

describe('the words', () => {
  it('says what is on the clipboard, and to save first when the note has unsaved changes', () => {
    expect(copiedMessage('notes/Field notes.md:12-18', false)).toBe('notes/Field notes.md:12-18 is on the clipboard.');
    expect(copiedMessage('notes/Field notes.md:12-18', true)).toBe(
      'notes/Field notes.md:12-18 is on the clipboard. Save the note so that an agent reading the file finds the same lines.',
    );
    expect(NO_PATH_YET).toBe('Save this note first: it has no path yet.');
  });

  it('is in the Command Palette as Copy Relative Path with Line Numbers while a rich tab is active', () => {
    const id = 'tandemMarkdown.copyRelativePathWithLines';
    expect(manifest.contributes.commands.find((c) => c.command === id)?.title).toBe(
      'Copy Relative Path with Line Numbers',
    );
    const palette = manifest.contributes.menus.commandPalette as { command: string; when?: string }[];
    expect(palette.find((m) => m.command === id)?.when).toBe("activeCustomEditorId == 'tandemMarkdown.editor'");
  });
});
