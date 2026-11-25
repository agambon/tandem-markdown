// Which editor VS Code opens a file in by its editor associations, as VS Code works it out, and which
// editors open a file by themselves when no association names one.

import { describe, expect, it } from 'vitest';
import {
  associationFor,
  comparisonEntry,
  editorDisplayName,
  editorsOpeningByThemselves,
  patternOutranked,
  registeredEditors,
} from '../../../src/host/model/editorAssociations';

const note = { scheme: 'file', path: '/w/notes/Field notes.md' };
const everyEditor = () => true;

describe('the editor VS Code opens a file in', () => {
  it("takes the workspace's entry for a pattern over the user's, and the user's over a default's", () => {
    expect(associationFor({ user: { '*.md': 'mine' }, workspace: { '*.md': 'theirs' } }, note, everyEditor)).toEqual({
      pattern: '*.md',
      viewType: 'theirs',
      level: 'workspace',
    });
    expect(associationFor({ default: { '*.md': 'given' }, user: { '*.md': 'mine' } }, note, everyEditor)).toEqual({
      pattern: '*.md',
      viewType: 'mine',
      level: 'user',
    });
  });

  it('takes the longest pattern that matches, wherever it came from', () => {
    const levels = { user: { '*.md': 'mine' }, workspace: { '**/*.md': 'theirs' } };
    expect(associationFor(levels, note, everyEditor)?.viewType).toBe('theirs');
    const mineLonger = { user: { '**/notes/*.md': 'mine' }, workspace: { '*.md': 'theirs' } };
    expect(associationFor(mineLonger, note, everyEditor)).toMatchObject({ viewType: 'mine', level: 'user' });
  });

  it('matches a pattern with a slash against the path, any other against the name, in any letter case', () => {
    const levels = { workspace: { '**/docs/**/*.md': 'docs' } };
    expect(associationFor(levels, { scheme: 'file', path: '/w/docs/guide/a.md' }, everyEditor)?.viewType).toBe('docs');
    expect(associationFor(levels, note, everyEditor)).toBeUndefined();
    expect(associationFor({ user: { '*.MD': 'mine' } }, note, everyEditor)?.viewType).toBe('mine');
  });

  it('reads a range of characters in a pattern as VS Code does', () => {
    const levels = { user: { '*.md': 'mine', '[Ff]ield*.md': 'theirs' } };
    expect(associationFor(levels, note, everyEditor)?.viewType).toBe('theirs');
  });

  it('passes over an entry for an editor that is not installed', () => {
    const levels = { user: { '*.md': 'mine' }, workspace: { '**/*.md': 'gone' } };
    expect(associationFor(levels, note, (viewType) => viewType !== 'gone')).toMatchObject({ viewType: 'mine' });
  });

  it("counts an entry for a notebook or for one of VS Code's own editors, as VS Code does", () => {
    const editors = registeredEditors([
      { contributes: { customEditors: [{ viewType: 'mine' }] } },
      { contributes: { notebooks: [{ type: 'markdown-notebook' }, null], customEditors: 'odd' } },
      undefined,
    ]);
    const over = (viewType: string) =>
      associationFor({ user: { '*.md': 'mine', '**/*.md': viewType } }, note, (v) => editors.has(v))?.viewType;
    expect(over('markdown-notebook')).toBe('markdown-notebook');
    expect(over('imagePreview.previewEditor')).toBe('imagePreview.previewEditor');
    expect(over('gone.editor')).toBe('mine');
  });

  it('finds none where no entry matches, or a setting is not an object of patterns', () => {
    expect(associationFor({ user: { '*.txt': 'mine' } }, note, everyEditor)).toBeUndefined();
    expect(associationFor({ user: ['*.md'], workspace: 'odd' }, note, everyEditor)).toBeUndefined();
  });
});

describe('the editors that open a file by themselves', () => {
  const opening = (contributes: Record<string, unknown>, version = '1.146.0', file = note) =>
    editorsOpeningByThemselves([{ contributes }], file, version);
  const forNotes = { selector: [{ filenamePattern: '*.md' }] };

  it('counts a notebook whose priority is missing or "default", and no other', () => {
    const notebook = (priority?: string) => ({ notebooks: [{ type: 'nb', ...forNotes, priority }] });
    expect(opening(notebook())).toEqual(['nb']);
    expect(opening(notebook('default'))).toEqual(['nb']);
    expect(opening(notebook('option'))).toEqual([]);
    expect(opening(notebook('exclusive'))).toEqual([]);
  });

  it('counts a custom editor unless the release reads its priority as "option" or "explicit"', () => {
    const editor = (priority: unknown) => ({ customEditors: [{ viewType: 'ce', ...forNotes, priority }] });
    expect(opening(editor(undefined))).toEqual(['ce']);
    expect(opening(editor('builtin'))).toEqual(['ce']);
    expect(opening(editor('option'))).toEqual([]);
    expect(opening(editor('explicit'))).toEqual([]);
    expect(opening(editor('explicit'), '1.120.0')).toEqual(['ce']);
    expect(opening(editor({ textEditor: 'option', diffEditor: 'explicit' }))).toEqual([]);
    expect(opening(editor({ textEditor: 'option' }), '1.123.0')).toEqual(['ce']);
    expect(opening(editor({ diffEditor: 'option' }))).toEqual(['ce']);
  });

  it("matches each selector's pattern as VS Code does, passing over one with none", () => {
    const notebooks = [
      { type: 'notes', selector: [{}, { filenamePattern: '**/notes/*.md', excludeFileNamePattern: '*.md' }] },
      { type: 'text', selector: [{ filenamePattern: '*.txt' }] },
    ];
    expect(opening({ notebooks })).toEqual(['notes']);
    expect(opening({ notebooks }, '1.146.0', { scheme: 'file', path: '/w/a.md' })).toEqual([]);
  });

  it('names a custom editor or a notebook by the name its manifest gives', () => {
    const packages = [
      {
        contributes: {
          customEditors: [{ viewType: 'ce', displayName: 'Custom' }],
          notebooks: [{ type: 'nb', displayName: 'Book' }],
        },
      },
    ];
    expect([
      editorDisplayName(packages, 'ce'),
      editorDisplayName(packages, 'nb'),
      editorDisplayName(packages, 'x'),
    ]).toEqual(['Custom', 'Book', undefined]);
  });
});

describe('an entry for a pattern that a longer one outranks for every file', () => {
  const outranked = (levels: { user?: unknown; default?: unknown }, pattern = '*.md') =>
    patternOutranked(levels, pattern, (viewType) => viewType !== 'gone');

  it('is outranked by a longer pattern that matches every file it does, in the user settings or a default', () => {
    expect(outranked({ user: { '*.{md,markdown}': 'mine' } })).toBe(true);
    expect(outranked({ user: { '*.{md,markdown}': 'mine' } }, '*.markdown')).toBe(true);
    expect(outranked({ default: { '**/*.MD': 'given' } })).toBe(true);
  });

  it('is not outranked by a pattern for some files only, by an editor not installed, or by itself', () => {
    expect(outranked({ user: { 'docs/*.md': 'mine', '*.{txt,text}': 'mine' } })).toBe(false);
    expect(outranked({ user: { '*.{md,markdown}': 'gone' }, default: { '*.{md,markdown}': 'given' } })).toBe(false);
    expect(outranked({ user: { '*.md': 'mine', '*.MD': 'mine' } })).toBe(false);
  });
});

describe('the comparisons entry Use Tandem Markdown by Default writes for a pattern', () => {
  const installed = (viewType: string) => viewType !== 'gone.editor';
  const entry = (now: unknown, opener: string, version: string) => comparisonEntry(now, opener, installed, version);

  it("keeps the user's own entry for an installed editor, on every release", () => {
    expect(entry('writer.editor', 'default', '1.120.0')).toBe('writer.editor');
    expect(entry('tandemMarkdown.editor', 'default', '1.146.0')).toBe('tandemMarkdown.editor');
  });

  it('keeps comparisons in the editor that opens the files on 1.120 to 1.128, where they open now', () => {
    expect(entry(undefined, 'writer.editor', '1.120.0')).toBe('writer.editor');
    expect(entry('gone.editor', 'writer.editor', '1.128.5')).toBe('writer.editor');
  });

  it("sets VS Code's text comparison from 1.129, and for this extension's editor or one not installed", () => {
    expect(entry(undefined, 'writer.editor', '1.129.0')).toBe('default');
    expect(entry(undefined, 'tandemMarkdown.editor', '1.120.0')).toBe('default');
    expect(entry(undefined, 'gone.editor', '1.124.0')).toBe('default');
    expect(entry('gone.editor', 'default', '1.124.0')).toBe('default');
  });
});
