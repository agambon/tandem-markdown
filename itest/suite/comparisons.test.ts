/// <reference types="mocha" />
// Comparisons of a note stay in VS Code's own comparison view when Tandem Markdown is the
// default editor for markdown: after "Use Tandem Markdown by Default", git's Open Changes and
// `vscode.diff` of markdown files open VS Code's text comparison, on every version the suite runs
// on, and "Use Source by Default" leaves the comparisons' setting as it finds it. Only the test
// copy's user settings are written, and git is on for this file only.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { followGit, type GitApi } from '../../src/host/gitApi';
import { describeActiveTab } from './facts';
import { activeTabIsRich, api, closeEverything, git, setSetting, waitFor, workspaceDir, writeFile } from './helpers';
import { assertTestUserSettings, keepUserSetting, setUserSetting } from './userSettings';

const OPENING = 'workbench.editorAssociations';
const COMPARING = 'workbench.diffEditorAssociations';

/** How long git is given to start and to list the changed note. */
const GIT_MS = 30_000;

/** The parts of git's interface this file uses beyond those the extension declares. */
interface GitApiWithOpen extends GitApi {
  openRepository(root: vscode.Uri): Promise<GitRepositoryWithChanges | null>;
}
interface GitRepositoryWithChanges {
  readonly state: { readonly workingTreeChanges: readonly { readonly uri: vscode.Uri }[] };
  status(): Promise<void>;
}

function userValue(key: string): unknown {
  return vscode.workspace.getConfiguration().inspect(key)?.globalValue;
}

/** Opens a comparison with every other tab closed, and fails unless it is VS Code's text comparison. */
async function assertTextComparison(what: string, open: () => Thenable<unknown>): Promise<void> {
  await closeEverything();
  await open();
  await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab !== undefined, `${what} to open`);
  assert.ok(
    vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff,
    `${what} opened as ${describeActiveTab()}, not as VS Code's text comparison`,
  );
}

suite("Comparisons of a note stay in VS Code's comparison view", () => {
  const restores: (() => Promise<void>)[] = [];

  suiteSetup(async () => {
    const hook = await api();
    assertTestUserSettings(hook);
    restores.push(keepUserSetting(OPENING), keepUserSetting(COMPARING));
    // Both commands ask first; the first button is the yes.
    hook.answerPrompts((prompt) => prompt.buttons[0]);
  });

  suiteTeardown(async () => {
    (await api()).answerPrompts(undefined);
    await closeEverything();
    for (const restore of restores) await restore();
  });

  test('Use Tandem Markdown by Default keeps comparisons in text, and Use Source by Default leaves them', async function () {
    this.timeout(2 * GIT_MS + 60_000);
    // A setting of the user's own for comparisons of other files, which the commands leave alone.
    const comparisonsBefore = { '*.csv': 'default' };
    await setUserSetting(OPENING, undefined);
    await setUserSetting(COMPARING, comparisonsBefore);

    // A repository with one committed note, changed since, and two notes to compare.
    const repo = path.join(workspaceDir(), 'comparisons', 'git');
    const changed = writeFile('comparisons/git/note.md', '# Note\n\nThe first line.\n');
    git(repo, 'init', '-q');
    git(repo, 'add', 'note.md');
    git(repo, 'commit', '-q', '-m', 'Add the note');
    writeFile('comparisons/git/note.md', '# Note\n\nThe first line.\n\nA line added since.\n');
    const left = writeFile('comparisons/left.md', '# Left\n\nOne.\n');
    const right = writeFile('comparisons/right.md', '# Right\n\nTwo.\n');

    // The test copy starts with git off (itest/runTest.ts); it is on for this test only.
    const restoreGit = await setSetting('git', 'enabled', true);
    let gitApi: GitApi | undefined;
    const following = await followGit((started) => (gitApi = started));
    try {
      await waitFor(() => gitApi !== undefined, 'git to start', GIT_MS);
      const repository = await (gitApi as GitApiWithOpen).openRepository(vscode.Uri.file(repo));
      assert.ok(repository, `git opened the repository at ${repo}`);
      await repository.status();
      await waitFor(
        () => repository.state.workingTreeChanges.some((c) => c.uri.fsPath === changed.fsPath),
        'git to list the changed note',
        GIT_MS,
      );

      await vscode.commands.executeCommand('tandemMarkdown.useByDefault');
      // The association is in force: the note itself opens in a rich tab.
      await closeEverything();
      await vscode.commands.executeCommand('vscode.open', changed);
      await waitFor(() => activeTabIsRich(changed), 'the note to open in a rich tab');

      await assertTextComparison("git's Open Changes", () => vscode.commands.executeCommand('git.openChange', changed));
      await assertTextComparison('vscode.diff', () =>
        vscode.commands.executeCommand('vscode.diff', left, right, 'left.md and right.md'),
      );

      await vscode.commands.executeCommand('tandemMarkdown.useSourceByDefault');
      assert.deepEqual(
        userValue(COMPARING),
        { ...comparisonsBefore, '*.md': 'default', '*.markdown': 'default' },
        'comparisons of markdown files stay in the text comparison',
      );
      assert.equal(userValue(OPENING), undefined, 'the setting for opening files holds what it held before');
    } finally {
      following.dispose();
      await restoreGit();
    }
  });
});
