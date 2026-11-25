/// <reference types="mocha" />
// VS Code's own markdown features for a document open only in the rich editor, in a real VS
// Code: Rename (the panel's `rename` command, which VS Code's rename provider answers and VS
// Code applies to every file it touches), suggestions for a link's address (the test hook's
// `completions`, the function that answers the panel's request) and the markdown link check's
// warnings for a link to a missing file, which reach the panel as underlines. The link check
// asks for a file's problems only while a tab shows it, and VS Code's markdown extension counts
// a custom editor's tab only from VS Code 1.146 (of the versions tried; 1.123 does not): before
// that, a file open only in the rich editor is not checked, and that test is skipped.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  api,
  closeEverything,
  documentFor,
  note,
  openRich,
  openText,
  setSetting,
  waitFor,
  writeFile,
  type TandemMarkdownTestApi,
} from './helpers';

type State = Awaited<ReturnType<Awaited<ReturnType<typeof api>>['panelState']>>;

/** VS Code's markdown language server reads the workspace before it answers; this is a guard against a hang. */
const LANGUAGE_SERVER_MS = 30_000;

/**
 * VS Code's markdown link check reports a moment after its language server has read the
 * workspace; on a machine under load that can take this long. A guard against a hang.
 */
const LINK_CHECK_MS = 90_000;

const BROKEN = ['# Broken', '', 'A [link to nothing](missing-note.md).', ''].join('\n');

/**
 * Whether this VS Code's markdown extension checks a file open only in a custom editor. Its
 * language client asks for a file's problems only while a tab shows the file, and it counts a
 * custom editor's tab (`TabInputCustom`) only in later versions; this reads the extension's own code.
 */
function markdownChecksCustomEditorTabs(): boolean {
  const markdown = vscode.extensions.getExtension('vscode.markdown-language-features');
  if (!markdown) return false;
  const main = String(markdown.packageJSON.main);
  const code = readFileSync(path.join(markdown.extensionPath, main.endsWith('.js') ? main : `${main}.js`), 'utf8');
  return code.includes('TabInputCustom');
}

/** Waits for VS Code's link check to report the missing file, then for its warning to reach the panel. */
async function expectLinkWarning(hook: TandemMarkdownTestApi, uri: vscode.Uri): Promise<void> {
  const start = Date.now();
  await waitFor(
    () => vscode.languages.getDiagnostics(uri).some((d) => d.message.includes('missing-note')),
    "VS Code's link check to report the missing file",
    LINK_CHECK_MS,
  );
  note(`VS Code's link check reported after ${Date.now() - start} ms`);
  let state: State | null = null;
  await waitFor(async () => {
    state = await hook.panelState(uri);
    return state.diagnostics.some((d) => state!.text.slice(d.from, d.to).includes('missing-note'));
  }, 'the warning to reach the panel');
  note(`problems in the panel: ${JSON.stringify(state!.diagnostics)}`);
}

const GUIDE = '# Guide\n\n## Getting started\n\nThe first steps.\n\nSee [x](./\n\nAnd [y](#\n';
const INDEX = 'Start with [the guide](Guide.md#getting-started).\n';

suite("VS Code's markdown features in the rich editor", () => {
  let guide: vscode.Uri;
  let index: vscode.Uri;

  suiteSetup(() => {
    guide = writeFile('language/Guide.md', GUIDE);
    index = writeFile('language/Index.md', INDEX);
    writeFile('language/pictures/diagram.png', 'not really a picture');
  });

  teardown(async () => {
    await closeEverything();
  });

  test("suggestions for a link's address list the note's folder and its headings", async () => {
    const hook = await api();
    await openRich(guide);
    const afterDotSlash = GUIDE.indexOf('[x](./') + '[x](./'.length;
    let result = await hook.completions(guide, afterDotSlash, '/');
    await waitFor(
      async () => {
        result = await hook.completions(guide, afterDotSlash, '/');
        return 'items' in result && result.items.some((i) => i.label === 'Index.md');
      },
      'the files beside the note to be suggested',
      LANGUAGE_SERVER_MS,
    );
    note(`after "./": ${JSON.stringify(result)}`);
    assert.ok('items' in result);
    assert.equal(result.from, afterDotSlash);
    const folder = result.items.find((i) => i.label.startsWith('pictures'));
    assert.ok(folder, 'the folder beside the note is suggested');
    assert.equal(folder.again, true, 'choosing a folder asks for suggestions again');

    const afterHash = GUIDE.indexOf('[y](#') + '[y](#'.length;
    result = await hook.completions(guide, afterHash, '#');
    note(`after "#": ${JSON.stringify(result)}`);
    assert.ok(
      'items' in result && result.items.some((i) => i.insert.includes('getting-started')),
      'a heading is suggested',
    );
  });

  test('rename on a heading renames it and the links to it in other files', async () => {
    const hook = await api();
    await openRich(guide);
    const at = GUIDE.indexOf('Getting started') + 3;
    await hook.runInPanel(guide, [
      { type: 'select', anchor: at, head: at },
      { type: 'command', id: 'rename', args: { newName: 'First steps' } },
    ]);
    let state: State | null = null;
    await waitFor(
      async () => {
        state = await hook.panelState(guide);
        return state.text.includes('## First steps\n');
      },
      'the rename to reach the panel',
      LANGUAGE_SERVER_MS,
    );
    assert.equal(documentFor(guide)?.getText(), state!.text);
    // VS Code saves the other file as part of the rename, and it does not stay open with no editor showing it.
    const otherFile = (): string => documentFor(index)?.getText() ?? readFileSync(index.fsPath, 'utf8');
    await waitFor(() => otherFile().includes('(Guide.md#first-steps)'), 'the link in the other file to be renamed too');
    note(`the other file now reads: ${JSON.stringify(otherFile())}`);
    assert.deepEqual(state!.outsideMarked, [], "a rename the user asked for is not marked as another program's change");
  });

  test("the link check's warning for a missing file reaches the panel while Source also shows the file", async function () {
    this.timeout(2 * LINK_CHECK_MS);
    const hook = await api();
    const restore = await setSetting('markdown', 'validate.enabled', true);
    try {
      const uri = writeFile('language/Broken beside.md', BROKEN);
      await openRich(uri);
      await openText(uri, vscode.ViewColumn.Beside);
      await expectLinkWarning(hook, uri);
    } finally {
      await restore();
    }
  });

  test("the link check's warning reaches the panel for a file open only in the rich editor", async function () {
    this.timeout(2 * LINK_CHECK_MS);
    if (!markdownChecksCustomEditorTabs()) {
      note(
        `skipped: VS Code ${vscode.version}'s markdown extension checks links only in files open in a text editor (its language client counts text and diff tabs, not custom editor tabs)`,
      );
      this.skip();
    }
    const hook = await api();
    const restore = await setSetting('markdown', 'validate.enabled', true);
    try {
      const uri = writeFile('language/Broken.md', BROKEN);
      await openRich(uri);
      assert.ok(
        vscode.window.visibleTextEditors.every((e) => e.document.uri.toString() !== uri.toString()),
        'no text editor shows the file',
      );
      await expectLinkWarning(hook, uri);
    } finally {
      await restore();
    }
  });
});
