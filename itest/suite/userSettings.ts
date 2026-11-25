// The test copy's own user settings, for the files that write a user-level setting: where the
// settings file is, the guard that it is the test copy's, and writing a setting and putting it back.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TandemMarkdownTestApi } from './helpers';

/** The test copy's user settings file: <user data>/User/settings.json, beside <user data>/User/globalStorage. */
export function userSettingsFile(hook: TandemMarkdownTestApi): string {
  return path.resolve(hook.globalStorageUri.fsPath, '..', '..', 'settings.json');
}

/**
 * Fails unless the user settings file is inside the test copy's user data folder
 * (TM_ITEST_USER_DATA, set by itest/runTest.ts), so a test that writes a user-level setting
 * can never write the settings of a VS Code someone uses.
 */
export function assertTestUserSettings(hook: TandemMarkdownTestApi): void {
  const userData = process.env.TM_ITEST_USER_DATA ?? '';
  const settings = userSettingsFile(hook);
  const relative = path.relative(userData, settings);
  assert.ok(
    userData !== '' && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
    `the user settings file ${settings} must be under ${userData} before anything is written`,
  );
}

/** Reads a user-level setting and returns a function that puts it back as it was. */
export function keepUserSetting(key: string): () => Promise<void> {
  const before = vscode.workspace.getConfiguration().inspect(key)?.globalValue;
  return async () => {
    await vscode.workspace.getConfiguration().update(key, before, vscode.ConfigurationTarget.Global);
  };
}

export async function setUserSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
}
