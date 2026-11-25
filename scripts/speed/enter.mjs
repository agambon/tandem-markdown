// Enter at the end of a 2 MB note (scripts/speed/note.mjs ending in a list item), from the key to
// the frame that shows the new item, in the installed Chrome, headless. Uses the harness page: the
// real panel with every default syntax on, against the fake host in the same page, with the
// harness's own document and disk boxes kept empty as in typing.mjs. The note opens with the
// cursor at its top; the cursor is then moved to the end and Enter pressed after each wait of
// WAITS_MS there, in which CodeMirror's own background parse works its way to the cursor.
// Enter parses whatever is left of the note before the cursor first. A second Enter, at once,
// ends the list, on the parse the first one left. Each wait is PAGES new pages.
//
//   node scripts/speed/enter.mjs

import { chromium } from 'playwright-core';
import { serveOwnBuild } from '../../harness/serve.mjs';
import { median } from './measure.mjs';
import { note } from './note.mjs';
import { harnessPage, timeKeys } from './page.mjs';

const WAITS_MS = [0, 1000, 2000, 4000];
const PAGES = 3;

const server = await serveOwnBuild('enter');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const text = `${note(2_000_000, 7)}\n\n- the last item`;

/**
 * Presses Enter and waits for the frame after it: the time from the key to that frame, and how
 * much of it the panel spent applying the edit and drawing it (the rest is mostly the parse).
 */
async function enterTimed(page) {
  await page.evaluate(() => {
    window.__keyToFrame = [];
    window.__update = [];
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__keyToFrame.length > 0);
  return page.evaluate(() => ({ frame: window.__keyToFrame[0], update: window.__update.reduce((a, b) => a + b, 0) }));
}

try {
  const again = [];
  for (const wait of WAITS_MS) {
    const first = [];
    for (let i = 0; i < PAGES; i++) {
      const { page, errors } = await harnessPage(browser, server);
      await page.evaluate((t) => window.__harness.open(t, 'speed.md'), text);
      // Let the first drawing and the libraries loaded on demand finish, with the cursor at the top.
      await page.waitForTimeout(3000);
      await page.evaluate(() => {
        const view = window.__harness.view;
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      });
      await timeKeys(page, { keyOnly: true });
      await page.waitForTimeout(wait);
      first.push(await enterTimed(page));
      const continued = await page.evaluate(() => window.__harness.view.state.doc.toString().endsWith('item\n- '));
      again.push(await enterTimed(page));
      if (!continued) throw new Error('Enter did not continue the list');
      if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
      await page.close();
    }
    console.log(
      `Enter after ${wait / 1000} s at the end: ${median(first.map((r) => r.frame)).toFixed(0)} ms from the key to ` +
        `the frame (median of ${first.length}), of which applying and drawing the edit ` +
        `${median(first.map((r) => r.update)).toFixed(0)} ms`,
    );
  }
  console.log(
    `The second Enter, at once: ${median(again.map((r) => r.frame)).toFixed(0)} ms from the key to the frame ` +
      `(median of ${again.length}), of which applying and drawing the edit ${median(again.map((r) => r.update)).toFixed(0)} ms`,
  );
} finally {
  await browser.close();
  await server.close();
}
