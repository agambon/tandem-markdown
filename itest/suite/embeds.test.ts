/// <reference types="mocha" />
// Embedded notes and links to blocks in a real VS Code, from the host's side: what an embed
// shows of a note (the whole note, a heading's section, a block), what it says when it cannot,
// that it reads a note open in an editor with its unsaved edits and never one over
// EMBED_MAX_BYTES; what a link to a block previews; and that a panel draws an embed. It asks
// through the test hook's `embedNote` and `previewNote`, which run the same functions as the
// panel's requests. How embeds look is checked in the browser (harness/tests/drawn.spec.mjs).

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { EMBED_MAX_BYTES } from '../../src/host/model/noteSection';
import { activeTabIsRich, api, closeEverything, openRich, openText, waitFor, writeFile } from './helpers';

suite('Embedded notes', () => {
  let from: vscode.Uri;
  const embed = async (target: string) => (await api()).embedNote(from, target);

  suiteSetup(async () => {
    from = writeFile('embeds/From.md', '# From\n\n![[Embedded]]\n');
    writeFile(
      'embeds/Embedded.md',
      '---\ntitle: e\n---\n# Embedded\n\nIntro.\n\n## Part\n\nA line. ^line-1\n\n## Other\n\nLast.\n',
    );
    writeFile('embeds/Big.md', `# Big\n\n${'x'.repeat(EMBED_MAX_BYTES + 1024)}\n`);
    // The link index may have been built by an earlier test file; the new files reach it a moment later.
    await waitFor(async () => 'path' in (await embed('Embedded')), 'the link index to hold the files just written');
  });

  suiteTeardown(closeEverything);

  test('an embed shows the note after its front matter, a section, or a block', async () => {
    assert.deepEqual(await embed('Embedded'), {
      path: 'embeds/Embedded.md',
      title: 'Embedded',
      text: '# Embedded\n\nIntro.\n\n## Part\n\nA line. ^line-1\n\n## Other\n\nLast.',
    });
    assert.deepEqual(await embed('Embedded#Part'), {
      path: 'embeds/Embedded.md',
      title: 'Embedded',
      text: '## Part\n\nA line. ^line-1',
    });
    assert.deepEqual(await embed('Embedded#^line-1'), {
      path: 'embeds/Embedded.md',
      title: 'Embedded',
      text: 'A line. ^line-1',
    });
  });

  test('an embed says why when there is nothing to show', async () => {
    assert.deepEqual(await embed('Nowhere'), { reason: 'No note named “Nowhere” in this workspace.' });
    assert.deepEqual(await embed('Embedded#Missing'), { reason: 'No heading “Missing” in “Embedded”.' });
    assert.deepEqual(await embed('Embedded#^none'), { reason: 'No block “^none” in “Embedded”.' });
    assert.deepEqual(await embed('Big'), { reason: `Not shown: “Big” is larger than ${EMBED_MAX_BYTES / 1024} KB.` });
  });

  test('an embed of a note open in an editor shows its unsaved edits', async () => {
    const uri = vscode.Uri.joinPath(from, '..', 'Embedded.md');
    const editor = await openText(uri);
    await editor.edit((edit) => edit.replace(new vscode.Range(5, 0, 5, 6), 'Edited.'));
    const shown = await embed('Embedded');
    assert.ok('text' in shown && shown.text.includes('Edited.'), JSON.stringify(shown));
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('a link to a block previews the block', async () => {
    const preview = await (await api()).previewNote(from, 'wikilink', 'Embedded#^line-1');
    assert.deepEqual(preview, { title: 'Embedded', text: 'A line. ^line-1', path: 'embeds/Embedded.md' });
  });

  test('a panel draws the embed without a fault', async () => {
    const hook = await api();
    hook.clearRecords();
    await openRich(from);
    await waitFor(
      async () => (await hook.panelState(from)).widgets.some((w) => w.includes('tm-drawn-embed')),
      'the embed to be drawn',
    );
    const state = await hook.panelState(from);
    assert.deepEqual(state.cspViolations, []);
    // Warnings and errors only: the trace of the embedded note's own file names it too.
    const lines = hook
      .logLines()
      .filter((line) => line.level === 'warn' || line.level === 'error')
      .map((line) => JSON.stringify(line));
    assert.ok(!lines.some((line) => /embed|failed in/i.test(line)), lines.join('\n'));
  });
});

/** A 1 by 1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A note embedded deep: a picture, a link and an embed, each written from its own folder. */
const DEEP = (name: string, next: string) =>
  `# ${name}\n\n![picture](pic.png)\n\n[sibling](Sibling.md)\n\n![[${next}]]\n`;

suite('Notes embedded two and three deep', () => {
  // Top embeds A, A embeds B (two deep), B embeds C (three deep). Each of B and C has a picture,
  // a sibling note and a Leaf note in its own folder; Top's folder has a Leaf and nothing else.
  const B = 'deep/one/two/B.md';
  const C = 'deep/one/two/three/C.md';
  let top: vscode.Uri;

  suiteSetup(async () => {
    top = writeFile('deep/Top.md', '# Top\n\n![[A]]\n');
    writeFile('deep/Leaf.md', '# Leaf beside Top\n');
    writeFile('deep/one/A.md', '# A\n\n![[B]]\n');
    writeFile(B, DEEP('B', 'C'));
    writeFile(C, DEEP('C', 'Leaf'));
    for (const folder of ['deep/one/two', 'deep/one/two/three']) {
      writeFile(`${folder}/pic.png`, PNG);
      writeFile(`${folder}/Sibling.md`, `# Sibling in ${folder}\n`);
      writeFile(`${folder}/Leaf.md`, `# Leaf in ${folder}\n`);
    }
    await waitFor(
      async () => 'path' in (await (await api()).embedNote(top, 'deep/one/two/three/Leaf')),
      'the link index to hold the files just written',
    );
  });

  teardown(closeEverything);

  const request = async (message: Parameters<Awaited<ReturnType<typeof api>>['request']>[1]) =>
    (await api()).request(top, message);

  test('the page draws the first embed, and each embedded note embeds the next', async () => {
    const hook = await api();
    await openRich(top);
    await waitFor(
      async () => (await hook.panelState(top)).widgets.some((w) => w.includes('tm-drawn-embed')),
      'the embed to be drawn',
    );
    const answers = (await request({ type: 'embedNotes', targets: ['B'], note: 'deep/one/A.md' })) as Record<
      string,
      { path?: string }
    >;
    assert.equal(answers.B?.path, B);
    const third = (await request({ type: 'embedNotes', targets: ['C'], note: B })) as Record<string, { path?: string }>;
    assert.equal(third.C?.path, C);
  });

  test('a picture in a note two or three deep is read from its own folder', async () => {
    await openRich(top);
    const picture = async (note?: string) => {
      const found = (await request({
        type: 'resolveImages',
        sources: ['pic.png'],
        ...(note ? { note } : {}),
      })) as Record<string, { uri?: string; reason?: string }>;
      return found['pic.png'];
    };
    const shown = (answer: { uri?: string } | undefined) => decodeURIComponent(answer?.uri ?? '');
    assert.ok(shown(await picture(B)).endsWith('/deep/one/two/pic.png'), JSON.stringify(await picture(B)));
    assert.ok(shown(await picture(C)).endsWith('/deep/one/two/three/pic.png'), JSON.stringify(await picture(C)));
    assert.ok((await picture())?.reason, "Top's own folder has no pic.png");
  });

  test('an embed in a note two or three deep is read from its own folder', async () => {
    await openRich(top);
    const leaf = async (note?: string) =>
      (
        (await request({ type: 'embedNotes', targets: ['Leaf'], ...(note ? { note } : {}) })) as Record<
          string,
          { path?: string }
        >
      ).Leaf?.path;
    assert.equal(await leaf(B), 'deep/one/two/Leaf.md');
    assert.equal(await leaf(C), 'deep/one/two/three/Leaf.md');
    assert.equal(await leaf(), 'deep/Leaf.md');
  });

  test('a link in a note two or three deep opens the file in its own folder', async () => {
    for (const [note, folder] of [
      [B, 'deep/one/two'],
      [C, 'deep/one/two/three'],
    ] as const) {
      await openRich(top);
      await request({ type: 'openLink', kind: 'file', href: 'Sibling.md', mode: 'edit', note });
      const sibling = vscode.Uri.joinPath(top, '..', '..', folder, 'Sibling.md');
      await waitFor(() => activeTabIsRich(sibling), `${folder}/Sibling.md to open`);
      await closeEverything();
    }
  });
});
