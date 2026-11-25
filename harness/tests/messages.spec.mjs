// The message strip in the installed Chrome, on the two-sided harness page: a message the host
// sends shows its words, its buttons in order and, while others wait, how many, as words; a screen
// reader names it by its words, once; a press tells the host which button of which message, and
// the message stays until the host sends another; the keyboard reaches the buttons and goes on to
// the next message or back to the editor; what the host sends that is not a message is left alone.
//
//   node harness/tests/messages.spec.mjs
//
// Builds the harness, serves it, drives harness/index.html headless, and exits 0 when every check
// passes, 1 otherwise. The fake host posts what src/host/messages.ts would. No screenshots, no
// timing assertions: the waits are guards against a hang.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { pageOpener, settle, waitFor } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('messages');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

const MERGED = {
  id: 'n.1',
  text: 'Your view now has all of the change from disk.',
  buttons: [
    { does: 'undo', label: 'Undo' },
    { does: 'compare', label: 'See Diff' },
    { does: 'dismiss', label: 'Dismiss' },
  ],
  popped: false,
  more: null,
};
const OFFER = {
  id: 'n.2',
  text: 'You closed Plans.md before your last typing on 2 lines reached it.',
  buttons: [
    { does: 'putTypingBack', label: 'Put My Typing Back' },
    { does: 'compare', label: 'See Diff' },
    { does: 'dismiss', label: 'Dismiss' },
  ],
  popped: true,
  more: null,
};

/** The harness page in the Rich editor, once its panel has started. */
async function openHarness() {
  const page = await pages.harness('?mode=edit');
  await waitFor(page, () => window.__harness.view !== null, null, 'the panel did not start');
  return page;
}

/** Posts what the host would send: the message the strip shows (null: none), and with `focus`, the keyboard to it. */
const send = (page, shown, focus = false) =>
  page.evaluate(
    ({ shown, focus }) => window.__harness.host.post({ type: 'messages', shown, ...(focus ? { focus: true } : {}) }),
    { shown, focus },
  );

/** The strip's message as a reader meets it: the group named by its words, in the panel. */
const strip = (page, text) => page.locator('#tm-root').getByRole('group', { name: text });

/** The buttons of the strip's message, by their names, in order. */
const buttonNames = (page, text) =>
  strip(page, text)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((b) => b.textContent));

/** The presses the panel told the host of, in order. */
const presses = (page) =>
  page.evaluate(() =>
    window.__harness.host.received
      .filter((m) => m.type === 'messagePressed')
      .map((m) => ({ message: m.message, button: m.button })),
  );

/** The name of the element that has the keyboard in the panel's page. */
const keyboardOn = (page) =>
  page.evaluate(() => {
    const at = document.activeElement;
    if (!at) return null;
    if (at.closest('.cm-content')) return 'editor';
    return at.tagName === 'BUTTON' ? at.textContent : at.tagName;
  });

try {
  await check('a message is shown, its words naming it and its buttons in order', async () => {
    const page = await openHarness();
    await send(page, MERGED);
    await strip(page, MERGED.text).waitFor();
    expect(
      JSON.stringify(await buttonNames(page, MERGED.text)) === JSON.stringify(['Undo', 'See Diff', 'Dismiss']),
      `the buttons are ${JSON.stringify(await buttonNames(page, MERGED.text))}`,
    );
    expect((await strip(page, MERGED.text).isVisible()) === true, 'the message is not visible');
  });

  await check(
    'a press tells the host which button of which message, and the message stays until the host says',
    async () => {
      const page = await openHarness();
      await send(page, MERGED);
      await strip(page, MERGED.text).getByRole('button', { name: 'See Diff' }).click();
      await waitFor(
        page,
        () => window.__harness.host.received.some((m) => m.type === 'messagePressed'),
        null,
        'the host was not told of the press',
      );
      const told = await presses(page);
      expect(
        JSON.stringify(told) === JSON.stringify([{ message: 'n.1', button: 'compare' }]),
        `the host was told ${JSON.stringify(told)}`,
      );
      expect(await strip(page, MERGED.text).isVisible(), 'the message went before the host said');
      // The host takes a button away: the message stays, with the button gone.
      await send(page, { ...MERGED, buttons: MERGED.buttons.slice(1) });
      await strip(page, MERGED.text).getByRole('button', { name: 'Undo' }).waitFor({ state: 'detached' });
      expect(
        JSON.stringify(await buttonNames(page, MERGED.text)) === JSON.stringify(['See Diff', 'Dismiss']),
        `the buttons are ${JSON.stringify(await buttonNames(page, MERGED.text))}`,
      );
      await send(page, null);
      await strip(page, MERGED.text).waitFor({ state: 'detached' });
    },
  );

  await check(
    'the keyboard reaches the buttons, goes on to the next message, and back to the editor at the end',
    async () => {
      const page = await openHarness();
      await send(page, MERGED, true);
      await waitFor(page, () => document.activeElement?.textContent === 'Undo', null, 'the keyboard is not on Undo');
      await page.keyboard.press('Tab');
      expect((await keyboardOn(page)) === 'See Diff', `Tab took the keyboard to ${await keyboardOn(page)}`);
      await page.keyboard.press('Tab');
      expect((await keyboardOn(page)) === 'Dismiss', `Tab took the keyboard to ${await keyboardOn(page)}`);
      await page.keyboard.press('Enter');
      await waitFor(
        page,
        () => window.__harness.host.received.some((m) => m.type === 'messagePressed' && m.button === 'dismiss'),
        null,
        'Enter on Dismiss did not press it',
      );
      await send(page, OFFER);
      await waitFor(
        page,
        () => document.activeElement?.textContent === 'Put My Typing Back',
        null,
        async () => `the keyboard went to ${await keyboardOn(page)}, not the next message`,
      );
      await send(page, null);
      await waitFor(
        page,
        () => !!document.activeElement?.closest('.cm-content'),
        null,
        async () => `the keyboard went to ${await keyboardOn(page)}, not the editor`,
      );
    },
  );

  await check('says how many messages wait behind this one, as words after its buttons, not as a button', async () => {
    const page = await openHarness();
    const more = '2 more messages after this one';
    await send(page, { ...MERGED, more });
    await strip(page, MERGED.text).getByText(more).waitFor();
    expect(
      JSON.stringify(await buttonNames(page, MERGED.text)) === JSON.stringify(['Undo', 'See Diff', 'Dismiss']),
      `the buttons are ${JSON.stringify(await buttonNames(page, MERGED.text))}`,
    );
    await send(page, MERGED);
    await strip(page, MERGED.text).getByText(more).waitFor({ state: 'detached' });
  });

  await check('a message that popped up is not said again to a screen reader, one that did not is', async () => {
    const page = await openHarness();
    const live = (text) => strip(page, text).evaluate((group) => group.parentElement?.getAttribute('aria-live'));
    await send(page, MERGED);
    await strip(page, MERGED.text).waitFor();
    expect(
      (await live(MERGED.text)) === 'polite',
      `a message that did not pop up is in a live region "${await live(MERGED.text)}"`,
    );
    await send(page, OFFER);
    await strip(page, OFFER.text).waitFor();
    expect(
      (await live(OFFER.text)) === 'off',
      `a message that popped up is in a live region "${await live(OFFER.text)}"`,
    );
  });

  await check('what the host sends that is not a message changes nothing', async () => {
    const page = await openHarness();
    await send(page, MERGED);
    await strip(page, MERGED.text).waitFor();
    await send(page, { id: 7, text: 'Not a message' });
    await send(page, 'not a message');
    await settle(page);
    expect(await strip(page, MERGED.text).isVisible(), 'the message went');
    expect(
      (await page.locator('#tm-root').getByText('Not a message').count()) === 0,
      'what is not a message was drawn',
    );
  });

  await noPolicyViolation(reports);

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
