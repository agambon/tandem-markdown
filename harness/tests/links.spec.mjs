// Smoke checks of links, wikilinks and images on the two-sided harness page, in the installed
// Chrome. The fake host answers (harness/fakes/links.ts) follow the host's own
// matching rules; opening is recorded in window.__linkFakes.opened.
//
//   node harness/tests/links.spec.mjs
//
// Builds the harness, serves it on a free port, drives harness/index.html headless with the
// links.md sample, and exits 0 when every check passes, 1 otherwise. No screenshots.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { pageOpener, scrollTo, waitFor, waitOutSuggestionDelay } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('links');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** The harness page with the links sample, in `mode`, once the fake host has answered for what is drawn. */
async function openHarness(mode) {
  const page = await pages.harness(`?sample=links.md&mode=${mode}`);
  // The answers for what is drawn come back from the fake host.
  await waitFor(
    page,
    () => document.querySelector('#tm-root .tm-wikilink-missing') !== null,
    null,
    'no wikilink answer arrived',
  );
  return page;
}

const opened = (page) => page.evaluate(() => window.__linkFakes.opened.map((o) => ({ ...o })));

try {
  const view = await openHarness('view');

  await check('Rich view: a plain click on a link asks the host to open it', async () => {
    await view.locator('#tm-root .tm-link', { hasText: 'the CommonMark spec' }).click();
    await waitFor(view, () => window.__linkFakes.opened.length >= 1, null, 'nothing was posted');
    const [first] = await opened(view);
    expect(
      first.kind === 'web' && first.href === 'https://spec.commonmark.org/' && first.mode === 'view',
      `posted ${JSON.stringify(first)}`,
    );
  });

  await check('Rich view: a click on a reference link and a wikilink opens what they point to', async () => {
    const before = (await opened(view)).length;
    await view.locator('#tm-root .tm-link', { hasText: /^the guide$/ }).click();
    await view.locator('#tm-root .tm-wikilink', { hasText: 'Other note > Section' }).click();
    await waitFor(view, (n) => window.__linkFakes.opened.length >= n + 2, before, 'the two clicks did not both post');
    const got = (await opened(view)).slice(before);
    expect(
      got[0].kind === 'file' && got[0].href === 'Other note.md',
      `the reference link posted ${JSON.stringify(got[0])}`,
    );
    expect(
      got[1].kind === 'wikilink' && got[1].href === 'Other note#Section',
      `the wikilink posted ${JSON.stringify(got[1])}`,
    );
  });

  await check('Rich view: marks, addresses and definitions are not shown', async () => {
    const text = await view.locator('#tm-root .cm-content').innerText();
    for (const raw of ['](https://spec', '[[Other note]]', '<https://example.com/path>', '[guide]: ', '![A picture]']) {
      expect(!text.includes(raw), `"${raw}" is visible in Rich view`);
    }
    expect(text.includes('[nothing][undefined]'), 'a reference to an undefined label is not shown as typed');
  });

  await check('a missing wikilink is drawn as missing, an ambiguous one lists its candidates on hover', async () => {
    const missing = await view.locator('#tm-root .tm-wikilink-missing').allInnerTexts();
    expect(missing.length === 1 && missing[0] === 'Nowhere', `missing wikilinks drawn: ${JSON.stringify(missing)}`);
    await view.locator('#tm-root .tm-wikilink-ambiguous').first().hover();
    await waitFor(view, () => document.querySelector('.tm-link-card') !== null, null, 'no card appeared on hover');
    const card = await view.locator('.tm-link-card').innerText();
    expect(
      card.includes('notes/Folder/Topic.md') && card.includes('archive/Topic.md') && card.includes('Open'),
      `the card says ${JSON.stringify(card)}`,
    );
    await view.mouse.move(5, 5);
  });

  await check('a #heading link scrolls the panel to that heading', async () => {
    await view.evaluate(() => (window.__harness.view.scrollDOM.scrollTop = 0));
    await view.locator('#tm-root .tm-link', { hasText: 'a heading in this file' }).click();
    await waitFor(view, () => window.__harness.view.scrollDOM.scrollTop > 100, null, 'the panel did not scroll');
    const top = await view.evaluate(() => {
      const v = window.__harness.view;
      const block = v.lineBlockAtHeight(v.scrollDOM.scrollTop + 20);
      return v.state.doc.lineAt(block.from).text;
    });
    expect(top.startsWith('## Images') || top === '', `the line at the top is ${JSON.stringify(top)}`);
  });

  await check('images: found ones load, never wider than the column; the rest show their path and why', async () => {
    await scrollTo(view, '![Missing]');
    await waitFor(
      view,
      () => document.querySelectorAll('#tm-root .tm-image-failed').length >= 3,
      null,
      'the failed images did not draw',
    );
    const failed = await view.locator('#tm-root .tm-image-failed').allTextContents();
    const missing = failed.find((t) => t.includes('img/missing.png'));
    expect(missing && missing.includes('Not found'), `failed boxes: ${JSON.stringify(failed)}`);
    expect(
      failed.some((t) => t.includes('Outside the workspace')),
      'no box says "Outside the workspace"',
    );
    expect(
      failed.some((t) => t.includes('http is not loaded')),
      'no box says "http is not loaded"',
    );
    await scrollTo(view, '![A picture]');
    await waitFor(
      view,
      () => document.querySelectorAll('#tm-root .tm-image-loaded img').length >= 3,
      null,
      'the found images did not load',
    );
    const widths = await view.evaluate(() => {
      const column = document.querySelector('#tm-root .cm-content').getBoundingClientRect().width;
      return {
        column,
        widest: Math.max(
          ...[...document.querySelectorAll('#tm-root .tm-image img')].map((i) => i.getBoundingClientRect().width),
        ),
      };
    });
    expect(widths.widest <= widths.column, `an image is ${widths.widest}px in a ${widths.column}px column`);
  });

  const edit = await openHarness('edit');

  await check('Rich editor: a plain click places the cursor and shows the source; Ctrl+click opens', async () => {
    await edit.locator('#tm-root .tm-link', { hasText: 'file beside this one' }).click();
    // The source shows once the button comes up; what the click asked of the host has arrived by then.
    await waitFor(
      edit,
      () =>
        [...document.querySelectorAll('#tm-root .cm-line')].some((l) =>
          l.textContent.includes('[file beside this one](Other%20note.md)'),
        ),
      null,
      'the plain click did not show the source',
    );
    await edit.evaluate(() => window.__harness.host.whenQuiet(5000));
    expect((await opened(edit)).length === 0, `a plain click posted ${JSON.stringify(await opened(edit))}`);
    await edit.locator('#tm-root .tm-link', { hasText: 'from the root' }).click({ modifiers: ['Control'] });
    await waitFor(edit, () => window.__linkFakes.opened.length >= 1, null, 'Ctrl+click posted nothing');
    const [first] = await opened(edit);
    expect(
      first.kind === 'file' && first.href === '/README.md' && first.mode === 'edit',
      `posted ${JSON.stringify(first)}`,
    );
  });

  await check('[[ completion inserts a target and the closing brackets', async () => {
    await scrollTo(edit, 'Type a wikilink here:');
    await edit.locator('#tm-root .cm-line', { hasText: 'Type a wikilink here:' }).click();
    await edit.keyboard.press('End');
    await edit.keyboard.type(' [[Oth');
    await waitFor(
      edit,
      () => document.querySelector('.cm-tooltip-autocomplete li') !== null,
      null,
      'no completion list appeared',
    );
    const options = await edit.locator('.cm-tooltip-autocomplete li').allInnerTexts();
    expect(options.length >= 1 && options[0].startsWith('Other note'), `options: ${JSON.stringify(options)}`);
    await waitOutSuggestionDelay(edit);
    await edit.keyboard.press('Enter');
    try {
      await waitFor(
        edit,
        () => window.__harness.documentText().includes('Type a wikilink here: [[Other note]]'),
        null,
        'the target did not reach the document',
      );
    } catch (error) {
      const line = await edit.evaluate(() =>
        window.__harness
          .documentText()
          .split('\n')
          .filter((l) => l.includes('wikilink here')),
      );
      throw new Error(`${error.message}: the document has ${JSON.stringify(line)}`);
    }
  });

  await check('Rich editor: Alt+Enter opens the link at the cursor', async () => {
    const before = (await opened(edit)).length;
    await edit.evaluate(() => {
      const v = window.__harness.view;
      const at = v.state.doc.toString().indexOf('from the root') + 3;
      v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      v.focus();
    });
    await edit.keyboard.press('Alt+Enter');
    await waitFor(edit, (n) => window.__linkFakes.opened.length > n, before, 'Alt+Enter posted nothing');
    const got = (await opened(edit)).slice(before);
    expect(got.length === 1 && got[0].href === '/README.md' && got[0].mode === 'edit', `posted ${JSON.stringify(got)}`);
    expect(
      (await edit.evaluate(() => window.__harness.documentText())).includes('[from the root](/README.md)'),
      'Alt+Enter changed the text',
    );
  });

  // ---------------------------------------------------------------------------
  // Rich view from the keyboard

  const keys = await openHarness('view');
  const focused = (page) =>
    page.evaluate(() => {
      const a = document.activeElement;
      const content = window.__harness.view.contentDOM;
      const inside = !!a && a !== content && content.contains(a);
      return {
        inside,
        onPage: a === content,
        kind: !inside
          ? null
          : a.matches('input.tm-task')
            ? 'task'
            : a.matches('.tm-link, .tm-wikilink')
              ? 'link'
              : a.className,
        text: inside ? a.textContent : null,
        ring: inside ? getComputedStyle(a).outlineStyle : null,
      };
    });
  const fromThePage = (page) =>
    page.evaluate(async () => {
      const v = window.__harness.view;
      v.scrollDOM.scrollTop = 0;
      for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
      v.contentDOM.focus();
    });

  // The link with focus shows a focus ring.
  await check('Rich view: Tab and Shift+Tab move between links; Enter and Alt+Enter open the focused one', async () => {
    await fromThePage(keys);
    await keys.keyboard.press('Tab');
    let f = await focused(keys);
    expect(f.kind === 'link' && f.text === 'the CommonMark spec', `the first Tab focused ${JSON.stringify(f)}`);
    expect(f.ring && f.ring !== 'none', `the focused link has no focus ring (outline ${f.ring})`);
    await keys.keyboard.press('Tab');
    f = await focused(keys);
    expect(f.text === 'file beside this one', `the second Tab focused ${JSON.stringify(f)}`);
    await keys.keyboard.press('Shift+Tab');
    f = await focused(keys);
    expect(f.text === 'the CommonMark spec', `Shift+Tab focused ${JSON.stringify(f)}`);
    const before = (await opened(keys)).length;
    await keys.keyboard.press('Enter');
    await waitFor(keys, (n) => window.__linkFakes.opened.length > n, before, 'Enter posted nothing');
    await keys.keyboard.press('Tab');
    await keys.keyboard.press('Alt+Enter');
    await waitFor(keys, (n) => window.__linkFakes.opened.length > n + 1, before, 'Alt+Enter posted nothing');
    const got = (await opened(keys)).slice(before);
    expect(
      got[0].href === 'https://spec.commonmark.org/' && got[0].mode === 'view',
      `Enter posted ${JSON.stringify(got[0])}`,
    );
    expect(got[1].href === 'Other%20note.md' && got[1].mode === 'view', `Alt+Enter posted ${JSON.stringify(got[1])}`);
    expect(got.length === 2, `posted ${JSON.stringify(got)}`);
  });

  await check(
    'Rich view: Tab reaches every link in order, none that is only text, then leaves the editor',
    async () => {
      await fromThePage(keys);
      const seen = [];
      for (let i = 0; i < 60; i++) {
        await keys.keyboard.press('Tab');
        const f = await focused(keys);
        if (!f.inside) break;
        seen.push(f.text);
      }
      const want = [
        'the CommonMark spec',
        'file beside this one',
        'from the root',
        'a heading in this file',
        'the guide',
        'Guide',
        'guide',
        'https://example.com/path',
        'someone@example.com',
        'www.example.org',
        'https://example.net/page',
      ];
      expect(JSON.stringify(seen.slice(0, want.length)) === JSON.stringify(want), `Tab went ${JSON.stringify(seen)}`);
      expect(
        !seen.some((t) => /nothing|sic/.test(t)),
        `Tab stopped on text that is not a link: ${JSON.stringify(seen)}`,
      );
      expect(
        seen.includes('Nowhere') && seen.includes('a topic with an alias'),
        `Tab missed the wikilinks: ${JSON.stringify(seen)}`,
      );
      expect(seen.at(-1) === 'inside a table', `Tab missed the link in a table's cell: ${JSON.stringify(seen)}`);
      expect(!(await focused(keys)).inside, 'focus is still on a link after the last one');
    },
  );

  await check('Rich view: Tab reaches checkboxes, and Space checks one and keeps the focus on it', async () => {
    await keys.evaluate(() =>
      window.__harness.open('- [ ] one\n- [x] two\n\nA [link](https://a.example) here.\n', 'tasks.md'),
    );
    await keys.waitForSelector('#tm-root input.tm-task');
    await fromThePage(keys);
    await keys.keyboard.press('Tab');
    let f = await focused(keys);
    expect(f.kind === 'task', `the first Tab focused ${JSON.stringify(f)}`);
    await keys.keyboard.press('Space');
    await waitFor(
      keys,
      () => window.__harness.documentText().startsWith('- [x] one') && window.__harness.agree(),
      null,
      'Space did not check the first task in the document',
    );
    f = await focused(keys);
    expect(f.kind === 'task', `after Space the focus is on ${JSON.stringify(f)}`);
    expect(await keys.evaluate(() => document.activeElement.checked === true), 'the focused checkbox is not checked');
    await keys.keyboard.press('Tab');
    await keys.keyboard.press('Tab');
    f = await focused(keys);
    expect(f.kind === 'link' && f.text === 'link', `two more Tabs focused ${JSON.stringify(f)}`);
    await keys.keyboard.press('Shift+Tab');
    f = await focused(keys);
    expect(f.kind === 'task', `Shift+Tab focused ${JSON.stringify(f)}`);
    // A click shows what the document then says, too.
    await keys.locator('#tm-root input.tm-task').nth(1).click();
    await waitFor(
      keys,
      () => window.__harness.documentText().includes('- [ ] two') && window.__harness.agree(),
      null,
      'a click did not uncheck the second task in the document',
    );
    expect(
      await keys.evaluate(() => document.querySelectorAll('#tm-root input.tm-task')[1].checked === false),
      'the clicked checkbox still shows checked',
    );
  });

  await noPolicyViolation(reports);

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
