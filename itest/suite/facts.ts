// Shared by the files that establish facts about VS Code and other extensions (`facts*.test.ts`).
// Such a file is measured once, by hand, not run with the suite: it runs only when the words
// given to the runner name it (`npm run itest -- facts`, or one file's name), and is skipped in
// a run of the whole suite. Each prints what it saw (lines starting "note:") and compares it
// with what reading that version's source predicts, where that version was read.

import * as vscode from 'vscode';

/** True when a word given to the runner starts with "facts". */
function factsRequested(): boolean {
  return (process.env.TM_ITEST_ONLY ?? '').split(',').some((word) => word.startsWith('facts'));
}

/** `suite`, or `suite.skip` when the run did not ask for facts. */
export function factsSuite(title: string, body: () => void): void {
  if (factsRequested()) suite(title, body);
  else suite.skip(title, body);
}

/** The settings that bear on how VS Code saves a note, by name, as they apply to markdown now. */
export function saveSettings(): Record<string, unknown> {
  const files = vscode.workspace.getConfiguration('files', { languageId: 'markdown' });
  const editor = vscode.workspace.getConfiguration('editor', { languageId: 'markdown' });
  return {
    'files.autoSave': files.get('autoSave'),
    'files.autoSaveDelay': files.get('autoSaveDelay'),
    'files.saveConflictResolution': files.get('saveConflictResolution'),
    'editor.formatOnSave': editor.get('formatOnSave'),
    'files.trimTrailingWhitespace': files.get('trimTrailingWhitespace'),
    'files.insertFinalNewline': files.get('insertFinalNewline'),
    'workbench.localHistory.enabled': vscode.workspace.getConfiguration('workbench').get('localHistory.enabled'),
  };
}

/** "1.146" of "1.146.0": the release a fact was read for. */
export function release(): string {
  return vscode.version.split('.').slice(0, 2).join('.');
}

/** What the active tab of the active group is, in words. */
export function describeActiveTab(): string {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return 'no tab';
  const input: unknown = tab.input;
  if (input instanceof vscode.TabInputTextDiff) return `text comparison "${tab.label}"`;
  if (input instanceof vscode.TabInputText) return `text editor "${tab.label}"`;
  if (input instanceof vscode.TabInputCustom) return `custom editor ${input.viewType} "${tab.label}"`;
  // VS Code tells extensions nothing of a comparison whose two sides are custom editors.
  if (input === undefined) return `unknown input "${tab.label}"`;
  return `${(input as object).constructor.name} "${tab.label}"`;
}
