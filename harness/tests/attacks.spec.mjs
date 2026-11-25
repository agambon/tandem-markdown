// The attack corpus (harness/attacks/corpus.json) through the panel, in the installed Chrome, under
// the panel's content policy. Every HTML snippet goes through the HTML door into the page, with
// players kept and without, and every snippet stands as HTML in a document drawn in both views,
// alone with players on, and on one line as a box's title and an abbreviation's meaning; every
// markdown snippet stands in a document with every optional syntax on; every math snippet is drawn
// by KaTeX, in a line and as a block, in dollars and in LaTeX's delimiters; every diagram snippet
// is drawn by Mermaid in its frame. The bar: no script runs or opens a dialog, nothing is requested
// from outside, the policy reports no violation in the page or in a frame, no player is set to play
// by itself, and nothing that can run or load is left in the page or in a diagram's picture.
// Exits 0 when every check passes, 1 otherwise.
//
//   node harness/tests/attacks.spec.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  check,
  dialogCanary,
  expect,
  noPageError,
  noPolicyViolation,
  noRequestOutside,
  noScriptRan,
  PageReports,
  report,
  requestsOutside,
} from '../checks.mjs';
import { drawingsDone, pageOpener, settle } from '../pages.mjs';
import { inspectPictures } from '../pictures.mjs';
import { serveOwnBuild } from '../serve.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const corpus = JSON.parse(readFileSync(path.join(repo, 'harness', 'attacks', 'corpus.json'), 'utf8'));

const server = await serveOwnBuild('attacks');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
let dialogs = [];
let outside = [];
/** The render lab, with every snippet's dialog, request and policy report recorded. */
let page;

/** In the page and in every frame: a canary for dialogs, and the requests that leave it. */
async function watchSnippets(lab) {
  dialogs = await dialogCanary(lab);
  outside = requestsOutside(lab, server);
}

/**
 * What may not be in the page: elements that run or load, handlers, script addresses. (A style
 * attribute from markup is reported by the policy; the panel's own are set as style objects.)
 */
function dangers(rootSelector) {
  return page.evaluate((selector) => {
    const found = [];
    for (const root of document.querySelectorAll(selector)) {
      for (const el of root.querySelectorAll('*')) {
        const name = el.localName;
        if (
          /^(script|iframe|frame|object|embed|form|input|button|link|meta|base|style|svg|math|template)$/.test(name) &&
          !el.closest(
            '.katex, .tm-drawn-edit, .tm-drawn-controls, .tm-callout-head, .tm-code-header, .tm-drawn-held, .tm-details-head, .tm-table-bar, .tm-conflict-actions, .tm-task-box, .tm-heading-fold, .tm-heading-folded-pill',
          )
        )
          found.push(`<${name}>`);
        if ((name === 'video' || name === 'audio') && (el.autoplay || el.hasAttribute('autoplay')))
          found.push(`<${name} autoplay>`);
        for (const attr of el.attributes) {
          const value = attr.value.trim().toLowerCase();
          if (attr.name.startsWith('on')) found.push(`${name}[${attr.name}]`);
          if (
            /^(href|src|srcset|cite|longdesc|action|formaction|data|poster|background|xlink:href)$/.test(attr.name) &&
            /^(javascript|vbscript|data:text|data:application)/.test(value.replace(/[\s\u0000-\u001f]/g, ''))
          )
            found.push(`${name}[${attr.name}=${value.slice(0, 30)}]`);
        }
      }
    }
    return found;
  }, rootSelector);
}

/** Loads `text` in `mode` and scrolls through it, so every line is drawn once. */
async function drawAll(text, mode) {
  await page.evaluate(
    async ({ text, mode }) => {
      window.__lab.setMode(mode);
      window.__lab.load(text);
      const scroller = document.querySelector('.cm-scroller');
      scroller.scrollTop = 0;
      for (let guard = 0; guard < 2000; guard++) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
        scroller.scrollTop += scroller.clientHeight * 0.8;
      }
    },
    { text, mode },
  );
  await settle(page, 300);
}

try {
  await check('the request watch keeps a request that left when the policy refuses one that did not', async () => {
    const probe = await browser.newPage();
    try {
      const left = requestsOutside(probe, server);
      // A page whose policy takes pictures from outside only, so one from the server is refused.
      await probe.route(`${server.url}watch.html`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https:">',
        }),
      );
      await probe.route('https://outside.invalid/**', (route) => route.fulfill({ status: 204 }));
      await probe.goto(`${server.url}watch.html`);
      const picture = (src) => probe.evaluate((s) => document.body.append(Object.assign(new Image(), { src: s })), src);
      const answered = probe.waitForEvent('requestfinished', (r) => r.url().startsWith('https://outside.invalid/'));
      await picture('https://outside.invalid/dot.png');
      await answered;
      const refused = probe.waitForEvent('requestfailed', (r) => r.failure()?.errorText === 'csp');
      await picture(`${server.url}dot.png`);
      await refused;
      expect(
        left.length === 1 && left[0].url() === 'https://outside.invalid/dot.png',
        `the watch holds ${JSON.stringify(left.map((r) => r.url()))}`,
      );
    } finally {
      await probe.close();
    }
  });

  page = await pageOpener(browser, server, reports).lab('?mode=view', { before: watchSnippets });

  await check(`the door lets nothing that runs or loads through (${corpus.html.length} snippets)`, async () => {
    const left = await page.evaluate(async (snippets) => {
      const door = await window.__lab.door();
      const host = document.createElement('div');
      host.className = 'attack-host';
      document.body.appendChild(host);
      const left = [];
      const URL_ATTRIBUTES = /^(href|src|srcset|cite|longdesc|action|formaction|data|poster|background|xlink:href)$/;
      for (const [i, { payload }] of snippets.entries()) {
        for (const [address, players] of [
          [() => null, false],
          [(_kind, value) => value, false],
          [(_kind, value) => value, true],
        ]) {
          host.replaceChildren(door.sanitizeHtml(payload, { allowRemote: players, media: players, address }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          for (const el of host.querySelectorAll('*')) {
            if (
              /^(script|iframe|frame|object|embed|form|input|button|style|svg|math|base|link|meta|template)$/.test(
                el.localName,
              )
            )
              left.push(`${i}: <${el.localName}>`);
            if (el.hasAttribute('autoplay')) left.push(`${i}: [autoplay]`);
            for (const attr of el.attributes) {
              const value = attr.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
              if (attr.name.startsWith('on') || attr.name === 'style' || attr.name === 'id')
                left.push(`${i}: [${attr.name}]`);
              if (
                URL_ATTRIBUTES.test(attr.name) &&
                /^(javascript|vbscript|data:(?!image\/(png|jpeg|gif|webp);))/.test(value)
              )
                left.push(`${i}: [${attr.name}=${value.slice(0, 30)}]`);
            }
          }
        }
      }
      host.remove();
      return left;
    }, corpus.html);
    expect(left.length === 0, left.slice(0, 5).join('\n'));
    const violations = await page.evaluate(() => window.__violations);
    expect(
      violations.length === 0,
      `policy violations while the door cleaned the corpus: ${violations.slice(0, 3).join('; ')}`,
    );
  });

  // CodeMirror reads a carriage return as a line break, so the document is written with line feeds.
  const asDocument = corpus.html.map((entry) => entry.payload.replace(/\r\n?/g, '\n')).join('\n\n');
  for (const mode of ['view', 'edit']) {
    await check(
      `HTML snippets in a document draw nothing that runs or loads (${mode === 'view' ? 'Rich view' : 'Rich editor'})`,
      async () => {
        await drawAll(asDocument, mode);
        const found = await dangers('.cm-content');
        expect(found.length === 0, found.slice(0, 10).join(', '));
        expect((await page.evaluate(() => window.__lab.text())) === asDocument, 'drawing changed the document');
      },
    );
  }

  /** Every optional syntax that reads addresses, on, players included. */
  const everything = { media: true, otherPictureSizes: true, pictureSizes: true, themePictures: true };

  await check('HTML snippets in a document with players on draw nothing that runs or loads', async () => {
    await page.evaluate((syntax) => window.__lab.setSettings({ syntax }), everything);
    try {
      await drawAll(asDocument, 'view');
      const found = await dangers('.cm-content');
      expect(found.length === 0, found.slice(0, 10).join(', '));
    } finally {
      await page.evaluate(() => window.__lab.setSettings({ syntax: {} }));
    }
  });

  /** Draws each snippet alone in Rich view with every optional syntax on, and what is left that runs or loads. */
  const eachAlone = async (snippets) => {
    await page.evaluate((syntax) => window.__lab.setSettings({ syntax }), everything);
    const found = [];
    try {
      for (const [i, payload] of snippets.entries()) {
        await page.evaluate(
          (text) => {
            window.__lab.setMode('view');
            window.__lab.load(text);
          },
          payload.replace(/\r\n?/g, '\n'),
        );
        await settle(page, 60);
        for (const danger of await dangers('.cm-content')) found.push(`${i}: ${danger}`);
      }
    } finally {
      await page.evaluate(() => window.__lab.setSettings({ syntax: {} }));
    }
    return found;
  };

  await check(`each HTML snippet drawn alone, players on, leaves nothing that runs or loads`, async () => {
    const found = await eachAlone(corpus.html.map((entry) => entry.payload));
    expect(found.length === 0, found.slice(0, 10).join(', '));
  });

  const markdownDocument = corpus.markdown.map((entry) => entry.payload).join('\n\n');
  for (const mode of ['view', 'edit']) {
    await check(
      `markdown snippets with every syntax on draw nothing that runs or loads (${mode === 'view' ? 'Rich view' : 'Rich editor'}, ${corpus.markdown.length} snippets)`,
      async () => {
        await page.evaluate((syntax) => window.__lab.setSettings({ syntax }), everything);
        try {
          await drawAll(markdownDocument, mode);
          const found = await dangers('.cm-content');
          expect(found.length === 0, found.slice(0, 10).join(', '));
          expect((await page.evaluate(() => window.__lab.text())) === markdownDocument, 'drawing changed the document');
        } finally {
          await page.evaluate(() => window.__lab.setSettings({ syntax: {} }));
        }
      },
    );
  }

  await check('each markdown snippet drawn alone leaves nothing that runs or loads', async () => {
    const found = await eachAlone(corpus.markdown.map((entry) => entry.payload));
    expect(found.length === 0, found.slice(0, 10).join(', '));
  });

  const formulas = corpus.math.map((entry) => entry.payload);
  /** Draws `text` in Rich view: its math leaves nothing that runs or loads, and no link or picture. */
  const mathDrawsSafely = async (text) => {
    await drawAll(text, 'view');
    const found = await dangers('.cm-content');
    expect(found.length === 0, found.join(', '));
    const links = await page.evaluate(
      () => document.querySelectorAll('.cm-content .katex a, .cm-content .katex img').length,
    );
    expect(links === 0, `${links} links or pictures in the drawn math`);
  };

  const mathDocument = formulas.map((tex) => `Inline $${tex}$ here.\n\n$$\n${tex}\n$$`).join('\n\n');
  await check(`math snippets draw as math or as a message (${formulas.length} snippets)`, () =>
    mathDrawsSafely(mathDocument),
  );

  const latexDocument = formulas.map((tex) => `Inline \\(${tex}\\) here.\n\n\\[\n${tex}\n\\]`).join('\n\n');
  await check(`math snippets in LaTeX's delimiters draw as math or as a message (${formulas.length} snippets)`, () =>
    mathDrawsSafely(latexDocument),
  );

  // The places a box's title and an abbreviation's meaning (an attribute) are drawn from.
  const oneLine = corpus.html.map((entry) => entry.payload).filter((payload) => !/[\r\n]/.test(payload));
  const placed = oneLine
    .map((payload, i) => `::: note ${payload}\nBody.\n:::\n\nWord${i} here.\n\n*[Word${i}]: ${payload}`)
    .join('\n\n');
  for (const mode of ['view', 'edit']) {
    await check(
      `HTML snippets as box titles and abbreviation meanings draw nothing that runs or loads (${mode === 'view' ? 'Rich view' : 'Rich editor'})`,
      async () => {
        await drawAll(placed, mode);
        const found = await dangers('.cm-content');
        expect(found.length === 0, found.slice(0, 10).join(', '));
        expect((await page.evaluate(() => window.__lab.text())) === placed, 'drawing changed the document');
      },
    );
  }

  await check('with Object.prototype already polluted, KaTeX still draws no link', async () => {
    await page.evaluate(() => {
      Object.prototype.trust = true;
    });
    try {
      await drawAll('$$\n\\href{javascript:alert(1)}{x}\\url{https://example.invalid/}\n$$\n', 'view');
      const links = await page.evaluate(() => document.querySelectorAll('.cm-content .katex a').length);
      expect(links === 0, `${links} links drawn`);
    } finally {
      await page.evaluate(() => {
        delete Object.prototype.trust;
      });
    }
  });

  await check(
    `diagram snippets draw as a picture or a message, and nothing in them runs or loads (${corpus.diagrams.length} snippets)`,
    async () => {
      const pictures = [];
      for (const [i, { payload }] of corpus.diagrams.entries()) {
        await drawAll(`\`\`\`mermaid\n${payload}\n\`\`\`\n`, 'view');
        await drawingsDone(page);
        const shown = await page.evaluate(() => {
          const frame = document.querySelector('.cm-content .tm-drawn-diagram');
          return {
            src: frame?.querySelector('img.tm-diagram')?.src ?? null,
            failed: !!frame?.classList.contains('tm-drawn-failed'),
          };
        });
        expect(shown.src || shown.failed, `${i}: neither a picture nor a message`);
        if (shown.src) pictures.push(shown.src);
        const found = await dangers('.cm-content');
        expect(found.length === 0, `${i}: ${found.join(', ')}`);
      }
      const found = await inspectPictures(browser, pictures);
      expect(found.length === 0, found.slice(0, 5).join('; '));
    },
  );

  await noScriptRan(page, dialogs);
  await noRequestOutside(outside);
  await noPolicyViolation(reports);
  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
