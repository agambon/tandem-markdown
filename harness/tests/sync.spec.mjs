// Checks of the two-sided harness page in the installed Chrome: the real panel against the
// real DocumentCoordinator running in the page.
//
//   node harness/tests/sync.spec.mjs
//
// Builds the harness, serves it on a free port, drives harness/index.html headless, and
// exits 0 when every check passes, 1 otherwise. Checks go through the DOM and the page's
// window.__harness. No screenshots. A storm that fails leaves its record (seed, trace, the last
// file, document and panel texts, notices and log) in dist/specs/sync-storms/, named in the failure.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { frames, pageOpener, typeAtEndInSource, waitFor } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('sync');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** The page's timers run on Playwright's clock, which a check can stop. */
const onStoppableClock = (page) => page.clock.install();

/** As `waitFor`, for a page whose clock is stopped: it asks from here, since the page's own timers wait. */
async function waitWhileStopped(page, fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await page.evaluate(fn))) {
    if (Date.now() > end) throw new Error(what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Puts the caret at the end of the panel line holding `text`, with a real click. */
async function clickLineEnd(page, text) {
  await page.locator('#tm-root .cm-line', { hasText: text }).first().click();
  await page.keyboard.press('End');
}

/** Moves the mouse out of the panel, onto the document box beside it. */
async function leavePanel(page) {
  const box = await page.locator('#hx-document').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * An input method in the page, as the DevTools Protocol drives one: `compose` shows its text so
 * far, in a composition that stays open, and `commit` puts the final text in its place and ends it.
 */
async function inputMethod(page) {
  const cdp = await page.context().newCDPSession(page);
  return {
    compose: (text) =>
      cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }),
    commit: (text) => cdp.send('Input.insertText', { text }),
  };
}

/** Whether an input method's composition is open in the panel. */
const composing = (page) => page.evaluate(() => window.__harness.view.composing);

const LINE = 'A second line of the same paragraph';

try {
  await check('real key presses in the panel reach the document', async () => {
    const page = await pages.harness();
    await clickLineEnd(page, LINE);
    await page.keyboard.type(' typed by keys ');
    await waitFor(
      page,
      () => window.__harness.documentText().includes('break. typed by keys '),
      null,
      'the typing did not reach the document',
    );
    await waitFor(page, () => window.__harness.agree(), null, 'the panel and the document do not agree after typing');
    expect(await page.evaluate(() => window.__harness.host.dirty), 'the document is not dirty after typing');
  });

  await check('typing reaches the document at once when the pointer leaves the panel', async () => {
    const page = await pages.harness('', { before: onStoppableClock });
    await clickLineEnd(page, LINE);
    // The page's timers stop here, so the typing cannot go after the pause: only on the pointer leaving.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await page.keyboard.type('zqleave');
    const typed = await page.evaluate(() => ({
      panel: (window.__harness.panelText() ?? '').includes('zqleave'),
      document: window.__harness.documentText().includes('zqleave'),
    }));
    expect(typed.panel, 'the typing is not in the panel');
    expect(!typed.document, 'the typing reached the document before the pointer left the panel');
    await leavePanel(page);
    await waitWhileStopped(
      page,
      () => window.__harness.documentText().includes('zqleave'),
      'the typing did not reach the document when the pointer left the panel',
    );
    await page.clock.resume();
    await waitFor(page, () => window.__harness.agree(), null, 'the panel and the document do not agree');
  });

  await check(
    "an input method's open composition reaches the document when the pointer leaves, and goes on",
    async () => {
      const page = await pages.harness('', { before: onStoppableClock });
      await clickLineEnd(page, LINE);
      // The page's timers stop here, so nothing can go after the typing pause: only on the pointer leaving.
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
      const ime = await inputMethod(page);
      await page.keyboard.type('zqtyped');
      await ime.compose('zqcomp');
      expect(await composing(page), 'the composition did not start');
      await leavePanel(page);
      await waitWhileStopped(
        page,
        () => window.__harness.documentText().includes('zqtypedzqcomp'),
        'the typing and the open composition did not reach the document when the pointer left the panel',
      );
      expect(await composing(page), 'sending the composition ended it');
      // The host answers on the page's clock: the composition stays open, and more of it goes the same way.
      await page.clock.resume();
      await ime.compose('zqcomposi');
      await waitFor(
        page,
        () => window.__harness.documentText().includes('zqtypedzqcomposi'),
        null,
        'more of the open composition did not reach the document',
      );
      expect(await composing(page), "the host's answers ended the composition");
      await ime.commit('zqcomposed');
      await waitFor(
        page,
        () => !window.__harness.view.composing && window.__harness.agree(),
        null,
        'the panel and the document do not agree once the composition is committed',
      );
      const text = await page.evaluate(() => window.__harness.documentText());
      expect(
        text.split('zqtypedzqcomposed').length === 2 && !text.replace('zqtypedzqcomposed', '').includes('zq'),
        `the document holds ${JSON.stringify(text.match(/\S*zq\S*/g))}`,
      );
    },
  );

  await check('an outside write during a composition leaves it open, and both are kept', async () => {
    const page = await pages.harness();
    await clickLineEnd(page, LINE);
    const ime = await inputMethod(page);
    await ime.compose('zqheld');
    await waitFor(
      page,
      () => window.__harness.documentText().includes('zqheld'),
      null,
      'the open composition did not reach the document after the typing pause',
    );
    const disk = await page.evaluate(() => window.__harness.diskText());
    await page.evaluate(
      (text) => window.__harness.host.writeOutside(text),
      disk.replace('## Headings', '## Headings\n\nOutside line.'),
    );
    await waitFor(
      page,
      () => window.__harness.documentText().includes('\n\nOutside line.\n'),
      null,
      'the outside write was not merged into the document',
    );
    // Everything the host sent, the merged update among it, has reached the panel, and the view has drawn since.
    await page.evaluate(() => window.__harness.host.whenQuiet(5000));
    await frames(page);
    expect(await composing(page), 'the outside write ended the composition');
    await ime.commit('zqheldmore');
    await waitFor(
      page,
      () => {
        const panel = window.__harness.panelText() ?? '';
        return (
          !window.__harness.view.composing &&
          panel.includes('\n\nOutside line.\n') &&
          panel.includes('zqheldmore') &&
          window.__harness.agree()
        );
      },
      null,
      'once the composition is committed, the panel and the document do not both hold it and the outside write',
    );
  });

  await check('typing in the document reaches the panel', async () => {
    const page = await pages.harness();
    await typeAtEndInSource(page, '\nTyped in Source.');
    expect(await page.evaluate(() => window.__harness.agree()), 'the panel and the document do not agree');
  });

  await check('an outside write while the document is clean appears in the panel', async () => {
    const page = await pages.harness();
    const disk = await page.evaluate(() => window.__harness.diskText());
    await page
      .locator('#hx-disk')
      .fill(
        disk.replace('# Everything Tandem Markdown draws', '# Everything Tandem Markdown draws\n\nWritten outside.'),
      );
    await page.locator('#hx-write').click();
    await waitFor(
      page,
      () => (window.__harness.panelText() ?? '').includes('\n\nWritten outside.\n'),
      null,
      'the outside write did not reach the panel',
    );
    const state = await page.evaluate(() => ({
      dirty: window.__harness.host.dirty,
      agree: window.__harness.agree(),
      notices: window.__harness.host.notices.length,
    }));
    expect(!state.dirty, 'the document turned dirty: it should have been reloaded from the file');
    expect(state.agree, 'the panel and the document do not agree');
    expect(state.notices === 0, `${state.notices} notices were raised for a plain outside write`);
  });

  await check(
    'an outside write while the panel has unsaved typing is merged, and after Save the disk holds both',
    async () => {
      const page = await pages.harness();
      await clickLineEnd(page, LINE);
      await page.keyboard.type(' saved-word ');
      await waitFor(
        page,
        () => window.__harness.documentText().includes(' saved-word '),
        null,
        'the typing did not reach the document',
      );
      // More typing, not yet sent (no word end, and the panel keeps focus), when another program
      // writes the file. The write goes through the page's API: clicking the disk box would
      // move focus out of the panel, and leaving the panel sends its typing.
      await page.keyboard.type('unsent');
      const disk = await page.evaluate(() => window.__harness.diskText());
      expect(!disk.includes('saved-word'), 'the typing is already on disk before any save');
      await page.evaluate(
        (text) => window.__harness.host.writeOutside(text),
        disk.replace('## Headings', '## Headings\n\nOutside line.'),
      );
      await waitFor(
        page,
        () => window.__harness.documentText().includes('\n\nOutside line.\n'),
        null,
        'the outside write was not merged into the document',
      );
      await waitFor(
        page,
        () => (window.__harness.panelText() ?? '').includes('\n\nOutside line.\n'),
        null,
        'the merged outside write did not reach the panel',
      );
      await page.locator('#hx-save').click();
      await waitFor(
        page,
        () => {
          const d = window.__harness.diskText() ?? '';
          return d.includes(' saved-word unsent') && d.includes('\n\nOutside line.\n') && !window.__harness.host.dirty;
        },
        null,
        'after Save the file does not hold both the typing and the outside write',
      );
      const end = await page.evaluate(() => ({
        same: window.__harness.diskText() === window.__harness.documentText(),
        agree: window.__harness.agree(),
        notices: window.__harness.notices().host,
      }));
      expect(end.same, 'the file and the document differ after Save');
      expect(end.agree, 'the panel and the document do not agree');
      expect(end.notices.length === 0, `notices were raised for changes on different lines: ${end.notices.join('; ')}`);
    },
  );

  for (const seed of [1, 2]) {
    await check(`storm(300, ${seed}) ends in agreement with nothing lost`, async () => {
      const page = await pages.harness();
      const r = await page.evaluate((s) => window.__harness.storm(300, s, { trace: true }), seed);
      // A storm runs on real timers, so its seed alone does not replay it: a failed one leaves its
      // trace and its last texts behind, to be read step by step. Nothing is written when it passes.
      let record = '';
      if (!r.ok || !r.agree) {
        const texts = await page.evaluate(() => ({
          file: window.__harness.diskText(),
          document: window.__harness.documentText(),
          panel: window.__harness.panelText(),
          notices: window.__harness.notices().host,
          logs: window.__harness.host.logs.map((l) => `${l.level}: ${l.message}`),
        }));
        const dir = path.join(import.meta.dirname, '..', '..', 'dist', 'specs', 'sync-storms');
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `storm-${seed}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        writeFileSync(
          file,
          JSON.stringify({ seed, steps: r.steps, failures: r.failures, ...texts, trace: r.trace }, null, 1),
        );
        record = `; its record is ${path.relative(path.join(import.meta.dirname, '..', '..'), file)}`;
      }
      expect(r.ok, `${r.failures.length} failures: ${r.failures.slice(0, 6).join('; ')}${record}`);
      expect(r.agree, `the panel, the document and the log do not agree${record}`);
      const w = r.outsideWrites;
      expect(
        w.writes > 5 && w.markers === w.inFile + w.backedUp + w.removedOnPurpose,
        `outside writes do not add up: ${JSON.stringify(w)}`,
      );
      console.log(
        `      storm ${seed}: ${r.ms} ms, ${w.writes} outside writes (${w.inFile} markers in the file, ${w.backedUp} backed up, ${w.removedOnPurpose} undone or deleted), ` +
          `${r.typed.panel} typed in the panel, ${r.typed.source} in Source, ${r.saves} saves, ${r.undos} undos, ${r.conflicts} conflicts`,
      );
    });
  }

  await check('"Corrupt panel" leads to a resync that loses no typing, says nothing and is logged', async () => {
    const page = await pages.harness();
    await page.locator('#hx-bar button', { hasText: 'Corrupt panel' }).click();
    expect(!(await page.evaluate(() => window.__harness.agree())), 'the panel still agrees after it was corrupted');
    // The next update from the document shows the panel that its text is wrong.
    await page.locator('#hx-document').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nAfter the fault.');
    await waitFor(
      page,
      () => window.__harness.host.inits.some((i) => i.reason === 'resync'),
      null,
      'the panel was not reloaded',
    );
    await waitFor(page, () => window.__harness.agree(), null, 'the panel did not come back level with the document');
    const after = await page.evaluate(() => ({
      resyncs: window.__harness.host.inits.filter((i) => i.reason === 'resync').length,
      poisoned: /⟦P\d+⟧/.test(window.__harness.documentText() + (window.__harness.diskText() ?? '')),
      sourceKept: (window.__harness.panelText() ?? '').endsWith('\nAfter the fault.'),
      notices: window.__harness.notices().panel,
      logged: window.__harness.host.logs.some((l) => l.from === 'panel' && l.message.startsWith('This tab reloaded')),
    }));
    expect(after.resyncs === 1, `${after.resyncs} resyncs, not 1`);
    expect(!after.poisoned, "the corrupted panel's text reached the document or the file");
    expect(after.sourceKept, 'the typing in Source is not in the panel after the resync');
    expect(after.notices.length === 0, `a reload that lost no typing said: ${JSON.stringify(after.notices)}`);
    expect(after.logged, 'the reload is not in the log');
  });

  await check(
    'an unanswered push stops the view taking edits and says so, while other messages keep coming',
    async () => {
      const page = await pages.harness();
      await clickLineEnd(page, LINE);
      await page.evaluate(() => window.__harness.host.holdPanelEdits());
      // One word with no end: it goes as one push when typing stops.
      await page.keyboard.type('zqheld');
      // Messages that do not answer the push keep arriving, one a second.
      await page.evaluate(() => {
        window.__talk = setInterval(() => window.__harness.host.setSettings({}), 1000);
      });
      const lost = () =>
        window.__harness.notices().panel.some((t) => t.startsWith("This tab can't take typing right now"));
      await waitFor(page, lost, null, 'no lost-contact warning 14 s after a push with no answer', 14000);
      const text = await page.evaluate(() => window.__harness.panelText());
      await page.keyboard.type('more');
      expect(
        (await page.evaluate(() => window.__harness.panelText())) === text,
        'typing still changed the view after the warning',
      );
      // The host answers at last: the warning goes, the push lands, and the view takes edits again.
      await page.evaluate(() => {
        clearInterval(window.__talk);
        window.__harness.host.releaseHeld();
      });
      await waitFor(
        page,
        () => !window.__harness.notices().panel.some((t) => t.startsWith("This tab can't take typing right now")),
        null,
        'the warning stayed after the host answered',
      );
      await waitFor(page, () => window.__harness.documentText().includes('zqheld'), null, 'the held push did not land');
      await waitFor(page, () => window.__harness.agree(), null, 'the panel did not come back level with the document');
      // The push landed, so nothing was lost and the reload changed nothing on screen: no notice says otherwise.
      const said = await page.evaluate(() => window.__harness.notices().panel);
      expect(!said.some((t) => t.startsWith('This tab reloaded')), `the panel said: ${JSON.stringify(said)}`);
      await clickLineEnd(page, LINE);
      await page.keyboard.type('again ');
      await waitFor(
        page,
        () => window.__harness.documentText().includes('again '),
        null,
        'typing did not reach the document after the host answered',
      );
    },
  );

  for (const fault of ['protocol', 'fields']) {
    await check(
      `a malformed init (${fault === 'protocol' ? 'another protocol' : 'no text'}) shows the failure page`,
      async () => {
        const page = await pages.harness(`?init=${fault}`);
        await waitFor(page, () => window.__harness.failed, null, 'the panel did not fail');
        const shown = await page.evaluate(() => {
          const root = document.getElementById('tm-root');
          return {
            text: root.innerText.trim(),
            buttons: [...root.querySelectorAll('button')].map((b) => b.textContent),
            editor: !!root.querySelector('.cm-editor, .tm-toolbar, .tm-notices'),
          };
        });
        expect(shown.text.startsWith('Tandem Markdown could not start in this tab.'), `the page reads "${shown.text}"`);
        expect(
          shown.buttons.length === 1 && shown.buttons[0] === 'Show Source',
          `the buttons are ${JSON.stringify(shown.buttons)}`,
        );
        expect(!shown.editor, 'something besides the failure message is drawn');
        await waitFor(
          page,
          () => window.__harness.host.startFailures.length === 1,
          null,
          'the host was not told the panel could not start',
        );
        await page.locator('#tm-root button', { hasText: 'Show Source' }).click();
        await waitFor(
          page,
          () => window.__harness.host.showSourceRequests === 1,
          null,
          'Show Source did not reach the host',
        );
      },
    );
  }

  // The panel's own record of them too, in the first page.
  await noPolicyViolation(reports, () =>
    reports.pages[0].evaluate(
      async () => (await window.__harness.host.runInPanel([{ type: 'state' }])).result.cspViolations,
    ),
  );

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
