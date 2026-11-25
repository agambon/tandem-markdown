/// <reference types="mocha" />
// What a link's hover card may show of the note it points to, from the host's side. The path
// comes from a panel message, so this checks in a real VS Code that only markdown files inside
// the workspace are read, never through a junction or symbolic link, never over
// NOTE_PREVIEW_MAX_BYTES, and never anything outside the workspace however the address is
// written. It asks through the test hook's `previewNote`, which runs the same function as the
// panel's `previewNote` request.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../../src/core/errors';
import { NOTE_PREVIEW_CHARS, NOTE_PREVIEW_MAX_BYTES } from '../../src/host/model/notePreviewText';
import { api, closeEverything, note, openText, waitFor, workspaceDir, writeFile } from './helpers';

suite('The start of a linked note', () => {
  let from: vscode.Uri;
  let outside = '';
  let fileLink = false;

  const preview = async (kind: 'wikilink' | 'file', address: string) => (await api()).previewNote(from, kind, address);

  suiteSetup(() => {
    from = writeFile('preview/From.md', '# From\n\nLinks live here.\n');
    writeFile('preview/Target.md', '---\ntitle: t\n---\n# Target Note\n\nThe body of the target.\n');
    writeFile('preview/Sub/Deep.md', 'No heading, just text.\n');
    writeFile('preview/Big.md', `# Big\n\n${'x'.repeat(NOTE_PREVIEW_MAX_BYTES + 1024)}\n`);
    writeFile('preview/data.txt', 'not markdown\n');
    // A folder beside the workspace, and ways into it from inside.
    outside = path.join(path.dirname(workspaceDir()), 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'Secret.md'), '# Secret\n\nNot for the card.\n');
    symlinkSync(outside, path.join(workspaceDir(), 'preview', 'linked'), 'junction');
    try {
      symlinkSync(path.join(outside, 'Secret.md'), path.join(workspaceDir(), 'preview', 'filelink.md'), 'file');
      fileLink = true;
    } catch (error) {
      note(`a file symbolic link could not be made here (${errorMessage(error)}); that case is not checked`);
    }
  });

  suiteTeardown(async () => {
    await closeEverything();
    const linked = path.join(workspaceDir(), 'preview', 'linked');
    // A junction on Windows is removed with rmdirSync; on POSIX it is a symbolic link, removed with unlinkSync.
    if (process.platform === 'win32') rmdirSync(linked);
    else unlinkSync(linked);
    if (fileLink) rmSync(path.join(workspaceDir(), 'preview', 'filelink.md'), { force: true });
    // Windows can keep a folder busy for seconds after it was read, above all through a network
    // path as one case here does. The next run makes the folder again, so one left behind is no fault.
    try {
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      note(
        `the folder beside the workspace could not be removed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  });

  test('a resolved wikilink and links to markdown files in the workspace show the note', async () => {
    const expected = { title: 'Target Note', text: 'The body of the target.', path: 'preview/Target.md' };
    // When an earlier test file has built the workspace's link index, the files written in
    // suiteSetup reach it through its file watcher, a moment later.
    await waitFor(
      async () => (await preview('wikilink', 'Target')) !== null,
      'the link index to hold the files just written',
    );
    assert.deepEqual(await preview('wikilink', 'Target'), expected);
    assert.deepEqual(await preview('file', 'Target.md'), expected);
    assert.deepEqual(await preview('file', 'Target.md#Some heading'), expected);
    assert.deepEqual(await preview('file', 'Target'), expected, 'a link written without .md');
    assert.deepEqual(await preview('file', '/preview/Target.md'), expected, 'a path from the workspace folder');
    assert.deepEqual(await preview('file', 'Sub/../Target.md'), expected, '.. that stays inside');
    assert.deepEqual(await preview('file', 'Sub/Deep.md'), {
      title: 'Deep',
      text: 'No heading, just text.',
      path: 'preview/Sub/Deep.md',
    });
  });

  test('nothing for a missing link or a file that is not markdown', async () => {
    assert.equal(await preview('wikilink', 'Nowhere'), null);
    assert.equal(await preview('file', 'Nowhere.md'), null);
    assert.equal(await preview('file', 'data.txt'), null);
    assert.equal(await preview('file', 'Sub'), null, 'a folder');
    assert.equal(await preview('file', 'https://example.com/a.md'), null);
  });

  test('nothing outside the workspace, however the address is written', async () => {
    const secret = path.join(outside, 'Secret.md');
    assert.ok(existsSync(secret));
    assert.equal(await preview('file', '../../outside/Secret.md'), null);
    assert.equal(await preview('file', '..\\..\\outside\\Secret.md'), null);
    assert.equal(await preview('file', secret), null, 'a drive path');
    assert.equal(await preview('file', secret.replace(/\\/g, '/')), null);
    assert.equal(await preview('file', vscode.Uri.file(secret).toString()), null, 'a file: address');
    assert.equal(await preview('file', `\\\\localhost\\${secret[0]}$\\${secret.slice(3)}`), null, 'a UNC path');
    assert.equal(await preview('file', '/../outside/Secret.md'), null);
    assert.equal(await preview('file', 'Target.md:stream.md'), null, 'an alternate data stream');
  });

  test('nothing through a junction or a symbolic link', async () => {
    assert.ok(
      existsSync(path.join(workspaceDir(), 'preview', 'linked', 'Secret.md')),
      'the file is there through the junction',
    );
    assert.equal(await preview('file', 'linked/Secret.md'), null);
    assert.equal(await preview('wikilink', 'linked/Secret'), null);
    assert.equal(await preview('wikilink', 'Secret'), null);
    if (fileLink) assert.equal(await preview('file', 'filelink.md'), null);
  });

  test('nothing from a file over the size limit unless VS Code already holds it', async () => {
    assert.equal(await preview('file', 'Big.md'), null);
    await openText(vscode.Uri.file(path.join(workspaceDir(), 'preview', 'Big.md')));
    const open = await preview('file', 'Big.md');
    assert.equal(open?.title, 'Big');
    assert.equal(
      Array.from(open?.text ?? '').length,
      NOTE_PREVIEW_CHARS + 1,
      'the first NOTE_PREVIEW_CHARS characters and the mark that more follows',
    );
  });
});
