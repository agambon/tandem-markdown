// The outside-change mark in the installed Chrome, on the two-sided harness page: an outside
// write marks the line it changed and the mark is gone once the fade is over; a line changed while
// the host says the tab is behind another keeps its mark until the tab is shown; typing in Source
// marks nothing; an outside write merged into unsent typing marks the merged line. And what a
// screen reader is told: the editor's live region is given one sentence for an outside write,
// naming the heading it is under and the note, and none for typing in Source.
//
//   node harness/tests/outsideMark.spec.mjs
//
// Builds the harness, serves it on a free port, drives harness/index.html headless, and
// exits 0 when every check passes, 1 otherwise. Checks read the panel through its test hook and
// the page's window.__harness. No screenshots, no timing assertions: the waits are guards against
// a hang.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { pageOpener, settle, typeAtEndInSource, waitFor, waitUntil } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('outsideMark');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

const LINE = 'A second line of the same paragraph';
/** The heading `LINE` is under, in the harness page's note. */
const HEADING = 'Everything Tandem Markdown draws';
/** Longer than the mark's whole fade: FADE_STEPS steps of FADE_STEP_MS (src/panel/render/outsideMark.ts). */
const LONGER_THAN_THE_FADE_MS = 6000;

/** Longer than the panel waits for the note to be quiet before it tells (QUIET_MS in src/panel/announce/index.ts). */
const LONGER_THAN_THE_QUIET_MS = 4000;

/**
 * What the panel says of itself through its test hook: its text, the lines it marks, and what its
 * live region has been given since the hook first answered.
 */
const panel = (page) => page.evaluate(async () => (await window.__harness.host.runInPanel([{ type: 'state' }])).result);

/** The text of each line the panel marks. */
async function marked(page) {
  const { text, outsideMarked } = await panel(page);
  const lines = text.split('\n');
  return outsideMarked.map((n) => ({ text: lines[n - 1] }));
}

/** Waits until the panel marks no line, which takes the whole fade. */
const noneMarked = (page, what) =>
  waitUntil(page, async () => (await panel(page)).outsideMarked.length === 0, what, 10_000);

/** The host tells the panel its tab is shown or not, as VS Code's view state says. */
const tabShown = (page, shown) =>
  page.evaluate((s) => window.__harness.host.post({ type: 'tabShown', shown: s }), shown);

try {
  await check('an outside write marks the line it changed, and the mark is gone after the fade', async () => {
    const page = await pages.harness();
    const disk = await page.evaluate(() => window.__harness.diskText());
    await page.locator('#hx-disk').fill(disk.replace(LINE, 'A second line of the SAME paragraph'));
    await page.locator('#hx-write').click();
    await waitFor(
      page,
      () => (window.__harness.panelText() ?? '').includes('of the SAME paragraph'),
      null,
      'the outside write did not reach the panel',
    );
    const lines = await marked(page);
    expect(lines.length === 1, `${lines.length} lines are marked: ${JSON.stringify(lines.map((l) => l.text))}`);
    expect(lines[0].text.includes('of the SAME paragraph'), `the marked line is "${lines[0].text}"`);
    expect(await page.evaluate(() => window.__harness.agree()), 'the panel and the document do not agree');
    await noneMarked(page, 'the mark is still there after the fade');
  });

  await check('a line changed while the tab is behind another keeps its mark until the tab is shown', async () => {
    const page = await pages.harness();
    await tabShown(page, false);
    const disk = await page.evaluate(() => window.__harness.diskText());
    await page.locator('#hx-disk').fill(disk.replace(LINE, 'A second line of the SAME paragraph'));
    await page.locator('#hx-write').click();
    await waitFor(
      page,
      () => (window.__harness.panelText() ?? '').includes('of the SAME paragraph'),
      null,
      'the outside write did not reach the panel',
    );
    // The promise is that nothing fades in this time.
    await settle(page, LONGER_THAN_THE_FADE_MS);
    const held = await marked(page);
    expect(
      held.length === 1 && held[0].text.includes('of the SAME paragraph'),
      `behind another tab, the marked lines are ${JSON.stringify(held.map((l) => l.text))}`,
    );
    await tabShown(page, true);
    await noneMarked(page, 'the mark is still there after the fade, once the tab was shown');
  });

  await check('typing in Source marks nothing', async () => {
    const page = await pages.harness();
    await typeAtEndInSource(page, '\nTyped in Source.');
    const lines = await marked(page);
    expect(lines.length === 0, `typing in Source marked ${JSON.stringify(lines.map((l) => l.text))}`);
  });

  await check('an outside write merged into unsent typing marks the merged line', async () => {
    const page = await pages.harness();
    await page.locator('#tm-root .cm-line', { hasText: LINE }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed ');
    await waitFor(
      page,
      () => window.__harness.documentText().includes(' typed '),
      null,
      'the typing did not reach the document',
    );
    const disk = await page.evaluate(() => window.__harness.diskText());
    await page.evaluate(
      (text) => window.__harness.host.writeOutside(text),
      disk.replace('## Headings', '## Headings\n\nOutside line.'),
    );
    await waitFor(
      page,
      () => (window.__harness.panelText() ?? '').includes('\n\nOutside line.\n'),
      null,
      'the outside write was not merged into the panel',
    );
    // The write added two lines, a blank one and "Outside line.": both are marked, the heading above them is not.
    const texts = (await marked(page)).map((l) => l.text).sort();
    expect(
      JSON.stringify(texts) === JSON.stringify(['', 'Outside line.']),
      `the marked lines are ${JSON.stringify(texts)}`,
    );
  });

  await check('an outside write is told to a screen reader once, and typing in Source is not', async () => {
    const page = await pages.harness();
    const from = (await panel(page)).announced.length;
    const toldSince = async () => (await panel(page)).announced.slice(from);
    const disk = await page.evaluate(() => window.__harness.diskText());
    await page.locator('#hx-disk').fill(disk.replace(LINE, 'A second line of the SAME paragraph'));
    await page.locator('#hx-write').click();
    await waitUntil(page, async () => (await toldSince()).length > 0, 'nothing was told of the outside write', 10_000);
    // The promise is that nothing more is told of it in this time.
    await settle(page, LONGER_THAN_THE_QUIET_MS);
    const told = await toldSince();
    expect(told.length === 1, `told ${told.length} times: ${JSON.stringify(told)}`);
    const note = await page.evaluate(() => window.__harness.host.fileName);
    expect(
      told[0].includes(HEADING) && told[0].includes(note),
      `told "${told[0]}", which does not name the heading ${HEADING} and the note ${note}`,
    );
    await typeAtEndInSource(page, '\nTyped in Source.');
    await settle(page, LONGER_THAN_THE_QUIET_MS);
    const after = await toldSince();
    expect(after.length === 1, `typing in Source was told: ${JSON.stringify(after.slice(1))}`);
  });

  await noPolicyViolation(reports);

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
