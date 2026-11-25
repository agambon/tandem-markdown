// A 2 MB note (scripts/speed/note.mjs) with LINKS reference links at the top and their
// definitions at the end, in the installed Chrome, headless, on the harness page (the real panel
// with every default syntax on, the harness's own document and disk boxes kept empty as in
// typing.mjs). With `--inline` the links are inline links and one definition stands at the end,
// which nothing on screen needs. Measures, on PAGES new pages each:
//   - from the start of the open to the first frame that shows the second paragraph of links,
//     and to the first frame that draws its first link as a link (given up after GIVE_UP_MS); the
//     cursor starts in the first paragraph, which shows its source;
//   - a typed letter at the end of the first paragraph of links, from the key to the frame that
//     shows it, once the note has been open for 3 seconds.
//
//   node scripts/speed/definitions.mjs [--inline] [--letters 40]

import { chromium } from 'playwright-core';
import { serveOwnBuild } from '../../harness/serve.mjs';
import { median, numberOption, quantile } from './measure.mjs';
import { note } from './note.mjs';
import { harnessPage, timeKeys } from './page.mjs';

const letters = numberOption('--letters', 40);
const inline = process.argv.includes('--inline');
const LINKS = 1000;
const PAGES = 3;
const GIVE_UP_MS = 20_000;
/** Pause between letters: well under the panel's wait before it sends typing that stopped. */
const PAUSE_MS = 60;

const paragraphs = [];
for (let i = 1; i <= LINKS; i += 10) {
  const links = [];
  for (let j = i; j < i + 10; j++)
    links.push(inline ? `[page ${j}](https://example.com/page-${j})` : `[page ${j}][p${j}]`);
  paragraphs.push(`Read ${links.join(', ')}.`);
}
const definitions = Array.from(
  { length: inline ? 1 : LINKS },
  (_, i) => `[p${i + 1}]: https://example.com/page-${i + 1} "Page ${i + 1}"`,
);
const text = `${paragraphs.join('\n\n')}\n\n${note(2_000_000, 7)}\n${definitions.join('\n')}\n`;

const server = await serveOwnBuild('definitions');
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const shown = [];
  const linked = [];
  const keys = [];
  const updates = [];
  for (let i = 0; i < PAGES; i++) {
    const { page, errors } = await harnessPage(browser, server);
    const opened = await page.evaluate(
      ({ t, giveUp }) =>
        new Promise((resolve) => {
          const start = performance.now();
          let shownAt = null;
          const frame = () => {
            const content = document.querySelector('.cm-content');
            if (shownAt === null && content?.textContent?.includes('page 11')) shownAt = performance.now() - start;
            const first = [...document.querySelectorAll('.cm-content .tm-link')].some(
              (e) => e.textContent === 'page 11',
            );
            if (first) resolve({ shown: shownAt, linked: performance.now() - start });
            else if (performance.now() - start > giveUp) resolve({ shown: shownAt, linked: null });
            else requestAnimationFrame(frame);
          };
          void window.__harness.open(t, 'speed.md');
          requestAnimationFrame(frame);
        }),
      { t: text, giveUp: GIVE_UP_MS },
    );
    shown.push(opened.shown);
    linked.push(opened.linked);
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const view = window.__harness.view;
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(0).to } });
      view.focus();
    });
    await timeKeys(page);
    await page.waitForTimeout(500);
    for (let n = 0; n < letters; n++) {
      await page.keyboard.press('x');
      await page.waitForFunction((count) => window.__keyToFrame.length > count, n);
      await page.waitForTimeout(PAUSE_MS);
    }
    keys.push(...(await page.evaluate(() => window.__keyToFrame)));
    updates.push(...(await page.evaluate(() => window.__update)));
    if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
    await page.close();
  }
  const ms = (v) => (v === null ? `not within ${GIVE_UP_MS / 1000} s` : `${v.toFixed(0)} ms`);
  console.log(`The links shown: ${shown.map(ms).join(', ')} after the open started`);
  console.log(`The links drawn as links: ${linked.map(ms).join(', ')} after the open started`);
  const sorted = [...keys].sort((a, b) => a - b);
  console.log(
    `A letter typed among the links: median ${quantile(sorted, 0.5).toFixed(1)} ms from the key to the frame, ` +
      `95th percentile ${quantile(sorted, 0.95).toFixed(1)} ms; the panel's own update median ` +
      `${median(updates).toFixed(1)} ms (${sorted.length} letters)`,
  );
} finally {
  await browser.close();
  await server.close();
}
