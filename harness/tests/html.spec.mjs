// HTML blocks, links and pictures written as HTML, and other programs' pictures and players, in
// the render lab, in the installed Chrome, through the DOM: what the cases of
// test/panel/syntax/cases/html.json cannot show. A <details> folds and unfolds on a click and
// hides what lies inside it; the cursor steps onto hidden tag lines; links in drawings open as
// links do; sizes and players are applied; and nothing is fetched from outside.
//
//   node harness/tests/html.spec.mjs
//
// Exits 0 when every check passes, 1 otherwise. No screenshots.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { drawingsDone, frames, pageOpener, placeCursor, settle, waitUntil } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('html');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const outside = [];
const reports = new PageReports();

/** A PNG of one pixel, stored as a `data:` address. */
const DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The render lab. */
let page;

/** Every request the lab makes to anywhere but the server, even one the policy refuses. */
function watchRequests(lab) {
  lab.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(server.url) && !url.startsWith('data:')) outside.push(url);
  });
}

async function load(text, { mode = 'view', syntax = {}, trusted = true, theme = 'dark' } = {}) {
  await page.evaluate(
    ({ text, mode, syntax, trusted, theme }) => {
      window.__lab.setSettings({ syntax, workspaceTrusted: trusted });
      window.__lab.setTheme(theme);
      window.__lab.setMode(mode);
      window.__lab.load(text);
    },
    { text, mode, syntax, trusted, theme },
  );
  await drawingsDone(page);
}

/** Each line's text as drawn, hidden ones left out. */
function visibleLines() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.cm-content > *')]
      .filter((e) => e.getBoundingClientRect().height > 0)
      .map((e) => e.textContent),
  );
}

const text = () => page.evaluate(() => window.__lab.text());
const head = () => page.evaluate(() => window.__lab.view.state.selection.main.head);
const posted = (type) => page.evaluate((t) => window.__lab.posted.filter((m) => m.type === t), type);

try {
  page = await pageOpener(browser, server, reports).lab('?mode=view', { before: watchRequests });

  // ---------------------------------------------------------------------------
  // <details>

  const details = 'Above.\n\n<details>\n<summary>More</summary>\n\nInside **here**.\n\n</details>\n\nBelow.';

  for (const mode of ['view', 'edit']) {
    await check(`a click on a summary unfolds and folds it, the file unchanged (${mode})`, async () => {
      await load(details, { mode });
      if (mode === 'edit') await placeCursor(page, 0);
      const expanded = () =>
        page.evaluate(() => document.querySelector('.tm-details-toggle')?.getAttribute('aria-expanded'));
      expect(!(await visibleLines()).includes('Inside here.'), 'the folded inside shows');
      expect((await expanded()) === 'false', `aria-expanded is ${await expanded()}`);
      await page.locator('.tm-details-summary').click();
      await waitUntil(page, async () => (await visibleLines()).includes('Inside here.'), 'the inside did not unfold');
      expect((await expanded()) === 'true', `aria-expanded is ${await expanded()} once unfolded`);
      await page.locator('.tm-details-toggle').click();
      await waitUntil(
        page,
        async () => !(await visibleLines()).includes('Inside here.'),
        'the inside did not fold again',
      );
      expect((await text()) === details, 'the file changed');
      if (mode === 'edit') expect((await head()) === 0, `the cursor moved to ${await head()}`);
    });
  }

  await check('a <summary> after a blank line inside <details> becomes its summary and folds its body', async () => {
    const spaced =
      'Above.\n\n<details>\n\n<summary>Spaced summary</summary>\n\nInside **here**.\n\n</details>\n\nBelow.';
    await load(spaced, { mode: 'view' });
    const summaryText = await page.locator('.tm-details-summary').textContent();
    expect(summaryText === 'Spaced summary', `summary was ${JSON.stringify(summaryText)}`);
    expect(!(await visibleLines()).includes('Inside here.'), 'body should start folded');
    await page.locator('.tm-details-summary').click();
    await waitUntil(page, async () => (await visibleLines()).includes('Inside here.'), 'spaced details did not unfold');
    await page.locator('.tm-details-toggle').click();
    await waitUntil(
      page,
      async () => !(await visibleLines()).includes('Inside here.'),
      'spaced details did not re-fold',
    );
    expect((await text()) === spaced, 'the file changed');
  });

  await check('a folded <details> hides the table, math and pictures inside it', async () => {
    await load(
      '<details>\n<summary>S</summary>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n![p](pic.png)\n\n</details>\n\nBelow.',
    );
    const shown = await page.evaluate(() => window.__lab.countKinds(['table', 'math block', 'picture']));
    expect(shown.table === 0 && shown['math block'] === 0 && shown.picture === 0, JSON.stringify(shown));
  });

  await check('a selection landing inside a folded <details> unfolds it', async () => {
    await load(details, { mode: 'edit' });
    await placeCursor(page, details.indexOf('Inside'));
    expect(
      (await visibleLines()).some((l) => l.includes('Inside')),
      'the inside stays folded',
    );
    await placeCursor(page, 0);
    expect(!(await visibleLines()).some((l) => l.includes('Inside')), 'it did not fold again when the cursor left');
  });

  await check('the summary opens to its source with its pencil, and Escape closes it', async () => {
    await load(details, { mode: 'edit' });
    await placeCursor(page, 0);
    await page.locator('.tm-drawn-summary .tm-drawn-edit').click();
    let lines = [];
    await waitUntil(
      page,
      async () => {
        lines = await visibleLines();
        return lines.includes('<details>') && lines.includes('<summary>More</summary>');
      },
      () => JSON.stringify(lines),
    );
    await page.keyboard.press('Escape');
    await waitUntil(
      page,
      async () => {
        lines = await visibleLines();
        return !lines.includes('<details>');
      },
      () => `still open: ${JSON.stringify(lines)}`,
    );
  });

  // ---------------------------------------------------------------------------
  // Hidden tag lines

  const centered = 'Above.\n\n<div align="center">\n\nMiddle.\n\n</div>\n\nBelow.';

  await check('Down steps onto a hidden opening tag line, which then shows, and on past it', async () => {
    await load(centered, { mode: 'edit' });
    await placeCursor(page, 0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await waitUntil(
      page,
      async () => (await visibleLines()).includes('<div align="center">'),
      'the tag line does not show',
    );
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    let lines = [];
    await waitUntil(
      page,
      async () => {
        lines = await visibleLines();
        return !lines.includes('<div align="center">') && lines.some((l) => l === 'Middle.');
      },
      () => `after moving on: ${JSON.stringify(lines)}`,
    );
  });

  await check('Up steps onto a hidden closing tag line, which then shows', async () => {
    await load(centered, { mode: 'edit' });
    await placeCursor(page, centered.indexOf('Below'));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await waitUntil(page, async () => (await visibleLines()).includes('</div>'), 'the closing tag line does not show');
  });

  await check('walking through wrappers and HTML blocks with Down and Up moves the cursor a line a key', async () => {
    const doc = `Top.\n\n${details}\n\n${centered}\n\n<table><tr><td>Cell</td></tr></table>\n\nEnd.`;
    await load(doc, { mode: 'edit' });
    await placeCursor(page, 0);
    /** The cursor's line and how far its top moved on screen, from before the key to after it. */
    const step = async (key) => {
      const before = await page.evaluate(() => {
        const view = window.__lab.view;
        const head = view.state.selection.main.head;
        return { top: view.coordsAtPos(head)?.top ?? NaN, height: view.lineBlockAt(head).height };
      });
      await page.keyboard.press(key);
      await frames(page, 2);
      return page.evaluate((b) => {
        const view = window.__lab.view;
        const head = view.state.selection.main.head;
        const top = view.coordsAtPos(head)?.top ?? NaN;
        const line = Math.max(b.height, view.lineBlockAt(head).height);
        return { head, moved: Math.abs(top - b.top), line };
      }, before);
    };
    for (const key of ['ArrowDown', 'ArrowUp']) {
      for (let i = 0; i < 24; i++) {
        const { head, moved, line } = await step(key);
        expect(moved <= line + 1, `${key} to ${head} moved the cursor ${Math.round(moved)} px, more than a line`);
      }
    }
    expect((await text()) === doc, 'the document changed');
  });

  await check('in a workspace VS Code does not trust, wrappers and blocks show as code', async () => {
    await load(`${centered}\n\n<p align="center"><b>Bold</b></p>`, { trusted: false });
    const lines = await visibleLines();
    expect(lines.includes('<div align="center">') && lines.includes('</div>'), `shows ${JSON.stringify(lines)}`);
    const drawn = await page.evaluate(() =>
      window.__lab.countKinds(['drawn HTML', 'centered text', 'HTML shown as code']),
    );
    expect(
      drawn['drawn HTML'] === 0 && drawn['centered text'] === 0 && drawn['HTML shown as code'] === 3,
      JSON.stringify(drawn),
    );
  });

  // ---------------------------------------------------------------------------
  // Links

  const linkBlock = '<p align="center">\n  <a href="https://example.com/a">Site</a>\n</p>';
  const opened = async () => (await posted('openLink')).map((m) => m.href);

  await check('a link in an HTML drawing opens with a click in Rich view, the page not following it', async () => {
    await load(linkBlock);
    const before = (await opened()).length;
    await page.locator('.tm-html-drawing a').click();
    await waitUntil(page, async () => (await opened()).length > before, 'nothing was opened');
    const after = (await opened()).slice(before);
    expect(JSON.stringify(after) === '["https://example.com/a"]', `opened ${JSON.stringify(after)}`);
    expect(page.url().includes('lab.html'), `the page went to ${page.url()}`);
  });

  await check('in Rich editor a link in a drawing opens with Ctrl+click only, and the focus stays', async () => {
    await load(linkBlock, { mode: 'edit' });
    await placeCursor(page, linkBlock.length);
    const before = (await opened()).length;
    await page.locator('.tm-html-drawing a').click();
    await settle(page);
    expect((await opened()).length === before, 'a plain click opened the link');
    const focused = await page.evaluate(() => document.activeElement === window.__lab.view.contentDOM);
    expect(focused, 'a plain click took the focus');
    await page.locator('.tm-html-drawing a').click({ modifiers: ['Control'] });
    await waitUntil(page, async () => (await opened()).length === before + 1, 'Ctrl+click did not open the link');
  });

  await check('a link written as HTML in a line opens like a link: a click, Tab, and Alt+Enter', async () => {
    const line = 'Read <a href="docs/guide.md">the guide</a> first.';
    await load(line);
    const before = (await opened()).length;
    await page.locator('.cm-content .tm-link').click();
    await page.evaluate(() => window.__lab.view.contentDOM.focus());
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    expect(focused === 'the guide', `Tab reached ${JSON.stringify(focused)}`);
    await load(line, { mode: 'edit' });
    await page.evaluate((at) => {
      window.__lab.view.dispatch({ selection: { anchor: at } });
      window.__lab.runCommand('openLink');
    }, line.indexOf('guide<'));
    const after = (await opened()).slice(before);
    expect(JSON.stringify(after) === '["docs/guide.md","docs/guide.md"]', `opened ${JSON.stringify(after)}`);
  });

  // ---------------------------------------------------------------------------
  // Pictures

  /** Each drawn picture's displayed state: shown or not, its classes, and its img's size. */
  const pictures = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.cm-content .tm-image')].map((box) => {
        const img = box.querySelector('img');
        return {
          shown: getComputedStyle(box).display !== 'none',
          classes: box.className,
          width: img ? Math.round(img.getBoundingClientRect().width) : null,
          boxWidth: Math.round(box.getBoundingClientRect().width),
        };
      }),
    );

  await check('sizes after the alt text, in braces and after the address are applied', async () => {
    await load(
      `![a|40](${DOT})\n\n![b|30x20](${DOT})\n\n![c](${DOT}){width=50%}\n\n![d](${DOT}){width="60px" height=10px}\n\n![e](${DOT} =25x)\n\n![f](${DOT}){:height 12, :width 35}\n\n![[pic.png|300|center]]`,
      { syntax: { otherPictureSizes: true } },
    );
    await page.waitForFunction(() => document.querySelectorAll('.tm-image-loaded').length >= 6);
    const sizes = await pictures();
    const column = await page.evaluate(() => document.querySelector('.cm-line').getBoundingClientRect().width);
    const [a, b, c, d, e, f] = sizes;
    expect(a.width === 40 && b.width === 30, `after the alt text: ${a.width}, ${b.width}`);
    expect(Math.abs(c.boxWidth - column / 2) <= 2, `50% of ${column} is ${c.boxWidth}`);
    expect(
      d.width === 60 && e.width === 25 && f.width === 35,
      `braces and address: ${d.width}, ${e.width}, ${f.width}`,
    );
  });

  await check('with picture sizes off, the alt text and the braces are left as they are', async () => {
    await load(`![a|40](${DOT}) ![c](${DOT}){width=50%}`, { syntax: { pictureSizes: false } });
    await page.waitForFunction(() => document.querySelectorAll('.tm-image-loaded').length >= 2);
    const state = await page.evaluate(() => ({
      alt: document.querySelector('.tm-image img')?.alt,
      line: document.querySelector('.cm-line').textContent,
    }));
    expect(state.alt === 'a|40' && state.line.endsWith('{width=50%}'), JSON.stringify(state));
  });

  await check('a picture stored in the file is drawn from the file itself', async () => {
    await load(`![dot](${DOT})`);
    await page.waitForFunction(() => document.querySelector('.tm-image-loaded img'));
    const src = await page.evaluate(() => document.querySelector('.tm-image img').getAttribute('src'));
    expect(src === DOT, `src is ${src?.slice(0, 40)}`);
  });

  // ---------------------------------------------------------------------------
  // Players

  await check('players never play by themselves, and wait for VS Code to say what they may load', async () => {
    const players = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.cm-content video, .cm-content audio')].map((p) => ({
          autoplay: p.autoplay || p.hasAttribute('autoplay'),
          controls: p.controls,
          src: p.getAttribute('src'),
          paused: p.paused,
        })),
      );
    // The lab answers at once; held, the players are seen before VS Code has answered.
    await page.evaluate(() => window.__lab.holdPictures());
    try {
      await load(
        '<video src="clip.mp4" controls autoplay></video>\n\n<audio src="https://example.com/a.mp3" autoplay></audio>\n\n![demo](demo.mp4)',
        { syntax: { media: true } },
      );
      const waiting = await players();
      expect(waiting.length === 2, `${waiting.length} players before VS Code answers`);
      expect(
        waiting.every((p) => !p.autoplay && p.controls && p.src === null),
        `before VS Code answers: ${JSON.stringify(waiting)}`,
      );
    } finally {
      await page.evaluate(() => window.__lab.releasePictures());
    }
    // The two files in the workspace load; the remote address is not one the lab can reach.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.cm-content video, .cm-content audio')].filter((p) => p.readyState >= 1)
          .length === 2,
      null,
      { timeout: 10_000 },
    );
    const answered = await players();
    expect(answered.length === 3, `${answered.length} players once VS Code answers`);
    expect(
      answered.every((p) => !p.autoplay && p.controls && p.paused),
      `once VS Code answers: ${JSON.stringify(answered)}`,
    );
    expect(answered.filter((p) => p.src === null).length === 1, `addresses: ${JSON.stringify(answered)}`);
  });

  await check('nothing was requested from outside', async () => {
    expect(outside.length === 0, outside.slice(0, 5).join(', '));
  });

  await noPolicyViolation(reports);

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
