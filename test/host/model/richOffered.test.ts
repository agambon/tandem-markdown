// Which documents the rich views are offered for, and package.json's `when` clauses held to the
// same.

import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';
import { richOffered } from '../../../src/host/model/richOffered';

/** The `when` clause that holds where `richOffered` does, for the view commands in package.json. */
const RICH_OFFERED_WHEN =
  'resourceExtname != .conflict && (resourceLangId == markdown || resourceExtname == .md || resourceExtname == .markdown || resourceExtname == .txt || resourceScheme == untitled && resourceLangId == plaintext)';

describe('the documents the rich views are offered for', () => {
  it('offers them for markdown, by language or by name, and for .txt files', () => {
    expect(richOffered({ scheme: 'file', path: '/w/notes.md' })).toBe(true);
    expect(richOffered({ scheme: 'file', path: '/w/notes.MARKDOWN' })).toBe(true);
    expect(richOffered({ scheme: 'file', path: '/w/README', languageId: 'markdown' })).toBe(true);
    expect(richOffered({ scheme: 'file', path: '/w/todo.txt', languageId: 'plaintext' })).toBe(true);
  });

  it('offers them for untitled documents in markdown or plain text, and not in another language', () => {
    expect(richOffered({ scheme: 'untitled', path: 'Untitled-1', languageId: 'plaintext' })).toBe(true);
    expect(richOffered({ scheme: 'untitled', path: 'Untitled-1', languageId: 'markdown' })).toBe(true);
    expect(richOffered({ scheme: 'untitled', path: 'Untitled-2', languageId: 'python' })).toBe(false);
  });

  it('does not offer them for other files', () => {
    expect(richOffered({ scheme: 'file', path: '/w/app.ts', languageId: 'typescript' })).toBe(false);
    expect(richOffered({ scheme: 'file', path: '/w/notes.txt.bak' })).toBe(false);
  });

  it('matches package.json: the editor an option for these names, the view commands where offered', () => {
    const editor = manifest.contributes.customEditors[0]!;
    expect(editor.displayName).toBe('Rich Editor');
    expect(editor.displayName).not.toBe(manifest.displayName);
    expect(editor.priority).toBe('option');
    expect(editor.selector.map((s) => s.filenamePattern)).toEqual(['*.md', '*.markdown', '*.txt']);
    const palette = manifest.contributes.menus.commandPalette as { command: string; when?: string }[];
    for (const id of ['showSource', 'showRichView', 'showRichEditor', 'switchView', 'verify']) {
      expect(palette.find((m) => m.command === `tandemMarkdown.${id}`)?.when, id).toBe(RICH_OFFERED_WHEN);
    }
    const keys = manifest.contributes.keybindings as { command: string; when?: string }[];
    expect(keys.find((k) => k.command === 'tandemMarkdown.switchView')?.when).toBe(RICH_OFFERED_WHEN);
  });

  it('offers no button or menu item that opens a rich view on a conflict file, whatever its language', () => {
    // The items shown by a file's language or name; those on the rich views' own tabs never are
    // on a conflict file, which never opens in them.
    const menus = manifest.contributes.menus as Record<string, { command: string; when?: string }[]>;
    const opening = Object.values(menus)
      .flat()
      .filter(
        (m) => /Rich|switchView|showSource/.test(m.command) && /resourceLangId|resourceExtname/.test(m.when ?? ''),
      );
    expect(opening.length).toBeGreaterThan(0);
    for (const m of opening) expect(m.when ?? '', m.command).toContain('resourceExtname != .conflict');
  });

  it('uses distinct icons and non-interleaved ordering for editor title view buttons', () => {
    const props = manifest.contributes.configuration.properties as Record<
      string,
      { default?: unknown; scope?: string }
    >;
    expect(props['tandemMarkdown.hideBuiltInPreviewButtons']?.default).toBe(true);
    expect(props['tandemMarkdown.hideBuiltInPreviewButtons']?.scope).toBe('window');

    const commands = manifest.contributes.commands as { command: string; icon?: string }[];
    for (const cmd of commands.filter((c) => /RichView/.test(c.command) && c.icon)) {
      expect(cmd.icon, cmd.command).toBe('$(eye)');
    }

    const title = manifest.contributes.menus['editor/title'] as { command: string; group?: string }[];
    const rank = (id: string) => Number((title.find((m) => m.command === id)?.group ?? '').split('@')[1]);
    expect(rank('tandemMarkdown.showSource')).toBeGreaterThan(3);
    expect(rank('tandemMarkdown.showRichEditorOnSourceTab')).toBeGreaterThan(3);
    expect(rank('tandemMarkdown.showRichEditorOnSourceTab')).toBeLessThan(
      rank('tandemMarkdown.showRichViewOnSourceTab'),
    );
  });
});
