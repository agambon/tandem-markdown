// Tags on the host side: a panel's `searchTag` opens VS Code's search over the workspace's
// markdown files for the tag (src/host/model/tagSearch.ts says what it looks for).

import * as vscode from 'vscode';
import { MARKDOWN_EXTENSIONS } from '../core/fileKinds';
import type { HostFeature } from './features';
import { extensionsGlob, MARKDOWN_PATTERNS } from './model/glob';
import { isSearchableTag, tagSearchPattern } from './model/tagSearch';
import { registerPanelMessageHandler } from './panelMessages';

export const tags: HostFeature = () =>
  registerPanelMessageHandler('searchTag', async (m) => {
    if (typeof m.tag !== 'string' || !isSearchableTag(m.tag)) throw new Error('searchTag needs a tag');
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
      query: tagSearchPattern(m.tag),
      isRegex: true,
      isCaseSensitive: false,
      matchWholeWord: false,
      // The search view matches this with letter case on Linux only.
      filesToInclude: process.platform === 'linux' ? extensionsGlob(MARKDOWN_EXTENSIONS) : MARKDOWN_PATTERNS.join(', '),
      triggerSearch: true,
    });
  });
