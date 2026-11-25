/// <reference types="mocha" />
// Facts, measured once (itest/suite/facts.ts): whether VS Code applies a `"[markdown]"` block of
// the user's settings to a setting declared with `resource` scope, not `language-overridable`.
// `tandemMarkdown.conflictFiles` is such a setting. It is read for a markdown file by its uri
// alone, and by its uri with markdown's language (`markdownScope` in src/host/settings.ts). The
// user settings' `[markdown]` block is put back as it was.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { factsSuite, release } from './facts';
import { api, note, waitFor, writeFile } from './helpers';
import { assertTestUserSettings, keepUserSetting, setUserSetting } from './userSettings';

const MARKDOWN_BLOCK = '[markdown]';
const SECTION = 'tandemMarkdown';
const KEY = 'conflictFiles';

type Reads = Record<'uri alone' | 'uri and markdown', unknown>;

/**
 * What reading each release predicts, with the block set to false. A release not listed was not
 * read. In 1.120 and 1.146 the settings file's parser keeps every key inside a language block,
 * whatever its scope (`ConfigurationModelParser.filter`), and a read that names the language
 * merges the block over the rest (`ConfigurationModel.createOverrideConfigurationModel`).
 */
const READ: Record<string, Reads> = {
  '1.120': { 'uri alone': true, 'uri and markdown': false },
  '1.146': { 'uri alone': true, 'uri and markdown': false },
};

function reads(uri: vscode.Uri): Reads {
  return {
    'uri alone': vscode.workspace.getConfiguration(SECTION, uri).get(KEY),
    'uri and markdown': vscode.workspace.getConfiguration(SECTION, { uri, languageId: 'markdown' }).get(KEY),
  };
}

function userMarkdownBlock(): Record<string, unknown> | undefined {
  return vscode.workspace.getConfiguration().inspect<Record<string, unknown>>(MARKDOWN_BLOCK)?.globalValue;
}

factsSuite("Facts: a [markdown] block of the user's settings, for a setting of resource scope", () => {
  let restore: (() => Promise<void>) | null = null;

  suiteSetup(async () => {
    assertTestUserSettings(await api());
    restore = keepUserSetting(MARKDOWN_BLOCK);
  });

  suiteTeardown(async () => {
    await restore?.();
  });

  test('tandemMarkdown.conflictFiles set false in [markdown], read by uri alone and with markdown', async () => {
    const uri = writeFile('facts/language-override/Field notes.md', 'The cat sat on the mat.\n');
    assert.deepEqual(reads(uri), { 'uri alone': true, 'uri and markdown': true }, 'the default, before the block');

    await setUserSetting(MARKDOWN_BLOCK, { ...userMarkdownBlock(), [`${SECTION}.${KEY}`]: false });
    await waitFor(() => userMarkdownBlock()?.[`${SECTION}.${KEY}`] === false, 'the block to reach the extension');

    const seen = reads(uri);
    const inspected = vscode.workspace.getConfiguration(SECTION, { uri, languageId: 'markdown' }).inspect(KEY);
    for (const [how, value] of Object.entries(seen)) note(`VS Code ${vscode.version}, read by ${how}: ${value}`);
    note(`VS Code ${vscode.version}, globalLanguageValue: ${String(inspected?.globalLanguageValue)}`);
    const expected = READ[release()];
    if (!expected) {
      note(`VS Code ${release()} was not read, so what was seen is recorded and not compared`);
      return;
    }
    assert.deepEqual(seen, expected, `what VS Code ${vscode.version} read, against what reading its source predicts`);
  });
});
