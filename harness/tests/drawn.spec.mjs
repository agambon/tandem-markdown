// The drawn blocks of other programs, in the installed Chrome, through the DOM. In the render
// lab: every kind of Mermaid diagram in the sample drawn as a picture, the frame Mermaid runs in
// held to its boundary, what the user sees when a diagram is wrong or its frame stops answering,
// a diagram opened large; contents lists kept current and followed by click and by key. On the
// harness page, whose fake host reads made-up notes and keeps the undo: embedded notes, and git's
// conflicts with their buttons.
//
//   node harness/tests/drawn.spec.mjs
//
// Both pages have the panel's own content policy. Inside VS Code the page is a webview with
// another origin; itest/suite/diagrams.test.ts checks the frame there. Each check's result is
// printed as it finishes. Exits 0 when every check passes, 1 otherwise. No screenshots.

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
import {
  documentBecomes,
  drawingsDone,
  frames,
  pageOpener,
  placeCursor,
  settle,
  waitFor,
  waitUntil,
} from '../pages.mjs';
import { inspectPictures } from '../pictures.mjs';
import { serveOwnBuild } from '../serve.mjs';

/** As DRAW_TIMEOUT_MS in src/panel/render/diagramFrame.ts. */
const DRAW_TIMEOUT_MS = 20_000;

const server = await serveOwnBuild('drawn');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
let dialogs = [];
let outside = [];
/** The render lab, with its frames' policy reports, dialogs and requests that leave it recorded. */
let page;

/** In the page and in every frame: a canary for dialogs, and the requests that leave it. */
async function watchDrawings(lab) {
  dialogs = await dialogCanary(lab);
  outside = requestsOutside(lab, server);
}

/**
 * Loads `text` in `mode` and scrolls through it, waiting at each step for what is in view to
 * be drawn. Resolves with every diagram drawn, in document order: its picture's address and
 * whether it loaded, its name, its message, and whether it has the button that opens it large.
 */
async function drawAll(text, mode = 'view') {
  const drawn = await page.evaluate(
    async ({ text, mode }) => {
      window.__lab.setMode(mode);
      window.__lab.load(text);
      const view = window.__lab.view;
      const scroller = document.querySelector('.cm-scroller');
      const seen = new Map();
      const idle = () =>
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 30_000;
          const wait = () => {
            if (!document.querySelector('.cm-content [aria-busy="true"]')) resolve();
            else if (Date.now() > deadline) reject(new Error('a drawing stayed busy for 30 seconds'));
            else setTimeout(wait, 20);
          };
          wait();
        });
      scroller.scrollTop = 0;
      for (let guard = 0; guard < 2000; guard++) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await idle();
        for (const frame of document.querySelectorAll('.cm-content .tm-drawn-diagram')) {
          const img = frame.querySelector('img.tm-diagram');
          const loaded = img
            ? await img.decode().then(
                () => img.naturalWidth > 0,
                () => false,
              )
            : false;
          seen.set(view.posAtDOM(frame), {
            src: img?.src ?? null,
            loaded,
            alt: img?.alt ?? null,
            failed: frame.classList.contains('tm-drawn-failed'),
            message: frame.querySelector('.tm-drawn-error')?.textContent ?? '',
            large: !!frame.querySelector('.tm-drawn-controls [aria-label="Open the diagram large"]'),
          });
        }
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
        scroller.scrollTop += scroller.clientHeight * 0.8;
      }
      return [...seen.entries()].sort((x, y) => x[0] - y[0]).map(([, d]) => d);
    },
    { text, mode },
  );
  await drawingsDone(page);
  return drawn;
}

/** The diagrams in view, as `drawAll` reads them. */
function diagrams() {
  return page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll('.cm-content .tm-drawn-diagram')].map(async (frame) => {
        const img = frame.querySelector('img.tm-diagram');
        const loaded = img
          ? await img.decode().then(
              () => img.naturalWidth > 0,
              () => false,
            )
          : false;
        return {
          src: img?.src ?? null,
          loaded,
          alt: img?.alt ?? null,
          failed: frame.classList.contains('tm-drawn-failed'),
          message: frame.querySelector('.tm-drawn-error')?.textContent ?? '',
        };
      }),
    ),
  );
}

/** The diagram frame of the page, as Playwright reaches it. */
async function diagramFrame() {
  const element = await page.$('iframe.tm-diagram-frame');
  return element ? element.contentFrame() : null;
}

let sample = '';

try {
  const pages = pageOpener(browser, server, reports);
  page = await pages.lab('?mode=view', { before: watchDrawings });
  sample = await page.evaluate(async () => (await fetch('samples/syntax-drawn.md')).text());
  const fences = (sample.match(/^```mermaid$/gm) ?? []).length;

  await check(`every diagram in the sample draws as a picture, the wrong one as a message (${fences})`, async () => {
    const drawn = await drawAll(sample);
    expect(drawn.length === fences, `${drawn.length} diagrams drawn, not ${fences}`);
    const pictures = drawn.filter((d) => d.loaded);
    const failed = drawn.filter((d) => d.failed);
    expect(
      pictures.length === fences - 1,
      `${pictures.length} pictures shown: ${JSON.stringify(drawn.map((d) => d.message))}`,
    );
    expect(
      failed.length === 1 && failed[0].message.length > 0,
      `the wrong diagram shows ${JSON.stringify(failed.map((d) => d.message))}`,
    );
    expect(
      pictures.every((d) => d.alt === 'Diagram'),
      'a picture has no name for a screen reader',
    );
    expect(
      pictures.every((d) => d.large) && !failed[0].large,
      'the button that opens a diagram large is missing from a picture, or shown beside a mistake',
    );
  });

  await check('a picture holds nothing that runs or loads', async () => {
    const sources = (await drawAll(sample)).map((d) => d.src).filter(Boolean);
    const found = await inspectPictures(browser, sources);
    expect(found.length === 0, found.slice(0, 5).join('; '));
  });

  await check('an open diagram with a mistake keeps its last good picture beneath a short message', async () => {
    const text = 'Above.\n\n```mermaid\ngraph LR;\n  P-->Q;\n```\n\nBelow.\n';
    await drawAll(text, 'edit');
    await placeCursor(page, text.indexOf('P-->Q;') + 'P-->Q;'.length);
    await drawingsDone(page);
    const before = (await diagrams())[0];
    expect(before?.loaded, 'the open diagram is not drawn');
    await page.keyboard.type(' -->', { delay: 20 });
    // The message comes once the typing pauses.
    await page.waitForFunction(
      () => !!document.querySelector('.cm-content .tm-drawn-diagram .tm-drawn-error')?.textContent,
    );
    await drawingsDone(page);
    const after = (await diagrams())[0];
    expect(after.src === before.src && after.loaded, 'the last good picture did not stay');
    expect(after.message.length > 0, 'no message');
    expect(
      (await page.evaluate(() => window.__lab.text())) === text.replace('P-->Q;', 'P-->Q; -->'),
      'typing went wrong',
    );
  });

  await check('a diagram opens with its pencil and closes with Escape, its picture beneath the source', async () => {
    const text = 'Above.\n\n```mermaid\ngraph LR;\n  R-->S;\n```\n\nBelow.\n';
    await drawAll(text, 'edit');
    await page.locator('.tm-drawn-diagram .tm-drawn-edit').click();
    let state = {};
    await waitUntil(
      page,
      async () => {
        state = await page.evaluate(() => ({
          open: !!document.querySelector('.tm-drawn-open.tm-drawn-diagram img.tm-diagram'),
          source: document.querySelector('.cm-content').innerText.includes('R-->S;'),
          label: document.querySelector('.tm-drawn-open .tm-drawn-edit')?.getAttribute('aria-label'),
        }));
        return state.open && state.source && state.label === 'Done editing the diagram';
      },
      () => JSON.stringify(state),
    );
    await page.keyboard.press('Escape');
    await waitUntil(
      page,
      async () => {
        state = await page.evaluate(() => ({
          open: !!document.querySelector('.tm-drawn-open'),
          closed: !!document.querySelector('.tm-drawn-diagram img.tm-diagram'),
        }));
        return !state.open && state.closed;
      },
      () => JSON.stringify(state),
    );
  });

  await check('a diagram opens large under its own name, zooms, moves and closes, and the note stays', async () => {
    const text = 'Above.\n\n```mermaid\nflowchart LR\n  accTitle: Work flow\n  A --> B --> C\n```\n\nBelow.\n';
    try {
      await drawAll(text, 'edit');
      const button = page.locator('.tm-drawn-diagram .tm-drawn-controls button');
      expect((await button.getAttribute('title')) === 'Open the diagram large', 'the button has another tooltip');
      await button.click();
      const dialog = page.locator('.tm-diagram-view[role="dialog"]');
      await dialog.waitFor();
      const read = () =>
        page.evaluate(() => {
          const view = document.querySelector('.tm-diagram-view');
          const img = view?.querySelector('img');
          return {
            open: !!view,
            name: view?.getAttribute('aria-label') ?? null,
            focus: !!view && view.contains(document.activeElement),
            width: img ? img.getBoundingClientRect().width : 0,
            left: img ? img.getBoundingClientRect().left : 0,
            titles: view ? [...view.querySelectorAll('button')].map((b) => b.title) : [],
            names: view ? [...view.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : [],
          };
        });
      const opened = await read();
      expect(opened.name === 'Work flow' && opened.focus, JSON.stringify(opened));
      expect(
        JSON.stringify(opened.titles) ===
          JSON.stringify(['Zoom out (-)', 'Zoom in (+)', 'Show the whole diagram (0)', 'Close (Escape)']) &&
          JSON.stringify(opened.names) === JSON.stringify(['Zoom out', 'Zoom in', 'Show the whole diagram', 'Close']),
        JSON.stringify(opened),
      );
      await page.keyboard.press('+');
      const zoomed = await read();
      expect(zoomed.width > opened.width, `+ left it ${zoomed.width} px wide, from ${opened.width}`);
      await page.keyboard.press('ArrowRight');
      const moved = await read();
      expect(moved.left < zoomed.left, 'the right arrow did not move it');
      await page.keyboard.press('0');
      const whole = await read();
      expect(Math.abs(whole.width - opened.width) < 1, `0 left it ${whole.width} px wide, not ${opened.width}`);
      await page.locator('.tm-diagram-view button[aria-label="Close"]').click();
      expect(!(await read()).open, 'Close left it open');
      await button.click();
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      const after = await page.evaluate(() => ({
        open: !!document.querySelector('.tm-diagram-view'),
        editor: document.activeElement?.classList.contains('cm-content') ?? false,
        text: window.__lab.text(),
      }));
      expect(!after.open && after.editor, JSON.stringify(after));
      expect(after.text === text, 'the note changed');
    } finally {
      // A view a failed step left open would cover the page for the checks after this one.
      await page.evaluate(() => document.querySelector('.tm-diagram-view')?.remove());
    }
  });

  await check('while the frame is stuck the editor keeps working, and the diagram it holds up says so', async () => {
    await drawAll('```mermaid\ngraph LR;\n  T-->U;\n```\n');
    const stuck = await diagramFrame();
    expect(!!stuck, 'no diagram frame');
    await page.evaluate(() => (document.querySelector('iframe.tm-diagram-frame').__stuck = true));
    // The frame's thread is kept busy for longer than a draw may take.
    await stuck.evaluate((ms) => {
      setTimeout(() => {
        const end = Date.now() + ms;
        while (Date.now() < end);
      }, 0);
    }, DRAW_TIMEOUT_MS + 4000);
    const text = 'Typed here: \n\n```mermaid\ngraph LR;\n  V-->W;\n```\n';
    await page.evaluate((t) => {
      window.__lab.setMode('edit');
      window.__lab.load(t);
    }, text);
    // Typed while the frame is stuck: from when the diagram it holds up is marked as being drawn
    // to when that mark is looked at again, after the typing.
    await page.waitForSelector('.cm-content .tm-drawn-diagram[aria-busy="true"]');
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.focus();
      view.dispatch({ selection: { anchor: 'Typed here: '.length } });
    });
    await page.keyboard.type('ok', { delay: 20 });
    expect(
      (await page.evaluate(() => window.__lab.text())).startsWith('Typed here: ok'),
      'typing did not reach the document',
    );
    const busy = await page.evaluate(() => !!document.querySelector('.cm-content .tm-drawn-diagram[aria-busy="true"]'));
    expect(busy, 'the held-up diagram was drawn before the typing landed');
    await page.waitForFunction(() => document.querySelector('.cm-content .tm-drawn-diagram.tm-drawn-failed'), null, {
      timeout: DRAW_TIMEOUT_MS + 5000,
    });
    const message = (await diagrams())[0].message;
    expect(message === 'Not drawn: drawing it took longer than 20 seconds.', `it says ${JSON.stringify(message)}`);
    const [after] = await drawAll('```mermaid\ngraph LR;\n  X-->Y;\n```\n');
    const next = await page.evaluate(() => ({
      frames: document.querySelectorAll('iframe.tm-diagram-frame').length,
      fresh: !document.querySelector('iframe.tm-diagram-frame').__stuck,
    }));
    expect(next.frames === 1 && next.fresh, `frames after the stop: ${JSON.stringify(next)}`);
    expect(after?.loaded, 'the next diagram was not drawn');
  });

  // ---------------------------------------------------------------------------
  // The contents list

  /** The text of each link of the contents list in the page. */
  const entries = () =>
    page.evaluate(async () => {
      document.querySelector('.cm-scroller').scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return [...document.querySelectorAll('.cm-content .tm-contents-link')].map((a) => a.textContent);
    });
  const filler = (n) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i} holds enough plain words to wrap across the column.`).join(
      '\n\n',
    );
  const contentsDoc = `# Notes\n\n[TOC]\n\n## First\n\n${filler(30)}\n\n## Second\n\n${filler(30)}\n\n### Third\n\nEnd.\n`;

  await check('the contents list follows the headings as they are typed, after a pause', async () => {
    await drawAll(contentsDoc, 'edit');
    expect(JSON.stringify(await entries()) === '["Notes","First","Second","Third"]', JSON.stringify(await entries()));
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    await page.keyboard.type('\n## Fourth', { delay: 10 });
    // Back to the top, asked of the editor as a command asks it: the last key asked the editor
    // to keep the cursor in view, and it does so on its next frame, over any scroll set from here.
    await page.evaluate(() => {
      window.__lab.view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      document.querySelector('.cm-scroller').scrollTop = 0;
    });
    // The list is drawn again once the typing pauses.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.cm-content .tm-contents-link')].some((a) => a.textContent === 'Fourth'),
    );
    await drawingsDone(page);
    expect(
      JSON.stringify(await entries()) === '["Notes","First","Second","Third","Fourth"]',
      JSON.stringify(await entries()),
    );
  });

  /** Where the line holding `text`'s first appearance as a heading is, against the top of the editor. */
  const headingTop = (text) =>
    page.evaluate((t) => {
      const view = window.__lab.view;
      const at = view.state.doc.toString().indexOf(t);
      const coords = view.coordsAtPos(at);
      return coords ? Math.round(coords.top - view.scrollDOM.getBoundingClientRect().top) : null;
    }, text);

  await check(
    'in Rich view a click on an entry scrolls its heading to the top; in Rich editor it takes Ctrl',
    async () => {
      await drawAll(contentsDoc, 'view');
      await page.evaluate(() => (document.querySelector('.cm-scroller').scrollTop = 0));
      await waitFor(
        page,
        () => document.querySelector('.cm-scroller').scrollTop === 0 && !!document.querySelector('.tm-contents-link'),
        null,
        'contents list did not return to top',
      );
      await frames(page, 2);
      await page.locator('.tm-contents-link', { hasText: 'Second' }).click();
      let top = null;
      await waitUntil(
        page,
        async () => {
          top = await headingTop('## Second');
          return top !== null && top >= 0 && top < 60;
        },
        () => `the heading is ${top} px from the top`,
      );
      await drawAll(contentsDoc, 'edit');
      await page.evaluate(() => {
        const view = window.__lab.view;
        view.focus();
        view.dispatch({ selection: { anchor: 0 } });
        document.querySelector('.cm-scroller').scrollTop = 0;
      });
      await waitFor(
        page,
        () =>
          window.__lab.view.state.selection.main.head === 0 &&
          document.querySelector('.cm-scroller').scrollTop === 0 &&
          !!document.querySelector('.tm-contents-link'),
        null,
        'editor did not reset to top',
      );
      await frames(page, 2);
      await page.locator('.tm-contents-link', { hasText: 'Third' }).click();
      await settle(page, 300);
      let head = await page.evaluate(() => window.__lab.view.state.selection.main.head);
      expect(head === 0, `a plain click moved the cursor to ${head}`);
      await page.locator('.tm-contents-link', { hasText: 'Third' }).click({ modifiers: ['Control'] });
      const third = contentsDoc.indexOf('### Third') + 4;
      await waitUntil(
        page,
        async () => {
          head = await page.evaluate(() => window.__lab.view.state.selection.main.head);
          return head === third;
        },
        () => `Ctrl+click put the cursor at ${head}, not at the heading's text (${third})`,
      );
    },
  );

  await check('in Rich view Tab moves through the entries and Enter follows one', async () => {
    await drawAll(contentsDoc, 'view');
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.dispatch({ effects: view.constructor.scrollIntoView(0, { y: 'start' }) });
    });
    await waitFor(page, () => !!document.querySelector('.tm-contents-link'), null, 'contents links did not appear');
    await frames(page, 2);
    await page.evaluate(() => window.__lab.view.contentDOM.focus({ preventScroll: true }));
    await waitFor(
      page,
      () => document.activeElement === window.__lab.view.contentDOM,
      null,
      'contentDOM did not take focus',
    );
    await frames(page, 1);
    const focused = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      focused.push(await page.evaluate(() => document.activeElement?.textContent));
    }
    expect(JSON.stringify(focused) === '["Notes","First","Second"]', `Tab went to ${JSON.stringify(focused)}`);
    await page.keyboard.press('Enter');
    let top = null;
    await waitUntil(
      page,
      async () => {
        top = await headingTop('## Second');
        return top !== null && top >= 0 && top < 60;
      },
      () => `after Enter the heading is ${top} px from the top`,
    );
  });

  // ---------------------------------------------------------------------------
  // Embedded notes, on the harness page, whose fake host reads made-up notes

  const harness = await pages.harness('?mode=view', { viewport: { width: 1280, height: 1400 } });

  /** Opens `text` as notes/links.md on the harness page and waits for its embeds to be read. */
  const openEmbeds = async (text, mode = 'view') => {
    await harness.evaluate(
      ({ t, m }) => {
        // The page's View control, which a document opened next takes its mode from.
        document.querySelectorAll('#hx-bar select')[1].value = m;
        return window.__harness.open(t, 'links.md');
      },
      { t: text, m: mode },
    );
    // An embed's answer can hold embeds of its own, which ask in turn: done when none is waiting
    // once the page has drawn twice more.
    for (;;) {
      await harness.waitForFunction(() => !document.querySelector('.cm-content .tm-embed-waiting'), null, {
        timeout: 10_000,
      });
      const waiting = await harness.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(!!document.querySelector('.cm-content .tm-embed-waiting'))),
            ),
          ),
      );
      if (!waiting) break;
    }
  };
  /** The text each top-level embed shows, lines joined by " | ". */
  const embedTexts = () =>
    harness.evaluate(() =>
      [...document.querySelectorAll('#tm-root .cm-content .tm-drawn-embed')]
        .filter((e) => !e.parentElement.closest('.tm-drawn-embed'))
        .map((e) => e.innerText.split('\n').filter(Boolean).join(' | ')),
    );

  await check('an embed shows the note, its section or its block, and says why when it cannot', async () => {
    await openEmbeds(
      '# Embeds\n\n![[Other note]]\n\n![[Other note#Part two]]\n\n![[Other note#^item-2]]\n\n![[Missing]]\n\n![[Other note#Nope]]\n',
    );
    const shown = await embedTexts();
    const want = [
      'Other note | Other note | The first paragraph of the other note, with a link. | Part two | A line to quote. | - one | - two | Part three | The end of the other note.',
      'Other note | Part two | A line to quote. | - one | - two',
      'Other note | - two',
      'No note named “Missing” in this workspace.',
      'No heading “Nope” in “Other note”.',
    ];
    expect(JSON.stringify(shown) === JSON.stringify(want), JSON.stringify(shown, null, 1));
    expect(
      await harness.evaluate(() => window.__harness.panelText() === window.__harness.documentText()),
      'drawing the embeds changed the panel text',
    );
  });

  await check('embeds inside embeds stop at the depth limit and at a note already shown', async () => {
    await openEmbeds('![[Chain 1]]\n\n![[Self]]\n');
    const [chain, self] = await embedTexts();
    expect(
      chain ===
        'Chain 1 | Chain 1 | Chain 2 | Chain 2 | Chain 3 | Chain 3 | Not shown: embeds are drawn 3 notes deep at most.',
      `the chain shows ${JSON.stringify(chain)}`,
    );
    expect(
      self === 'Self | Self | A note that embeds itself. | Not shown: this note is already shown around this embed.',
      `the note that embeds itself shows ${JSON.stringify(self)}`,
    );
  });

  await check('an embed draws as the page does, HTML through the door and math included', async () => {
    await openEmbeds('![[Folder/Topic]]\n');
    const drawn = await harness.evaluate(() =>
      window.__harness.countKinds(['key', 'embedded note'], '#tm-root .cm-content .tm-drawn-embed'),
    );
    expect(drawn.key === 1 && drawn['embedded note'] === 1, JSON.stringify(drawn));
    await harness.waitForFunction(() => document.querySelector('#tm-root .tm-drawn-embed .katex'), null, {
      timeout: 10_000,
    });
  });

  await check('an embed is read again when its note changes', async () => {
    await openEmbeds('![[Other note#^quote-1]]\n');
    expect((await embedTexts())[0] === 'Other note | A line to quote.', JSON.stringify(await embedTexts()));
    await harness.evaluate(() =>
      window.__embedFakes.change(
        'notes/Other note.md',
        window.__embedFakes.notes.get('notes/Other note.md').replace('A line to quote.', 'A changed line.'),
      ),
    );
    await harness.waitForFunction(
      () => document.querySelector('#tm-root .tm-drawn-embed')?.innerText.includes('A changed line.'),
      null,
      { timeout: 5000 },
    );
  });

  await check('a link in an embed opens through the host, and the header opens the embedded note', async () => {
    await openEmbeds('![[Other note]]\n');
    const before = await harness.evaluate(() => window.__linkFakes.opened.length);
    await harness.locator('#tm-root .tm-drawn-embed .tm-embed-body .tm-link').first().click();
    await harness.locator('#tm-root .tm-drawn-embed .tm-embed-open').click();
    await harness.waitForFunction((n) => window.__linkFakes.opened.length >= n + 2, before, { timeout: 5000 });
    const opened = await harness.evaluate((n) => window.__linkFakes.opened.slice(n), before);
    expect(
      opened.length === 2 &&
        opened[0].href === 'https://example.com/' &&
        opened[1].kind === 'wikilink' &&
        opened[1].href === 'Other note',
      JSON.stringify(opened),
    );
  });

  await check('the pencil opens the embed line, not the other note', async () => {
    await openEmbeds('Above.\n\n![[Other note#^quote-1]]\n\nBelow.\n', 'edit');
    await harness.locator('#tm-root .tm-drawn-embed .tm-drawn-edit').click();
    await harness.waitForSelector('#tm-root .tm-drawn-open.tm-drawn-embed', { timeout: 5000 });
    const state = await harness.evaluate(() => ({
      open: !!document.querySelector('#tm-root .tm-drawn-open.tm-drawn-embed'),
      source: document.querySelector('#tm-root .cm-content').innerText.includes('![[Other note#^quote-1]]'),
      document: window.__harness.documentText(),
    }));
    expect(state.open && state.source, JSON.stringify(state));
    expect(state.document === 'Above.\n\n![[Other note#^quote-1]]\n\nBelow.\n', 'the document changed');
  });

  // ---------------------------------------------------------------------------
  // Git's conflict markers, on the harness page, whose fake host keeps the document and its undo

  const conflictNote =
    'Above.\n\n<<<<<<< HEAD\nBudget: 4,200.\n=======\nBudget: 4,500.\n>>>>>>> north-wall\n\nBelow.\n';
  /** Opens the note with a conflict in `mode`, and waits until the conflict is drawn. */
  const openConflict = async (mode) => {
    await harness.evaluate(
      ({ t, m }) => {
        document.querySelectorAll('#hx-bar select')[1].value = m;
        return window.__harness.open(t, 'conflict.md');
      },
      { t: conflictNote, m: mode },
    );
    await harness.waitForSelector('#tm-root .tm-drawn-conflict .tm-conflict', { timeout: 5000 });
  };

  await check('a conflict is drawn as one, its sides labeled, with its buttons in the Rich editor', async () => {
    await openConflict('edit');
    const drawing = await harness.evaluate(() => {
      const frame = document.querySelector('#tm-root .tm-drawn-conflict');
      return {
        name: frame.getAttribute('aria-label'),
        labels: [...frame.querySelectorAll('.tm-conflict-label')].map((e) => e.textContent),
        lines: [...frame.querySelectorAll('.tm-conflict-lines')].map((e) => e.textContent),
        buttons: [...frame.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
        heading: !!document.querySelector('#tm-root .cm-line.tm-h1'),
      };
    });
    const want = {
      name: 'Merge conflict',
      labels: ['Current change (HEAD)', 'Incoming change (north-wall)'],
      lines: ['Budget: 4,200.', 'Budget: 4,500.'],
      buttons: [
        'Accept Current Change',
        'Accept Incoming Change',
        'Accept Both Changes',
        'Resolve in Source',
        'Edit the conflict',
      ],
      heading: false,
    };
    expect(JSON.stringify(drawing) === JSON.stringify(want), JSON.stringify(drawing));
  });

  await check('Accept Incoming Change keeps that side in the document, and Undo puts the block back', async () => {
    await openConflict('edit');
    await harness.locator('#tm-root .tm-conflict-accept', { hasText: 'Accept Incoming Change' }).click();
    await documentBecomes(harness, 'Above.\n\nBudget: 4,500.\n\nBelow.\n');
    await harness.evaluate(() => window.__harness.host.history('undo'));
    await documentBecomes(harness, conflictNote);
  });

  await check('in Rich view the conflict has its link and no button that changes the note', async () => {
    await openConflict('view');
    const buttons = await harness.evaluate(() =>
      [...document.querySelectorAll('#tm-root .tm-drawn-conflict button')].map((b) => b.textContent),
    );
    expect(JSON.stringify(buttons) === '["Resolve in Source"]', JSON.stringify(buttons));
  });

  await check('Resolve in Source asks for Source with the cursor at the conflict, and changes nothing', async () => {
    const before = await harness.evaluate(() => window.__harness.host.showSourceRequests);
    // A report of the cursor's own place falls due just before the click, and the page reports
    // again when focus leaves it after: neither may move the host off the conflict.
    await harness.evaluate(() => window.__harness.view.dispatch({ selection: { anchor: 1 } }));
    await harness.locator('#tm-root .tm-conflict-source').click();
    await harness.waitForFunction((n) => window.__harness.host.showSourceRequests > n, before, { timeout: 5000 });
    // The host keeps its last messages only: wait for a view state after the last one so far.
    await harness.evaluate(() => {
      window.__lastBeforeBlur = window.__harness.host.received.at(-1);
      window.dispatchEvent(new Event('blur'));
    });
    await harness.waitForFunction(
      () => {
        const received = window.__harness.host.received;
        for (let i = received.length - 1; i >= 0 && received[i] !== window.__lastBeforeBlur; i--)
          if (received[i].type === 'viewState') return true;
        return false;
      },
      null,
      { timeout: 5000 },
    );
    const state = await harness.evaluate(() => ({
      place: window.__harness.host.lastViewState,
      document: window.__harness.documentText(),
    }));
    const at = conflictNote.indexOf('<<<<<<<');
    expect(state.place.selection.anchor === at && state.place.selection.head === at, JSON.stringify(state.place));
    expect(state.document === conflictNote, 'the document changed');
    // Once the cursor moves, the panel reports its own place again.
    await harness.evaluate(() => window.__harness.view.dispatch({ selection: { anchor: 2 } }));
    await harness.waitForFunction(() => window.__harness.host.lastViewState?.selection.anchor === 2, null, {
      timeout: 5000,
    });
  });

  await check('while a diagram is open large no command changes the note, and its keys count as a field', async () => {
    const note = 'Some text here.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n';
    await harness.evaluate((t) => {
      document.querySelectorAll('#hx-bar select')[1].value = 'edit';
      return window.__harness.open(t, 'diagram.md');
    }, note);
    const button = harness.locator('#tm-root .tm-drawn-diagram .tm-drawn-controls button');
    await button.waitFor({ timeout: 30_000 });
    await harness.evaluate(() => window.__harness.view.dispatch({ selection: { anchor: 5, head: 9 } }));
    await button.click();
    await harness.waitForSelector('#tm-root .tm-diagram-view');
    await harness.waitForFunction(() => window.__harness.host.lastFocus?.field === true, null, { timeout: 5000 });
    for (const id of ['toggleBold', 'insertTable', 'insertRule', 'pastePlain', 'toggleBulletList']) {
      await harness.evaluate((c) => window.__harness.host.post({ type: 'command', id: c }), id);
      await harness.evaluate(() => window.__harness.host.whenQuiet(5000));
    }
    await harness.keyboard.press('Control+b');
    expect((await harness.evaluate(() => window.__harness.documentText())) === note, 'a command changed the note');
    await harness.keyboard.press('Escape');
    await harness.waitForSelector('#tm-root .tm-diagram-view', { state: 'detached' });
    await harness.evaluate(() => window.__harness.host.post({ type: 'command', id: 'toggleBold' }));
    await documentBecomes(harness, note.replace('text', '**text**'));
  });

  await check('Find while a diagram is open large puts it away, and the match it finds is in sight', async () => {
    const note = 'Some text here.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n';
    await harness.evaluate((t) => {
      document.querySelectorAll('#hx-bar select')[1].value = 'edit';
      return window.__harness.open(t, 'diagram.md');
    }, note);
    const button = harness.locator('#tm-root .tm-drawn-diagram .tm-drawn-controls button');
    await button.waitFor({ timeout: 30_000 });
    await button.click();
    await harness.waitForSelector('#tm-root .tm-diagram-view');
    await harness.keyboard.press('Control+f');
    await harness.waitForSelector('#tm-root .tm-diagram-view', { state: 'detached', timeout: 5000 });
    await harness.keyboard.type('text');
    const matchInSight = () =>
      harness.evaluate(() => {
        const match = document.querySelector('#tm-root .cm-searchMatch-selected');
        if (!match) return false;
        const box = match.getBoundingClientRect();
        return match.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      });
    await waitUntil(harness, matchInSight, 'the match found is not in sight');
    await harness.keyboard.press('Escape');
    expect((await harness.evaluate(() => window.__harness.documentText())) === note, 'the note changed');
  });

  // ---------------------------------------------------------------------------
  // The pages' policy, over everything drawn above

  await noScriptRan(page, dialogs);
  await noRequestOutside(outside);
  await noPolicyViolation(reports);

  // Last, since what it tries is refused by the policy, which reports each one.
  await check('the frame cannot reach the page, its storage, a window of its own or the network', async () => {
    await drawAll('```mermaid\ngraph LR;\n  K-->L;\n```\n');
    const frame = await diagramFrame();
    expect(!!frame, 'no diagram frame');
    const tries = await frame.evaluate(async () => {
      const out = {};
      const attempt = async (name, run) => {
        try {
          const value = await run();
          out[name] = `reached: ${String(value).slice(0, 40)}`;
        } catch (error) {
          out[name] = `refused: ${error.name}`;
        }
      };
      await attempt('page', () => parent.document.body.textContent);
      await attempt('lab', () => parent.__lab.text());
      await attempt('cookie', () => document.cookie);
      await attempt('storage', () => localStorage.length);
      await attempt('session', () => sessionStorage.length);
      await attempt('fetch', () => fetch('https://example.invalid/data').then((r) => r.status));
      await attempt('page server', () =>
        fetch(location.ancestorOrigins[0] + '/harness/lab.html').then((r) => r.status),
      );
      await attempt('window', () => {
        const opened = window.open('https://example.invalid/');
        if (!opened) throw new DOMException('no window', 'Refused');
        return opened;
      });
      await attempt('top', () => {
        top.location.href = 'https://example.invalid/';
        return 'navigated';
      });
      // A beacon is queued whatever the policy says; the request log below says whether it left.
      navigator.sendBeacon('https://example.invalid/beacon', 'x');
      // The frame's realm drops picture addresses before the policy is asked, so a picture neither
      // loads nor fails: given a moment, it is refused when it has not loaded.
      await attempt('picture', () => {
        const img = new Image();
        img.src = 'https://example.invalid/pixel.png';
        document.body.appendChild(img);
        return new Promise((resolve, reject) => {
          img.onload = () => resolve('loaded');
          img.onerror = () => reject(new DOMException('not loaded', 'Refused'));
          setTimeout(() => reject(new DOMException('not loaded', 'Refused')), 1000);
        });
      });
      return out;
    });
    const reached = Object.entries(tries).filter(([, v]) => v.startsWith('reached'));
    expect(reached.length === 0, JSON.stringify(Object.fromEntries(reached)));
    await settle(page, 300);
    expect(
      outside.length === 0,
      `requested ${outside
        .slice(0, 3)
        .map((r) => r.url())
        .join(', ')}`,
    );
  });

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
