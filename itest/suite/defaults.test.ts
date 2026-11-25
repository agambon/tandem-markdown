/// <reference types="mocha" />
// Use Tandem Markdown by Default and Use Source by Default against the test copy's own user
// settings: the editor that opens markdown files, and the one that opens their comparisons.
// Before anything is written, the suite checks that the user settings file is inside the test
// copy's user data folder (TM_ITEST_USER_DATA, set by itest/runTest.ts), and before the test
// copy's own workspace settings are written, that its workspace is the copy's
// (TM_ITEST_WORKSPACE); what is written there is cleared after.
// Questions are answered through the test hook in place of the user; each is recorded so its
// words can be checked.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { listed } from '../../src/core/listText';
import type { DefaultsResult } from '../../src/host/defaults';
import { DEFAULTS_WORDS as W, DONT_CHANGE, OPEN_WORKSPACE_SETTINGS } from '../../src/host/model/defaultsWords';
import { fill } from '../../src/host/model/templates';
import type { PromptForTests } from '../../src/host/questions';
import { CLAIMED_SUFFIX, CLAIMING_NOTEBOOK_TYPE } from '../helper/claimingNotebook';
import { api, closeEverything, note, waitFor, writeFile } from './helpers';
import { assertTestUserSettings, setUserSetting, userSettingsFile } from './userSettings';

const TEST_WORKSPACE = process.env.TM_ITEST_WORKSPACE ?? '';
const KEY = 'workbench.editorAssociations';
const DIFF_KEY = 'workbench.diffEditorAssociations';
/** The test copy leaves Default Rich Mode at its default, the Rich editor. */
const RICH_NAME = 'Rich editor';
const RICH_FIRST = fill(W.richFirst, { rich: RICH_NAME });
const RICH_AGAIN = fill(W.richAgain, { rich: RICH_NAME });
const USE_RICH = fill(W.useRich, { rich: RICH_NAME });
const MD = fill(W.kindFiles, { kinds: '.md' });
const RICH_QUESTION = fill(W.question, { files: W.markdownFiles, place: RICH_FIRST });
const SOURCE_QUESTION = fill(W.question, { files: W.markdownFiles, place: W.sourceFirst });
const RICH_FROM_NOW_ON = `${fill(W.nowOpenRich, { files: W.markdownFiles, rich: RICH_FIRST })} ${W.tabsStay}`;
const RICH_ALREADY = fill(W.alreadyByUser, { files: W.markdownFiles, place: RICH_FIRST });
/** Where the user settings hold `"*.md": "default"` and nothing for `.markdown` files. */
const SOURCE_ALREADY = fill(W.alreadyMixed, {
  files: W.markdownFiles,
  source: W.sourceFirst,
  chosen: MD,
  none: fill(W.kindFiles, { kinds: '.markdown' }),
});
/** What the workspace's own entry in the last test leaves, and how to change it, as the answers say. */
const WORKSPACE_STILL = [
  fill(W.workspaceStillFile, { files: MD, editor: W.sourceFirst, file: '.vscode/settings.json' }),
  W.sharedFile,
  fill(W.changeItsEntry, {
    pattern: '*.md',
    value: fill(W.valueRich, { value: 'tandemMarkdown.editor', rich: RICH_AGAIN }),
  }),
  W.whoDecides,
  W.buttonOpensFile,
].join(' ');
/**
 * True on VS Code 1.120 to 1.128, which open a comparison in the editor that opens the file where
 * no entry chooses one for comparisons; the suite runs on 1.120.0 and on the current release.
 */
const COMPARISONS_FOLLOW_OPENING = Number(vscode.version.split('.')[1]) < 129;
/** VS Code's steps back to an editor of another extension, from a file of the pattern's kind. */
const stepsBack = (pattern: string, label: string): string => fill(W.steps, { kind: pattern.slice(1), pattern, label });

suite('Use Tandem Markdown by Default and Use Source by Default', () => {
  let settingsFile = '';
  const prompts: PromptForTests[] = [];
  let answer = DONT_CHANGE;

  /** The test copy's user settings, as written on disk. */
  const userSettings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
  /** Writes the setting into the test copy's user settings, as a user or another extension would have. */
  const setAssociations = (value: Record<string, string> | undefined) => setUserSetting(KEY, value);
  const setDiffAssociations = (value: Record<string, string> | undefined) => setUserSetting(DIFF_KEY, value);
  const run = async (command: string): Promise<DefaultsResult> => {
    const r = await vscode.commands.executeCommand<DefaultsResult>(command);
    note(`${command}: ${r.message ?? 'no answer shown'}`);
    return r;
  };

  suiteSetup(async () => {
    const hook = await api();
    settingsFile = userSettingsFile(hook);
    note(`the test copy's user settings: ${settingsFile}`);
    assertTestUserSettings(hook);
    assert.ok(existsSync(settingsFile), 'the test copy has its own user settings file');
    hook.answerPrompts((prompt) => {
      prompts.push(prompt);
      return answer;
    });
  });

  suiteTeardown(async () => {
    (await api()).answerPrompts(undefined);
    await setAssociations(undefined);
    await setDiffAssociations(undefined);
  });

  teardown(async () => {
    await closeEverything();
  });

  test('Use Tandem Markdown by Default names the editor it replaces, asks, and changes only the two entries', async () => {
    await setAssociations({ '*.md': 'markdownEditorOptimized.editor', '*.csv': 'some.csv.editor' });
    await setDiffAssociations(undefined);
    const restoreWindows = userSettings()['window.restoreWindows'];

    // Don't change: nothing is written.
    answer = DONT_CHANGE;
    prompts.length = 0;
    let r = await run('tandemMarkdown.useByDefault');
    assert.equal(r.written, false);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.message, RICH_QUESTION);
    assert.deepEqual(prompts[0]!.buttons, [USE_RICH, DONT_CHANGE]);
    // The test copy has no editor of that name installed, so the other command undoes the change.
    assert.ok(
      prompts[0]!.detail?.includes(
        fill(W.passedOver, { passed: 'markdownEditorOptimized.editor', files: MD, editor: W.sourceFirst }),
      ),
      `the question says where .md files open now, and why: ${prompts[0]!.detail}`,
    );
    assert.ok(
      prompts[0]!.detail?.endsWith(fill(W.undoCommand, { command: W.command.source })),
      `the question says how to undo it: ${prompts[0]!.detail}`,
    );
    assert.deepEqual(userSettings()[KEY], { '*.md': 'markdownEditorOptimized.editor', '*.csv': 'some.csv.editor' });

    // An editor that is installed, the test helper's notebook, is named, and how to choose it again.
    await setAssociations({ '*.md': CLAIMING_NOTEBOOK_TYPE, '*.csv': 'some.csv.editor' });
    prompts.length = 0;
    await run('tandemMarkdown.useByDefault');
    const notebook = `Claiming notebook stand-in (${CLAIMING_NOTEBOOK_TYPE})`;
    assert.ok(
      prompts[0]?.detail?.includes(
        fill(W.settingsOpenNow, { chosen: fill(W.filesIn, { files: MD, editor: notebook }) }),
      ),
      `the question names the notebook it replaces: ${prompts[0]?.detail}`,
    );
    assert.ok(
      prompts[0]?.detail?.endsWith(
        fill(W.undoCommandThen, { command: W.command.source, steps: stepsBack('*.md', 'Claiming notebook stand-in') }),
      ),
      `the question says how to choose it again: ${prompts[0]?.detail}`,
    );

    // Confirmed: the two entries, and nothing else. Comparisons stay where they are: on 1.120 to
    // 1.128 they open in the notebook that opens .md files, and keep it.
    answer = USE_RICH;
    r = await run('tandemMarkdown.useByDefault');
    assert.equal(r.written, true);
    assert.equal(r.message, RICH_FROM_NOW_ON);
    assert.deepEqual(userSettings()[KEY], {
      '*.md': 'tandemMarkdown.editor',
      '*.csv': 'some.csv.editor',
      '*.markdown': 'tandemMarkdown.editor',
    });
    assert.deepEqual(userSettings()[DIFF_KEY], {
      '*.md': COMPARISONS_FOLLOW_OPENING ? CLAIMING_NOTEBOOK_TYPE : 'default',
      '*.markdown': 'default',
    });
    assert.equal(userSettings()['window.restoreWindows'], restoreWindows, 'other settings are untouched');

    // Already so: no question, nothing written.
    prompts.length = 0;
    r = await run('tandemMarkdown.useByDefault');
    assert.equal(r.written, false);
    assert.equal(prompts.length, 0);
    assert.equal(r.message, RICH_ALREADY);
  });

  test('Use Tandem Markdown by Default leaves a longer pattern that already opens markdown in it', async () => {
    await setAssociations({ '*.{md,markdown}': 'tandemMarkdown.editor' });
    await setDiffAssociations(undefined);
    answer = USE_RICH;
    prompts.length = 0;

    // Only the comparisons need an entry.
    let r = await run('tandemMarkdown.useByDefault');
    assert.equal(prompts.length, 1);
    assert.equal(r.written, true);
    assert.deepEqual(userSettings()[KEY], { '*.{md,markdown}': 'tandemMarkdown.editor' });
    assert.deepEqual(userSettings()[DIFF_KEY], { '*.md': 'default', '*.markdown': 'default' });

    prompts.length = 0;
    r = await run('tandemMarkdown.useByDefault');
    assert.equal(prompts.length, 0);
    assert.equal(r.written, false);
    assert.equal(r.message, RICH_ALREADY);
  });

  test("Use Source by Default removes this editor's entries, asks first, and keeps the rest", async () => {
    await setAssociations({
      '*.csv': 'some.csv.editor',
      '*.md': 'tandemMarkdown.editor',
      '*.markdown': 'tandemMarkdown.editor',
    });
    await setDiffAssociations(undefined);
    answer = W.useSource;
    prompts.length = 0;
    let r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(r.written, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.message, SOURCE_QUESTION);
    assert.deepEqual(prompts[0]!.buttons, [W.useSource, DONT_CHANGE]);
    assert.ok(
      prompts[0]!.detail?.startsWith(
        fill(W.settingsOpenNow, { chosen: fill(W.filesIn, { files: W.markdownFiles, editor: RICH_FIRST }) }),
      ),
      `the question names the Rich editor as what it replaces: ${prompts[0]!.detail}`,
    );
    assert.ok(
      prompts[0]!.detail?.endsWith(fill(W.undoCommand, { command: W.command.rich })),
      `the question says how to undo it: ${prompts[0]!.detail}`,
    );
    assert.deepEqual(userSettings()[KEY], { '*.csv': 'some.csv.editor' });

    prompts.length = 0;
    r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(r.written, false);
    assert.equal(prompts.length, 0);

    // Only ours there: the setting goes altogether.
    await setAssociations({ '*.md': 'tandemMarkdown.editor' });
    r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(r.written, true);
    assert.equal(KEY in userSettings(), false);

    // Another editor set: it is named before it is replaced.
    await setAssociations({ '*.md': 'markdownEditorOptimized.editor' });
    prompts.length = 0;
    answer = DONT_CHANGE;
    r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(r.written, false);
    const asked: PromptForTests | undefined = prompts[prompts.length - 1];
    assert.ok(
      asked && asked.detail !== undefined && asked.detail.includes('markdownEditorOptimized.editor'),
      `the question names it: ${asked?.detail}`,
    );
    assert.deepEqual(userSettings()[KEY], { '*.md': 'markdownEditorOptimized.editor' });

    // The user's own entry for VS Code's text editor already opens Source: it stays, unasked.
    await setAssociations({ '*.md': 'default', '*.csv': 'some.csv.editor' });
    prompts.length = 0;
    r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(r.written, false);
    assert.equal(prompts.length, 0);
    assert.equal(r.message, SOURCE_ALREADY);
    assert.deepEqual(userSettings()[KEY], { '*.md': 'default', '*.csv': 'some.csv.editor' });
  });

  test('Use Source by Default sets the text editor where a notebook would open markdown by itself', async () => {
    await setAssociations(undefined);
    await setDiffAssociations(undefined);
    const claimed = writeFile(`defaults/notebook${CLAIMED_SUFFIX}`, '# Claimed\n\nA note the notebook opens.\n');
    const activeInput = (): unknown => vscode.window.tabGroups.activeTabGroup.activeTab?.input;

    // With no entry for markdown files, VS Code opens the note in the notebook by itself.
    await vscode.commands.executeCommand('vscode.open', claimed);
    await waitFor(() => {
      const input = activeInput();
      return input instanceof vscode.TabInputNotebook && input.notebookType === CLAIMING_NOTEBOOK_TYPE;
    }, 'the note to open in the notebook');

    // Run from the notebook's tab: *.md is set to VS Code's text editor; *.markdown, which no
    // notebook takes, is left without an entry.
    answer = W.useSource;
    prompts.length = 0;
    let r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(prompts.length, 1);
    assert.equal(r.written, true);
    assert.equal(r.message, `${fill(W.nowOpenChosen, { files: MD, source: W.sourceFirst })} ${W.tabsStay}`);
    assert.deepEqual(userSettings()[KEY], { '*.md': 'default' });

    await closeEverything();
    await vscode.commands.executeCommand('vscode.open', claimed);
    await waitFor(() => activeInput() instanceof vscode.TabInputText, 'the note to open in Source');

    // That entry already opens Source: it stays, unasked.
    prompts.length = 0;
    r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(prompts.length, 0);
    assert.equal(r.written, false);
    assert.equal(r.message, SOURCE_ALREADY);
    assert.deepEqual(userSettings()[KEY], { '*.md': 'default' });
  });

  test('comparisons take the text comparison, keep an installed editor, and Source leaves them', async () => {
    const comparisonsBefore = { '*.csv': 'some.csv.editor', '*.markdown': 'markdownEditorOptimized.editor' };
    await setAssociations(undefined);
    await setDiffAssociations(comparisonsBefore);

    // The editor set for comparisons, which is not installed, is named; Don't change writes nothing.
    answer = DONT_CHANGE;
    prompts.length = 0;
    let r = await run('tandemMarkdown.useByDefault');
    assert.equal(r.written, false);
    assert.ok(
      prompts[0]?.detail?.includes(fill(W.replacesOne, { editors: 'markdownEditorOptimized.editor' })),
      `the question names the editor set for comparisons: ${prompts[0]?.detail}`,
    );
    assert.ok(
      prompts[0]?.detail?.includes(fill(W.openNow, { files: W.markdownFilesStart, editor: W.sourceFirst })),
      `nothing was set for opening, so the question names Source as what it replaces: ${prompts[0]?.detail}`,
    );
    assert.deepEqual(userSettings()[DIFF_KEY], comparisonsBefore);

    // Confirmed: both markdown entries take the text comparison, and the rest stays.
    answer = USE_RICH;
    r = await run('tandemMarkdown.useByDefault');
    assert.equal(r.written, true);
    assert.deepEqual(userSettings()[DIFF_KEY], {
      '*.csv': 'some.csv.editor',
      '*.markdown': 'default',
      '*.md': 'default',
    });

    // Use Source by Default leaves comparisons as they are: they open in the text comparison already.
    answer = W.useSource;
    r = await run('tandemMarkdown.useSourceByDefault');
    assert.equal(r.written, true);
    assert.deepEqual(userSettings()[DIFF_KEY], {
      '*.csv': 'some.csv.editor',
      '*.markdown': 'default',
      '*.md': 'default',
    });
    assert.equal(KEY in userSettings(), false);

    // Only the comparisons left to set: the question is still asked before anything is written.
    await setAssociations({ '*.md': 'tandemMarkdown.editor', '*.markdown': 'tandemMarkdown.editor' });
    await setDiffAssociations(undefined);
    answer = USE_RICH;
    prompts.length = 0;
    r = await run('tandemMarkdown.useByDefault');
    assert.equal(prompts.length, 1);
    assert.equal(r.written, true);
    assert.deepEqual(userSettings()[DIFF_KEY], { '*.md': 'default', '*.markdown': 'default' });

    // An installed editor chosen for comparisons is the user's choice for them alone, and stays.
    await setAssociations(undefined);
    await setDiffAssociations({ '*.md': CLAIMING_NOTEBOOK_TYPE });
    r = await run('tandemMarkdown.useByDefault');
    assert.equal(r.written, true);
    assert.deepEqual(userSettings()[DIFF_KEY], { '*.md': CLAIMING_NOTEBOOK_TYPE, '*.markdown': 'default' });
  });

  test("a workspace's own entry that still wins is named before the change, after it, and when already set", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const relative = path.relative(TEST_WORKSPACE, workspaceFolder);
    assert.ok(
      TEST_WORKSPACE !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
      "only the test copy's own workspace settings are written",
    );
    await setAssociations(undefined);
    await setDiffAssociations(undefined);
    await vscode.workspace.getConfiguration().update(KEY, { '*.md': 'default' }, vscode.ConfigurationTarget.Workspace);
    try {
      answer = USE_RICH;
      prompts.length = 0;
      let r = await run('tandemMarkdown.useByDefault');
      assert.equal(prompts.length, 1);
      assert.ok(
        prompts[0]!.detail?.includes(
          fill(W.workspaceWillStayFile, { files: MD, editor: W.source, file: '.vscode/settings.json' }),
        ),
        `the question says the workspace keeps its own editor: ${prompts[0]!.detail}`,
      );
      assert.equal(r.written, true);
      assert.equal(
        r.message,
        `${fill(W.nowOpenRich, { files: W.markdownFiles, rich: RICH_FIRST })} ${WORKSPACE_STILL}`,
      );
      assert.deepEqual(r.buttons, [OPEN_WORKSPACE_SETTINGS]);
      assert.deepEqual(userSettings()[KEY], { '*.md': 'tandemMarkdown.editor', '*.markdown': 'tandemMarkdown.editor' });

      prompts.length = 0;
      r = await run('tandemMarkdown.useByDefault');
      assert.equal(prompts.length, 0);
      assert.equal(r.written, false);
      assert.equal(r.message, `${RICH_ALREADY} ${WORKSPACE_STILL}`);
      assert.deepEqual(r.buttons, [OPEN_WORKSPACE_SETTINGS]);

      // VS Code's own steps back to another editor would save the choice in the workspace's
      // settings, which set the key: the question gives the user settings' entries to edit instead.
      await setAssociations({ '*.md': CLAIMING_NOTEBOOK_TYPE });
      answer = DONT_CHANGE;
      prompts.length = 0;
      await run('tandemMarkdown.useByDefault');
      const byHand = fill(W.undoByHand, {
        changes: listed([
          fill(W.entryBack, { pattern: '*.md', entry: CLAIMING_NOTEBOOK_TYPE }),
          fill(W.entryOut, { pattern: '*.markdown' }),
        ]),
      });
      assert.ok(prompts[0]?.detail?.endsWith(byHand), `the question gives the entries to edit: ${prompts[0]?.detail}`);
    } finally {
      await vscode.workspace.getConfiguration().update(KEY, undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
