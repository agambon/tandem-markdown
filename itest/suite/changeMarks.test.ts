/// <reference types="mocha" />
// Change marks in a real VS Code: a file in a git repository, opened in the rich editor and
// edited there, gets marks for the lines added, changed and removed since its last commit,
// worked out from the committed text the built-in git extension gives. A commit takes them
// away, `tandemMarkdown.changeMarks` turns them off, and a file in no repository has none. The
// suite's user settings turn git off; these tests turn it on and back off. They need the `git`
// command; without it they are skipped, and say so.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  api,
  closeEverything,
  git,
  note,
  openRich,
  pause,
  setSetting,
  waitFor,
  workspaceDir,
  writeFile,
} from './helpers';

type State = Awaited<ReturnType<Awaited<ReturnType<typeof api>>['panelState']>>;

/** The git extension notices a new commit by watching the repository; this is a guard against a hang. */
const GIT_MS = 30_000;
/** How long a file with no repository is watched for marks that must not come. */
const QUIET_MS = 1500;

const COMMITTED = 'one\ntwo\nthree\nfour\nfive\n';

/** The marks the panel shows, as "kind line". */
const marks = (state: State) => state.changeMarks.map((m) => `${m.kind} ${m.line}`);

suite('Change marks against the last commit', () => {
  let folder = '';
  let file: vscode.Uri;
  /** Git's setting before these tests turned it on; undefined while they have not. */
  let gitBefore: { value: unknown } | undefined;

  suiteSetup(async function () {
    try {
      execFileSync('git', ['--version']);
    } catch {
      note('the git command is not available here; the change marks are not checked');
      this.skip();
    }
    folder = path.join(workspaceDir(), 'changes');
    mkdirSync(folder, { recursive: true });
    file = writeFile('changes/Note.md', COMMITTED);
    git(folder, 'init', '--quiet');
    git(folder, 'add', 'Note.md');
    git(folder, 'commit', '--quiet', '-m', 'First');
    const config = vscode.workspace.getConfiguration('git');
    gitBefore = { value: config.inspect('enabled')?.globalValue };
    await config.update('enabled', true, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<{
      enabled: boolean;
      getAPI(v: 1): { openRepository(root: vscode.Uri): Promise<unknown> };
    }>('vscode.git');
    assert.ok(extension, 'the built-in git extension is there');
    const exported = extension.isActive ? extension.exports : await extension.activate();
    await waitFor(() => exported.enabled, 'git to be turned on');
    assert.ok(await exported.getAPI(1).openRepository(vscode.Uri.file(folder)), 'git opened the repository');
  });

  suiteTeardown(async () => {
    if (!gitBefore) return;
    await vscode.workspace
      .getConfiguration('git')
      .update('enabled', gitBefore.value, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    await closeEverything();
  });

  test('lines added, changed and removed in the panel are marked, and a commit takes the marks away', async () => {
    const hook = await api();
    await openRich(file);
    // "two" changed, a line added after "three", "five" removed.
    await hook.runInPanel(file, [
      { type: 'replace', from: COMMITTED.indexOf('two'), to: COMMITTED.indexOf('two') + 3, text: 'two, changed' },
    ]);
    let state = await hook.panelState(file);
    const afterThree = state.text.indexOf('four');
    await hook.runInPanel(file, [{ type: 'insert', at: afterThree, text: 'a new line\n' }]);
    state = await hook.panelState(file);
    const five = state.text.indexOf('five\n');
    await hook.runInPanel(file, [{ type: 'replace', from: five, to: five + 'five\n'.length, text: '' }]);
    await hook.flush(file);
    await waitFor(
      async () => {
        state = await hook.panelState(file);
        return marks(state).length === 3;
      },
      'three change marks',
      GIT_MS,
    );
    note(`marks: ${JSON.stringify(state.changeMarks)}`);
    assert.deepEqual(marks(state), ['changed 2', 'added 4', 'removed 6']);

    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
    assert.ok(document && (await document.save()), 'the note was saved');
    git(folder, 'commit', '--quiet', '-am', 'Second');
    await waitFor(
      async () => marks(await hook.panelState(file)).length === 0,
      'the commit to take the marks away',
      GIT_MS,
    );
  });

  test('tandemMarkdown.changeMarks off takes the marks away, and on brings them back', async () => {
    const hook = await api();
    await openRich(file);
    await hook.runInPanel(file, [{ type: 'insert', at: 0, text: 'zero\n' }]);
    await hook.flush(file);
    await waitFor(
      async () => marks(await hook.panelState(file)).includes('added 1'),
      'a mark for the new line',
      GIT_MS,
    );
    const restore = await setSetting('tandemMarkdown', 'changeMarks', false);
    try {
      await waitFor(async () => marks(await hook.panelState(file)).length === 0, 'the setting to take the marks away');
    } finally {
      await restore();
    }
    await waitFor(async () => marks(await hook.panelState(file)).includes('added 1'), 'the marks to come back');
  });

  test('a file in no repository has no marks', async () => {
    const hook = await api();
    const loose = writeFile('Loose note.md', 'one\ntwo\n');
    await openRich(loose);
    await hook.runInPanel(loose, [{ type: 'insert', at: 0, text: 'zero\n' }]);
    await hook.flush(loose);
    await pause(QUIET_MS);
    assert.deepEqual((await hook.panelState(loose)).changeMarks, []);
  });
});
