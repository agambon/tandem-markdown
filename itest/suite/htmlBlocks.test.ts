/// <reference types="mocha" />
// HTML blocks, pictures stored in a file and players in a real VS Code, under the page's real
// policy: what the browser specs cannot reach. A link to `#name` goes to an `<a name>`, through
// the host; HTML blocks, a wrapper and a stored picture draw with no policy violation; a sound
// file from the workspace plays only with `tandemMarkdown.syntax.media` on, loaded through the
// host's answer. What each construct draws is checked in the browser
// (harness/tests/syntax.spec.mjs, harness/tests/html.spec.mjs).

import * as assert from 'node:assert/strict';
import { api, openRich, pause, setSetting, undoAfterEach, waitFor, writeFile } from './helpers';

/** A 1 by 1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** How long a refused load takes to be reported, at most. */
const SETTLE_MS = 1500;

/** A tenth of a second of silence: 8-bit mono PCM at 8 kHz, in a WAV file. */
function silence(): Buffer {
  const samples = 800;
  const out = Buffer.alloc(44 + samples, 128);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // one channel
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(8000, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples, 40);
  return out;
}

const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.\n`).join('\n');

suite('HTML blocks, stored pictures and players', () => {
  const restore = undoAfterEach();

  test('a link to #name goes to the anchor of that name when no heading has it', async () => {
    const hook = await api();
    const text = `# Top\n\n[jump](#far-away)\n\n${filler}\n<a name="far-away"></a>\n\nThe target.\n`;
    const uri = writeFile('html/Anchor.md', text);
    await openRich(uri);
    const anchor = text.indexOf('<a name');
    await hook.runInPanel(uri, [
      { type: 'select', anchor: text.indexOf('jump'), head: text.indexOf('jump') },
      { type: 'command', id: 'openLink' },
    ]);
    await waitFor(async () => {
      const { head } = (await hook.panelState(uri)).selection;
      return head >= anchor && head <= text.indexOf('</a>', anchor);
    }, 'the cursor to reach the anchor');
  });

  test('HTML blocks, a wrapper and a stored picture draw under the page policy', async () => {
    const hook = await api();
    writeFile('html/logo.png', Buffer.from(PNG, 'base64'));
    const text = [
      '<details>',
      '<summary>More <b>here</b></summary>',
      '',
      'Inside.',
      '',
      '</details>',
      '',
      '<p align="center">',
      '  <img src="logo.png" width="40" alt="Logo">',
      '</p>',
      '',
      `![dot](data:image/png;base64,${PNG})`,
      '',
    ].join('\n');
    const uri = writeFile('html/Blocks.md', text);
    await openRich(uri);
    await waitFor(async () => {
      const widgets = (await hook.panelState(uri)).widgets.join(' ');
      return (
        widgets.includes('tm-drawn-summary') && widgets.includes('tm-drawn-html') && widgets.includes('tm-image-loaded')
      );
    }, 'the summary, the HTML block and the stored picture');
    await pause(SETTLE_MS);
    const state = await hook.panelState(uri);
    assert.deepEqual(state.cspViolations, []);
    assert.equal(state.text, text, 'the document is as it was');
  });

  test('a sound file plays only with players on, loaded from the workspace under the page policy', async () => {
    const hook = await api();
    writeFile('html/talk.wav', silence());
    const text = '![[talk.wav]]\n\n<audio src="talk.wav" controls autoplay></audio>\n';
    const uri = writeFile('html/Players.md', text);
    await openRich(uri);
    await pause(SETTLE_MS);
    assert.ok(!(await hook.panelState(uri)).widgets.join(' ').includes('tm-media'), 'a player with players off');

    restore.push(await setSetting('tandemMarkdown', 'syntax.media', true));
    await waitFor(async () => {
      const widgets = (await hook.panelState(uri)).widgets;
      return widgets.some((w) => w.includes('tm-media') && w.includes('tm-image-loaded'));
    }, 'the embedded sound file to load in its player');
    await pause(SETTLE_MS);
    const state = await hook.panelState(uri);
    assert.deepEqual(state.cspViolations, []);
    assert.equal(state.text, text, 'the document is as it was');
  });
});
