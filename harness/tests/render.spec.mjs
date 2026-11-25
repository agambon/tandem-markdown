// Smoke checks of the render lab in the installed Chrome, through the DOM.
//
//   node harness/tests/render.spec.mjs
//
// Builds the harness, serves it on a free port, drives harness/lab.html headless, and
// exits 0 when every check passes, 1 otherwise. No screenshots.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { pageOpener, scrollTo } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('render');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/**
 * Long paragraphs and a list above and below a fenced block of short code lines, so most of
 * the page is lines CodeMirror has to guess the height of, and no short line of plain text
 * stands before the block.
 */
function longCodeDocument() {
  const paragraph = (i) =>
    `Paragraph ${i} holds enough plain words to wrap across the column several times. `.repeat(4).trim();
  const list = (label) => Array.from({ length: 8 }, (_, i) => `- ${label} item ${i + 1}`).join('\n');
  const code = Array.from({ length: 60 }, (_, i) =>
    i % 3 === 0 ? `function f${i}() {` : i % 3 === 1 ? `  return ${i};` : '}',
  );
  const parts = ['# Walking through a long code block'];
  for (let i = 1; i <= 40; i++) parts.push(paragraph(i));
  parts.push(list('before'), ['```js', ...code, '```'].join('\n'), list('after'));
  for (let i = 41; i <= 80; i++) parts.push(paragraph(i));
  return parts.join('\n\n') + '\n';
}

/**
 * Once the next frames are drawn: the cursor's line number, its top on screen, and the drawn
 * height of each line within three of it, by line number.
 */
function cursorLine(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 3;
        const step = () => {
          if (--frames > 0) return requestAnimationFrame(step);
          const view = window.__lab.view;
          const head = view.state.selection.main.head;
          const doc = view.state.doc;
          const line = doc.lineAt(head).number;
          const near = {};
          for (let n = Math.max(1, line - 3); n <= Math.min(doc.lines, line + 3); n++)
            near[n] = view.lineBlockAt(doc.line(n).from).height;
          resolve({ line, top: view.coordsAtPos(head)?.top ?? Number.NaN, near });
        };
        requestAnimationFrame(step);
      }),
  );
}

try {
  const page = await pages.lab('?sample=everything.md&mode=edit');

  await check("each checkbox is named by its task's text", async () => {
    await scrollTo(page, '- [ ] An open task');
    const names = await page.locator('input.tm-task').evaluateAll((boxes) => boxes.map((b) => b.ariaLabel));
    for (const task of ['An open task', 'A checked task', 'A nested task', 'A task in a numbered list']) {
      expect(names.includes(task), `no checkbox named "${task}": ${JSON.stringify(names)}`);
    }
  });

  await check('clicking a checkbox changes the text, in both modes', async () => {
    await scrollTo(page, '- [ ] An open task');
    const before = await page.evaluate(() => window.__lab.text());
    await page.locator('input.tm-task:not(:checked)').first().click();
    const after = await page.evaluate(() => window.__lab.text());
    expect(after !== before, 'the text did not change');
    expect(
      after.replace('- [x] An open task', '- [ ] An open task') === before,
      'the change was not exactly [ ] to [x]',
    );
    await page.evaluate(() => window.__lab.setMode('view'));
    await page.locator('input.tm-task:checked').first().click();
    const inView = await page.evaluate(() => window.__lab.text());
    expect(inView !== after, 'the checkbox did nothing in Rich view');
    await page.evaluate(() => window.__lab.setMode('edit'));
  });

  await check('Rich view can take keyboard focus', async () => {
    await page.evaluate(() => window.__lab.setMode('view'));
    const state = await page.evaluate(() => {
      const content = document.querySelector('.cm-content');
      content.focus();
      return { focused: document.activeElement === content, editable: content.isContentEditable };
    });
    expect(state.focused, 'Rich view did not take the focus');
    expect(!state.editable, 'Rich view is editable');
    await page.evaluate(() => window.__lab.setMode('edit'));
  });

  const walking = await pages.lab('?sample=editing.md&mode=edit');
  await check('walking through a long code block with Down and Up moves the cursor one line a key', async () => {
    const { open, close } = await walking.evaluate(async (text) => {
      window.__lab.load(text);
      // Drawn and measured once, as a file is before the user moves in it.
      for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
      const doc = window.__lab.view.state.doc;
      const fences = [];
      for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text.startsWith('```')) fences.push(n);
      return { open: fences[0], close: fences[1] };
    }, longCodeDocument());
    const margin = 6;
    await walking.evaluate((n) => {
      const view = window.__lab.view;
      const at = view.state.doc.line(n).from + 2;
      view.focus();
      view.dispatch({ selection: { anchor: at }, effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
    }, open - margin);
    await walking.waitForSelector('.tm-code-header');
    const walk = async (key, last) => {
      const steps = [await cursorLine(walking)];
      while (!last(steps[steps.length - 1].line) && steps.length < 200) {
        await walking.keyboard.press(key);
        steps.push(await cursorLine(walking));
      }
      for (let i = 1; i < steps.length; i++) {
        const [a, b] = [steps[i - 1], steps[i]];
        // One line: the taller of the line left and the line reached, as drawn before or after the key.
        const line = Math.max(a.near[a.line] ?? 0, a.near[b.line] ?? 0, b.near[a.line] ?? 0, b.near[b.line] ?? 0);
        const moved = Math.abs(b.top - a.top);
        expect(
          moved <= line + 1,
          `${key} from line ${a.line} to ${b.line} moved the cursor line ${Math.round(moved)} px on screen`,
        );
      }
    };
    await walk('ArrowDown', (line) => line >= close + margin);
    await walk('ArrowUp', (line) => line <= open - margin);
  });

  const faulty = await pages.lab('?faults&sample=everything.md');
  await check('a widget or build that throws leaves the page drawing and editable', async () => {
    await faulty.evaluate(() =>
      window.__lab.load('# Title\n\nTHROW-IN-DRAW and THROW-IN-BUILD here.\n\nSome **bold** text.\n'),
    );
    await faulty.waitForFunction(() => window.__lab.faults().length === 2, null, { timeout: 3000 });
    const notice = await faulty.locator('.tm-notice').count();
    expect(notice >= 1, 'no notice appeared');
    expect(
      (await faulty.locator('.tm-notice-action').first().innerText()) === 'Reload tab',
      'the notice has no Reload tab button',
    );
    await faulty.waitForFunction(() => !document.querySelector('.tm-fallback'), null, { timeout: 3000 });
    const content = await faulty.locator('.cm-content').innerText();
    expect(content.includes('THROW-IN-DRAW'), "the faulted widget's text is not shown as plain text");
    expect(!content.includes('**'), 'bold stopped drawing after another feature failed');
    expect(
      (await faulty.evaluate(() => window.__lab.countKinds(['level 1 heading'])))['level 1 heading'] === 1,
      'headings stopped drawing after another feature failed',
    );
    await faulty.locator('.cm-line', { hasText: 'Some' }).click();
    await faulty.keyboard.press('End');
    await faulty.keyboard.type(' typed');
    const text = await faulty.evaluate(() => window.__lab.text());
    expect(text.includes('text. typed'), `typing did not land: ${JSON.stringify(text.slice(-40))}`);
  });

  const folding = await pages.lab('?sample=editing.md&mode=edit');
  await check('clicking a heading fold chevron collapses its section and clicking the pill unfolds it', async () => {
    await folding.evaluate(() =>
      window.__lab.load('# First\n\nHidden body line.\n\n## Child\n\nNested body.\n\n# Second\n\nStill visible.\n'),
    );
    await folding.waitForSelector('.tm-heading-fold');
    await folding.locator('.tm-h1').first().hover();
    await folding.locator('.tm-h1 .tm-heading-fold').first().click();
    await folding.waitForSelector('.tm-fold-pill');
    const collapsed = await folding.locator('.cm-content').innerText();
    expect(!collapsed.includes('Hidden body line.'), `body stayed visible while folded: ${JSON.stringify(collapsed)}`);
    expect(
      !collapsed.includes('Nested body.'),
      `nested body stayed visible while folded: ${JSON.stringify(collapsed)}`,
    );
    expect(collapsed.includes('Still visible.'), `next peer section disappeared: ${JSON.stringify(collapsed)}`);
    await folding.locator('.tm-fold-pill').first().click();
    await folding.waitForFunction(() => document.querySelector('.tm-fold-pill') === null, null, { timeout: 3000 });
    const restored = await folding.locator('.cm-content').innerText();
    expect(restored.includes('Hidden body line.'), `body did not come back on unfold: ${JSON.stringify(restored)}`);
    expect(restored.includes('Nested body.'), `nested body did not come back on unfold: ${JSON.stringify(restored)}`);
  });

  await noPolicyViolation(reports);

  await noPageError(reports, (m) => !m.startsWith('Lab: '));
} finally {
  await browser.close();
  await server.close();
}

report();
