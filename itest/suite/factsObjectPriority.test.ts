/// <reference types="mocha" />
// Facts, measured once (itest/suite/facts.ts): what each version of VS Code makes of a custom
// editor whose priority is an object of priorities by context (`{ textEditor, diffEditor }`, the
// form VS Code 1.146 reads), declared by a stand-in editor in the test helper. While an older
// version reads the object as "default", Tandem Markdown cannot declare its priority so. Every
// user-level setting written is put back.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  OBJECT_PRIORITY_EXTENSION,
  OBJECT_PRIORITY_VIEW_TYPE,
  type HelperExports,
} from '../helper/objectPriorityEditor';
import { name as helperName, publisher as helperPublisher } from '../helper/package.json';
import { describeActiveTab, factsSuite, release } from './facts';
import { api, closeEverything, holdsWithin, note, writeFile } from './helpers';
import { assertTestUserSettings, keepUserSetting, setUserSetting } from './userSettings';

const ASSOCIATIONS = 'workbench.editorAssociations';
const DIFF_ASSOCIATIONS = 'workbench.diffEditorAssociations';

// What was opened.
const TEXT_COMPARISON = 'text comparison';
const STAND_IN_PAIR = 'two stand-in tabs side by side';
const STAND_IN = 'the stand-in editor';
const TEXT_EDITOR = 'text editor';

/** How long VS Code and the stand-in are given to show both sides of a comparison. */
const SIDES_MS = 15_000;

/** What reading each release's workbench predicts. A release not listed here was not read. */
const OBJECT_PRIORITY_READ: Record<string, Record<string, string>> = {};
{
  // 1.120 and 1.123 read an object priority as "default": the stand-in opens files by itself.
  const older = {
    'Open With': STAND_IN,
    'open, no association': STAND_IN,
    'vscode.diff, associated': STAND_IN_PAIR,
  };
  OBJECT_PRIORITY_READ['1.120'] = older;
  OBJECT_PRIORITY_READ['1.123'] = older;
  OBJECT_PRIORITY_READ['1.146'] = {
    'Open With': STAND_IN,
    'open, no association': TEXT_EDITOR,
    'vscode.diff, associated': TEXT_COMPARISON,
  };
}

async function helperExports(): Promise<HelperExports> {
  const helper = vscode.extensions.getExtension<HelperExports>(`${helperPublisher}.${helperName}`);
  if (!helper) throw new Error('The test helper extension is not loaded');
  return helper.activate();
}

/** Records what `open` brought up, as one of the outcomes above or the tab it left in words. */
async function opened(open: () => Thenable<unknown>, sides: vscode.Uri[]): Promise<string> {
  const helper = await helperExports();
  const standInBefore = helper.objectPriorityShown().length;
  await closeEverything();
  await open();
  await holdsWithin(SIDES_MS, () => vscode.window.tabGroups.activeTabGroup.activeTab !== undefined);
  const input: unknown = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff) return TEXT_COMPARISON;
  if (input instanceof vscode.TabInputText) return TEXT_EDITOR;
  if (input instanceof vscode.TabInputCustom && input.viewType === OBJECT_PRIORITY_VIEW_TYPE) return STAND_IN;
  if (input === undefined && sides.length === 2) {
    // A comparison of two custom editors: VS Code tells extensions nothing of it, so the
    // stand-in's record says which sides it was asked to show.
    const shown = () => helper.objectPriorityShown().slice(standInBefore);
    const both = () => sides.every((uri) => shown().includes(uri.toString()));
    if (await holdsWithin(SIDES_MS, both)) return STAND_IN_PAIR;
  }
  return describeActiveTab();
}

factsSuite('Facts: a custom editor whose priority is written as an object', () => {
  const restores: (() => Promise<void>)[] = [];

  suiteSetup(async () => {
    assertTestUserSettings(await api());
    restores.push(keepUserSetting(ASSOCIATIONS), keepUserSetting(DIFF_ASSOCIATIONS));
  });

  teardown(async () => {
    await closeEverything();
    for (const restore of restores) await restore();
  });

  test('a custom editor declares its priority as an object { textEditor, diffEditor }', async () => {
    const one = writeFile(`facts/object-priority/one.${OBJECT_PRIORITY_EXTENSION}`, 'one\n');
    const two = writeFile(`facts/object-priority/two.${OBJECT_PRIORITY_EXTENSION}`, 'two\n');
    await setUserSetting(ASSOCIATIONS, undefined);
    await setUserSetting(DIFF_ASSOCIATIONS, undefined);
    const seen: Record<string, string> = {};
    // It registers: Open With opens it.
    seen['Open With'] = await opened(
      () => vscode.commands.executeCommand('vscode.openWith', one, OBJECT_PRIORITY_VIEW_TYPE),
      [one],
    );
    // `textEditor: "option"`: a plain open is VS Code's text editor, unless the object is misread.
    seen['open, no association'] = await opened(() => vscode.commands.executeCommand('vscode.open', one), [one]);
    // `diffEditor: "explicit"`: a comparison stays text even while the editor is the default.
    await setUserSetting(ASSOCIATIONS, { [`*.${OBJECT_PRIORITY_EXTENSION}`]: OBJECT_PRIORITY_VIEW_TYPE });
    seen['vscode.diff, associated'] = await opened(
      () => vscode.commands.executeCommand('vscode.diff', one, two, 'one and two'),
      [one, two],
    );

    for (const [name, outcome] of Object.entries(seen)) note(`VS Code ${vscode.version}, ${name}: ${outcome}`);
    const expected = OBJECT_PRIORITY_READ[release()];
    if (!expected) {
      note(`VS Code ${release()} was not read, so what was seen is recorded and not compared`);
      return;
    }
    assert.deepEqual(seen, expected, `what VS Code ${vscode.version} did, against what reading its source predicts`);
  });
});
