// The time from a key press to the frame that shows the typed letter, in a 100 KB and a 1 MB
// note (scripts/speed/note.mjs), in the installed Chrome, headless. Uses the harness page: the
// real panel with every default syntax on, against the fake host in the same page. The harness's
// own document and disk boxes are kept empty, since at 1 MB they cost more than the panel. Each
// letter is typed in the middle of the note once the one before it has been drawn, so slow
// letters do not pile up. No letter ends a word, so the panel sends the typing as it does in a
// long word: when the oldest unsent letter is OLDEST_MS old (src/panel/sync.ts).
//
//   node scripts/speed/typing.mjs [--letters 40]

import { chromium } from 'playwright-core';
import { serveOwnBuild } from '../../harness/serve.mjs';
import { numberOption, quantile } from './measure.mjs';
import { note } from './note.mjs';
import { harnessPage, timeKeys } from './page.mjs';

const letters = numberOption('--letters', 40);
/** Pause between letters: well under the panel's wait before it sends typing that stopped. */
const PAUSE_MS = 60;

const server = await serveOwnBuild('typing');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  for (const chars of [100_000, 1_000_000]) {
    const text = note(chars, 7);
    const { page, errors } = await harnessPage(browser, server);
    await page.evaluate((t) => window.__harness.open(t, 'speed.md'), text);
    // Let the first drawing, the background parse and the libraries loaded on demand finish.
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const view = window.__harness.view;
      const middle = view.state.doc.lineAt(Math.floor(view.state.doc.length / 2));
      view.dispatch({ selection: { anchor: middle.to }, scrollIntoView: true });
      view.focus();
    });
    await timeKeys(page);
    await page.waitForTimeout(500);
    for (let i = 0; i < letters; i++) {
      await page.keyboard.press('x');
      await page.waitForFunction((n) => window.__keyToFrame.length > n, i);
      await page.waitForTimeout(PAUSE_MS);
    }
    const times = (await page.evaluate(() => window.__keyToFrame)).sort((a, b) => a - b);
    const updates = (await page.evaluate(() => window.__update)).sort((a, b) => a - b);
    const typed = await page.evaluate((n) => window.__harness.view.state.doc.length - n, text.length);
    console.log(
      `${(text.length / 1000).toFixed(0)} KB, ${text.split('\n').length} lines: a letter to the screen ` +
        `median ${quantile(times, 0.5).toFixed(1)} ms, 95th percentile ${quantile(times, 0.95).toFixed(1)} ms, ` +
        `most ${times[times.length - 1].toFixed(1)} ms; the panel's own update median ` +
        `${quantile(updates, 0.5).toFixed(1)} ms (${times.length} letters, ${typed} typed)` +
        (errors.length ? `; page errors: ${errors.join('; ')}` : ''),
    );
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
