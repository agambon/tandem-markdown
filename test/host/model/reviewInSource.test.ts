// The Review in Source button and command, as the manifest declares them. VS Code sets the
// context key `chatEdits.hasEditorModifications` for the active editor of each group, custom
// editors included, while chat has changes in its file that are not yet kept or undone, and the
// button on a rich tab's title bar reads it. The key is not documented: if VS Code renames it,
// the button stops appearing and nothing else changes.

import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';

const ID = 'tandemMarkdown.reviewInSource';
const ON_RICH_TAB = "activeCustomEditorId == 'tandemMarkdown.editor'";
const CHAT_CHANGES_WAITING = 'chatEdits.hasEditorModifications';

type MenuItem = { command: string; when?: string; group?: string };

/** The terms of a `when` clause joined by `&&`, or null when it holds any other operator. */
function allOf(when: string | undefined): string[] | null {
  if (!when || /\|\||!|\(/.test(when)) return null;
  return when
    .split('&&')
    .map((term) => term.trim())
    .sort();
}

describe('the Review in Source button', () => {
  const menus = manifest.contributes.menus as Record<string, MenuItem[]>;

  it("is on a rich tab's title bar only while chat has changes waiting in the note", () => {
    const button = menus['editor/title']!.find((m) => m.command === ID);
    expect(button?.group).toMatch(/^navigation/);
    expect(allOf(button?.when)).toEqual([ON_RICH_TAB, CHAT_CHANGES_WAITING].sort());
  });

  it('is in the command palette under the same condition, and is called Review in Source', () => {
    const palette = menus.commandPalette!.find((m) => m.command === ID);
    expect(allOf(palette?.when)).toEqual([ON_RICH_TAB, CHAT_CHANGES_WAITING].sort());
    const command = manifest.contributes.commands.find((c) => c.command === ID);
    expect(command?.title).toBe('Review in Source');
  });
});
