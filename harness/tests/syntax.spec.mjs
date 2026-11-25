// The optional syntax and inline HTML in the render lab, in the installed Chrome, through the DOM:
// every case of test/panel/syntax/cases/ (one file per family of syntax); how footnotes are
// followed and hovered, front matter links opened, task marks clicked and comments faded; then how
// formulas sit in the page and what a drawn block does. For each case, with its syntax on and under
// its setting's value when it names one: what Rich view shows (each drawn line's text, KaTeX's
// hidden MathML left out) and how many of each kind it draws (src/panel/syntax/kinds.ts); with the
// cursor inside, its source; the pieces that look like the text around them; and the document
// unchanged by all of it. For the cases in `offCases`, that turning the setting off while the view
// stays open shows the text as typed. Exits 0 when every check passes, 1 otherwise. No screenshots.
//
//   node harness/tests/syntax.spec.mjs

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { drawingsDone, frames, pageOpener, placeCursor, settle, waitFor, waitUntil } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const caseFolder = path.join(repo, 'test', 'panel', 'syntax', 'cases');
const cases = readdirSync(caseFolder)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(readFileSync(path.join(caseFolder, name), 'utf8')).cases);

/** How many characters must change to turn `a` into `b`: inserted, deleted or replaced. */
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * The cases turned off while the view stays open: for each setting, and each value of a setting
 * with choices, the one whose text with the setting off differs most from what Rich view draws
 * with it on, so the redraw shows plainly. The first such case in file order wins a tie.
 * test/panel/syntax/cases.test.ts reads every case with its setting off.
 */
const offCases = new Set();
{
  const best = new Map();
  for (const c of cases) {
    if (!c.syntax) continue;
    const key = `${c.syntax}=${c.value ?? ''}`;
    const distance = editDistance(c.off ?? c.example, c.view);
    if (!best.has(key) || distance > best.get(key).distance) best.set(key, { c, distance });
  }
  for (const { c } of best.values()) offCases.add(c);
}

const server = await serveOwnBuild('syntax');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** The text Rich view shows: each line's text, and each block drawing's, KaTeX's hidden MathML left out. */
function shownText(page) {
  return page.evaluate(() => {
    const clone = document.querySelector('.cm-content').cloneNode(true);
    for (const e of clone.querySelectorAll('.katex-mathml, .cm-widgetBuffer')) e.remove();
    return [...clone.children]
      .filter((e) => e.classList.contains('cm-line') || e.textContent)
      .map((e) => e.textContent)
      .join('\n');
  });
}

/** How many of each kind in `names` Rich view draws (src/panel/syntax/kinds.ts). */
function kinds(page, names) {
  return page.evaluate((list) => window.__lab.countKinds(list), names);
}

/** Waits until no picture or player in view waits for its answer or its file. */
async function picturesDone(page) {
  await page.waitForFunction(() => !document.querySelector('.cm-content .tm-image-loading'), null, {
    timeout: 30_000,
  });
  await frames(page, 2);
}

async function load(page, text, { mode = 'view', syntax = {}, trusted = true } = {}) {
  await page.evaluate(
    ({ text, mode, syntax, trusted }) => {
      window.__lab.setSettings({ syntax, workspaceTrusted: trusted });
      window.__lab.setMode(mode);
      window.__lab.load(text);
    },
    { text, mode, syntax, trusted },
  );
  await drawingsDone(page);
  await picturesDone(page);
}

/** Where `piece` first is in `text`, and a cursor position inside it that does not split a character. */
function pieceIn(text, piece) {
  const from = text.indexOf(piece);
  let inside = from + Math.floor(piece.length / 2);
  const code = text.charCodeAt(inside);
  if (code >= 0xdc00 && code <= 0xdfff) inside--;
  return { from, to: from + piece.length, inside };
}

/**
 * How the document's text between `from` and `to` looks different from the line it is on: the
 * first element over it whose color, font, background, decoration or opacity is not the
 * line's own. Null when it looks exactly like the text around it.
 */
function lookOf(page, from, to) {
  return page.evaluate(
    ({ from, to }) => {
      const view = window.__lab.view;
      const start = view.domAtPos(from, 1);
      const end = view.domAtPos(to, -1);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const line = (start.node.nodeType === Node.TEXT_NODE ? start.node.parentElement : start.node).closest('.cm-line');
      const own = getComputedStyle(line);
      const inherited = ['color', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight'];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.data || !range.intersectsNode(text)) continue;
        for (let element = text.parentElement; element && element !== line; element = element.parentElement) {
          const style = getComputedStyle(element);
          const where = `on "${element.className}" over ${JSON.stringify(text.data)}`;
          for (const name of inherited) if (style[name] !== own[name]) return `${name} ${style[name]} ${where}`;
          if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') return `background ${style.backgroundColor} ${where}`;
          if (style.textDecorationLine !== 'none') return `decoration ${style.textDecorationLine} ${where}`;
          if (style.opacity !== '1') return `opacity ${style.opacity} ${where}`;
        }
      }
      return null;
    },
    { from, to },
  );
}

try {
  const page = await pages.lab('?mode=view');

  for (const c of cases) {
    // Each case is drawn with its syntax on, whatever the setting's default; a case of a setting
    // with choices is read under the value it names, and `off` turns it off (`offCases`).
    const on = c.value !== undefined ? { [c.syntax]: c.value } : c.syntax ? { [c.syntax]: true } : {};
    const off = c.value === undefined ? false : 'off';
    await check(`Rich view draws: ${c.name}`, async () => {
      await load(page, c.example, { syntax: on });
      const shown = await shownText(page);
      expect(shown === c.view, `shows ${JSON.stringify(shown)}, not ${JSON.stringify(c.view)}`);
      const drawn = await kinds(page, Object.keys(c.drawn));
      expect(JSON.stringify(drawn) === JSON.stringify(c.drawn), `draws ${JSON.stringify(drawn)}`);
    });

    if (offCases.has(c)) {
      await check(`with ${c.syntax} turned off, it shows as typed: ${c.name}`, async () => {
        await load(page, c.example, { syntax: on });
        await page.evaluate(({ id, value }) => window.__lab.setSettings({ syntax: { [id]: value } }), {
          id: c.syntax,
          value: off,
        });
        await drawingsDone(page);
        await picturesDone(page);
        const shown = await shownText(page);
        const want = c.off ?? c.example;
        expect(shown === want, `shows ${JSON.stringify(shown)}, not ${JSON.stringify(want)}`);
        expect((await page.evaluate(() => window.__lab.text())) === c.example, 'the document changed');
      });
    }

    if (c.cursor) {
      await check(`the cursor inside shows the source: ${c.name}`, async () => {
        await load(page, c.example, { mode: 'edit', syntax: on });
        await placeCursor(page, pieceIn(c.example, c.cursor).inside);
        const shown = await shownText(page);
        expect(shown.includes(c.cursor), `with the cursor in it, shows ${JSON.stringify(shown)}`);
      });
    }

    if (c.plain) {
      await check(`what is not drawn looks like the text around it: ${c.name}`, async () => {
        await load(page, c.example, { syntax: on });
        for (const piece of c.plain.filter((p) => c.view.includes(p))) {
          const { from, to } = pieceIn(c.example, piece);
          const differs = await lookOf(page, from, to);
          expect(differs === null, `in Rich view, ${JSON.stringify(piece)} has ${differs}`);
        }
        await load(page, c.example, { mode: 'edit', syntax: on });
        for (const piece of c.plain) {
          const { from, to, inside } = pieceIn(c.example, piece);
          await placeCursor(page, inside);
          const differs = await lookOf(page, from, to);
          expect(differs === null, `with the cursor in it, ${JSON.stringify(piece)} has ${differs}`);
        }
      });
    }

    await check(`drawing leaves the document as it was: ${c.name}`, async () => {
      const text = await page.evaluate(() => window.__lab.text());
      expect(text === c.example, `the document is ${JSON.stringify(text)}`);
    });
  }

  await check('in a workspace VS Code does not trust, HTML is not drawn', async () => {
    await load(page, 'Press <kbd>Ctrl</kbd> and <img src="a.png"> and <name>.', { trusted: false });
    const shown = await shownText(page);
    expect(shown === 'Press <kbd>Ctrl</kbd> and <img src="a.png"> and <name>.', `shows ${JSON.stringify(shown)}`);
    const drawn = await kinds(page, ['key', 'picture', 'HTML tag shown as code']);
    expect(drawn.key === 0 && drawn.picture === 0, JSON.stringify(drawn));
    expect(drawn['HTML tag shown as code'] === 3, `${drawn['HTML tag shown as code']} tags shown as code, not 3`);
  });

  await check('a tag searches the workspace: a click in Rich view, Ctrl+click in Rich editor, Alt+Enter', async () => {
    const searches = () =>
      page.evaluate(() => window.__lab.posted.filter((m) => m.type === 'searchTag').map((m) => m.tag));
    const before = (await searches()).length;
    await load(page, 'Plan #area/sub today.');
    await page.locator('.tm-tag').click();
    await load(page, 'Plan #area/sub today.', { mode: 'edit' });
    await page.locator('.tm-tag').click({ modifiers: ['Control'] });
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.dispatch({ selection: { anchor: 8 } });
      window.__lab.runCommand('openLink');
    });
    const found = (await searches()).slice(before);
    expect(JSON.stringify(found) === '["area/sub","area/sub","area/sub"]', `searched ${JSON.stringify(found)}`);
  });

  // ---------------------------------------------------------------------------
  // Footnotes

  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of filler between the claim and its note.`);
  const footnoted = ['A claim.[^n] And more.', ...filler, '[^n]: The note, with **bold**.', '    And a second line.']
    .join('\n\n')
    .replace('\n\n    And', '\n    And');
  const noteAt = footnoted.indexOf('The note');
  const refEnd = footnoted.indexOf('[^n]') + 4;
  /** Whether the first element matching `selector` lies wholly inside the window. */
  const inWindow = (selector) =>
    page.evaluate((s) => {
      const element = document.querySelector(s);
      const box = element?.getBoundingClientRect();
      return !!box && box.top >= 0 && box.bottom <= innerHeight;
    }, selector);

  await check("hovering a footnote's number shows the note's text", async () => {
    for (const mode of ['view', 'edit']) {
      await load(page, footnoted, { mode });
      await page.locator('.tm-footnote-ref').hover();
      await page.waitForSelector('.tm-link-card-text', { timeout: 3000 });
      const card = await page.evaluate(() => ({
        text: document.querySelector('.tm-link-card-text')?.textContent,
        button: document.querySelector('.tm-link-card-open')?.textContent,
      }));
      expect(
        card.text === 'The note, with bold. And a second line.' && card.button === 'Go to note',
        `in ${mode} mode the card reads ${JSON.stringify(card)}`,
      );
      await page.mouse.move(0, 0);
    }
    await load(page, 'A claim.^[The note itself, with *emphasis*.] More.');
    await page.locator('.tm-footnote-ref').hover();
    await page.waitForSelector('.tm-link-card-text', { timeout: 3000 });
    const text = await page.evaluate(() => document.querySelector('.tm-link-card-text')?.textContent);
    expect(text === 'The note itself, with emphasis.', `a note written in place reads ${JSON.stringify(text)}`);
    await page.mouse.move(0, 0);
  });

  await check('a footnote is followed to its note and back by a click in Rich view', async () => {
    await load(page, footnoted);
    expect(!(await inWindow('.tm-footnote-number')), 'the note is in the window before the click');
    await page.locator('.tm-footnote-ref').click();
    await waitUntil(page, () => inWindow('.tm-footnote-number'), 'the click did not bring the note into the window');
    await page.locator('.tm-footnote-number').click();
    await waitUntil(page, () => inWindow('.tm-footnote-ref'), 'the number did not lead back to the reference');
  });

  await check('in Rich editor, Ctrl+click and Alt+Enter follow a footnote, putting the cursor there', async () => {
    await load(page, footnoted, { mode: 'edit' });
    await page.locator('.tm-footnote-ref').click({ modifiers: ['Control'] });
    await waitFor(
      page,
      (want) => window.__lab.view.state.selection.main.head === want,
      noteAt,
      async () =>
        `Ctrl+click put the cursor at ${await page.evaluate(() => window.__lab.view.state.selection.main.head)}, not ${noteAt}`,
    );
    await page.evaluate((at) => {
      window.__lab.view.dispatch({ selection: { anchor: at } });
      window.__lab.runCommand('openLink');
    }, footnoted.indexOf('[^n]:'));
    await waitFor(
      page,
      (want) => window.__lab.view.state.selection.main.head === want,
      refEnd,
      async () =>
        `Alt+Enter on the note's label put the cursor at ${await page.evaluate(() => window.__lab.view.state.selection.main.head)}, not ${refEnd}`,
    );
    expect((await page.evaluate(() => window.__lab.text())) === footnoted, 'following a footnote changed the document');
  });

  await check('Tab reaches a footnote in Rich view, and Enter follows it', async () => {
    await load(page, footnoted);
    await page.evaluate(() => window.__lab.view.contentDOM.focus());
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.classList.contains('tm-footnote-ref'));
    expect(focused, 'Tab does not reach the reference');
    await page.keyboard.press('Enter');
    await waitUntil(page, () => inWindow('.tm-footnote-number'), 'Enter did not bring the note into the window');
  });

  await check('wikilinks in front matter values are links, opened with the keys links open with', async () => {
    const text = '---\nauthor: "[[Jane Doe]]"\ntopics:\n  - "[[Topic|the topic]]"\n  - plain\n---\n\nText.';
    const opened = () =>
      page.evaluate(() => window.__lab.posted.filter((m) => m.type === 'openLink').map((m) => m.href));
    const before = (await opened()).length;
    // From the top of the page, so the toolbar covers nothing the clicks aim at.
    const top = () => page.evaluate(() => window.__lab.view.scrollDOM.scrollTo(0, 0));
    await load(page, text);
    await page.waitForSelector('.tm-fm-table .tm-wikilink');
    await top();
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.tm-fm-table .tm-wikilink')].map((e) => e.textContent),
    );
    expect(JSON.stringify(shown) === '["Jane Doe","the topic"]', `the links read ${JSON.stringify(shown)}`);
    await page.locator('.tm-fm-table .tm-wikilink').first().click();
    await load(page, text, { mode: 'edit' });
    // The cursor starts in the front matter, which shows it as typed.
    await placeCursor(page, text.length);
    await page.waitForSelector('.tm-fm-table .tm-wikilink');
    await top();
    await page.locator('.tm-fm-table .tm-wikilink').first().click();
    await page
      .locator('.tm-fm-table .tm-wikilink')
      .nth(1)
      .click({ modifiers: ['Control'] });
    const found = (await opened()).slice(before);
    expect(JSON.stringify(found) === '["Jane Doe","Topic"]', `opened ${JSON.stringify(found)}`);
    expect((await page.evaluate(() => window.__lab.text())) === text, 'the document changed');
  });

  await check('a click on a task box with another mark does not check it; a checkbox still does', async () => {
    const text = '- [?] A question\n- [ ] To do';
    for (const mode of ['view', 'edit']) {
      await load(page, text, { mode });
      // In Rich editor the cursor starts on the first marker, which shows it as typed.
      if (mode === 'edit') await placeCursor(page, text.length);
      await page.locator('.tm-task-mark').click();
      await settle(page);
      expect(
        (await page.evaluate(() => window.__lab.text())) === text,
        `in ${mode} mode the click changed the document`,
      );
    }
    await load(page, text);
    await page.locator('input.tm-task').click();
    await waitFor(
      page,
      (want) => window.__lab.text() === want,
      '- [?] A question\n- [x] To do',
      async () => `the checkbox left ${JSON.stringify(await page.evaluate(() => window.__lab.text()))}`,
    );
  });

  await check('a click on a folding callout chevron opens and closes it', async () => {
    await load(page, '> [!faq]- Question\n> The answer.');
    expect(!(await shownText(page)).includes('The answer.'), 'the folded body shows');
    await page.locator('.tm-callout-fold').click();
    await waitUntil(page, async () => (await shownText(page)).includes('The answer.'), 'the body did not open');
    await page.locator('.tm-callout-fold').click();
    await waitUntil(page, async () => !(await shownText(page)).includes('The answer.'), 'the body did not close');
  });

  await check('a drawn emoji code is named by its code, in its tooltip and for a screen reader', async () => {
    for (const mode of ['view', 'edit']) {
      await load(page, 'Coded :smile: and typed 😄 here.', { mode });
      const named = await page.evaluate(() =>
        [...document.querySelectorAll('.cm-content [title], .cm-content [aria-label], .cm-content [role]')].map(
          (e) => ({
            title: e.getAttribute('title'),
            label: e.getAttribute('aria-label'),
            role: e.getAttribute('role'),
          }),
        ),
      );
      expect(
        JSON.stringify(named) === JSON.stringify([{ title: ':smile:', label: ':smile:', role: 'img' }]),
        `in ${mode} mode: ${JSON.stringify(named)}`,
      );
      const images = await page.getByRole('img', { name: ':smile:', exact: true }).count();
      expect(images === 1, `in ${mode} mode, ${images} images are named :smile:`);
    }
  });

  // ---------------------------------------------------------------------------
  // Formulas

  /**
   * For every formula drawn on the page that fits it: any element in it, or around it up to its
   * line, that can scroll, and any part of what it draws (text, pictures, rules, as far as
   * KaTeX's own clipping shows them) that reaches past a box that clips it.
   */
  const formulaFaults = () =>
    page.evaluate(async () => {
      const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const clips = (style, axis) => (axis === 'x' ? style.overflowX : style.overflowY) !== 'visible';
      const scrolls = (style, axis) => /auto|scroll/.test(axis === 'x' ? style.overflowX : style.overflowY);
      const faults = [];
      let fitting = 0;
      for (const formula of document.querySelectorAll('.cm-content .tm-math, .cm-content .tm-drawn')) {
        const drawing = formula.querySelector('.katex-html');
        if (!drawing) continue;
        formula.scrollIntoView({ block: 'center' });
        await frames();
        const name = formula.querySelector('annotation')?.textContent.trim() ?? formula.textContent;
        const around = [];
        for (let e = formula; e && !e.classList.contains('cm-content'); e = e.parentElement) around.push(e);
        // What the formula draws, each piece cut to the KaTeX boxes that clip it.
        const ink = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
        const add = (rect, from) => {
          let { left, top, right, bottom } = rect;
          for (let e = from; e && e !== formula; e = e.parentElement) {
            const style = getComputedStyle(e);
            const box = e.getBoundingClientRect();
            if (clips(style, 'x')) [left, right] = [Math.max(left, box.left), Math.min(right, box.right)];
            if (clips(style, 'y')) [top, bottom] = [Math.max(top, box.top), Math.min(bottom, box.bottom)];
          }
          if (right <= left || bottom <= top) return;
          ink.left = Math.min(ink.left, left);
          ink.top = Math.min(ink.top, top);
          ink.right = Math.max(ink.right, right);
          ink.bottom = Math.max(ink.bottom, bottom);
        };
        const walker = document.createTreeWalker(drawing, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeType === Node.TEXT_NODE) {
            if (!/[^\s​]/.test(node.data)) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            add(range.getBoundingClientRect(), node.parentElement);
          } else {
            const style = getComputedStyle(node);
            const painted =
              node.localName === 'svg' ||
              parseFloat(style.borderTopWidth) > 0 ||
              parseFloat(style.borderBottomWidth) > 0 ||
              style.backgroundColor !== 'rgba(0, 0, 0, 0)';
            if (painted) add(node.getBoundingClientRect(), node.parentElement);
          }
        }
        const line = formula.closest('.tm-drawn, .cm-line');
        if (ink.right - ink.left > line.clientWidth) continue;
        fitting++;
        for (const e of [...around, ...formula.querySelectorAll('*')]) {
          const style = getComputedStyle(e);
          if (scrolls(style, 'x') && e.scrollWidth > e.clientWidth)
            faults.push(`${name}: "${e.className}" scrolls sideways by ${e.scrollWidth - e.clientWidth} px`);
          if (scrolls(style, 'y') && e.scrollHeight > e.clientHeight)
            faults.push(`${name}: "${e.className}" scrolls up and down by ${e.scrollHeight - e.clientHeight} px`);
        }
        for (const e of around) {
          const style = getComputedStyle(e);
          const box = e.getBoundingClientRect();
          const inner = {
            left: box.left + e.clientLeft,
            top: box.top + e.clientTop,
            right: box.left + e.clientLeft + e.clientWidth,
            bottom: box.top + e.clientTop + e.clientHeight,
          };
          const past = (a, b) => a - b > 0.5;
          if (clips(style, 'x') && (past(inner.left, ink.left) || past(ink.right, inner.right)))
            faults.push(`${name}: "${e.className}" cuts it off at a side`);
          if (clips(style, 'y') && (past(inner.top, ink.top) || past(ink.bottom, inner.bottom)))
            faults.push(`${name}: "${e.className}" cuts it off at the top or bottom`);
        }
      }
      return { fitting, faults };
    });

  const syntaxSample = readFileSync(path.join(repo, 'harness', 'samples', 'syntax.md'), 'utf8');

  await check('no formula in the sample scrolls or is cut off, in Rich view and in Rich editor', async () => {
    for (const mode of ['view', 'edit']) {
      await load(page, syntaxSample, { mode });
      await page.waitForFunction(() => document.querySelectorAll('.cm-content .katex-html').length >= 6);
      const { fitting, faults } = await formulaFaults();
      expect(fitting > 0, `in ${mode} mode, no formula was measured`);
      expect(faults.length === 0, `in ${mode} mode: ${faults.join('; ')}`);
    }
  });

  await check('a formula in a line that is wider than the page breaks across lines and nothing scrolls', async () => {
    await load(page, `Before $${'a+'.repeat(150)}b$ after.`);
    await page.waitForSelector('.tm-math .katex-html');
    const state = await page.evaluate(() => {
      const formula = document.querySelector('.tm-math');
      const scroller = document.querySelector('.cm-scroller');
      const scrolling = [formula, ...formula.querySelectorAll('*')].filter((e) => {
        const style = getComputedStyle(e);
        return (
          (/auto|scroll/.test(style.overflowX) && e.scrollWidth > e.clientWidth) ||
          (/auto|scroll/.test(style.overflowY) && e.scrollHeight > e.clientHeight)
        );
      }).length;
      const groups = formula.querySelectorAll('.katex-html > *');
      const rows = new Set([...groups].map((g) => Math.round(g.getBoundingClientRect().top)));
      return { scrolling, lines: rows.size, pageWider: scroller.scrollWidth > scroller.clientWidth };
    });
    expect(state.scrolling === 0 && !state.pageWider && state.lines > 1, JSON.stringify(state));
  });

  await check('a block formula wider than the page scrolls sideways, never up and down', async () => {
    await load(page, `$$\n${'x+'.repeat(300)}1\n$$`);
    await page.waitForSelector('.tm-drawn .katex-html');
    const state = await page.evaluate(() => {
      const frame = document.querySelector('.tm-drawn');
      const elements = [frame, ...frame.querySelectorAll('*')];
      const sideways = elements.filter(
        (e) => /auto|scroll/.test(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth,
      );
      const upDown = elements.filter(
        (e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight,
      );
      return { sideways: sideways.map((e) => e.className), upDown: upDown.map((e) => e.className) };
    });
    expect(state.sideways.length === 1 && state.upDown.length === 0, JSON.stringify(state));
  });

  await check('the pencil of a drawing wider than the page stays in sight as the drawing scrolls', async () => {
    await load(page, `Above.\n\n$$\n${'x+'.repeat(300)}1\n$$\n\nBelow.\n`, { mode: 'edit' });
    await page.waitForSelector('.tm-drawn .katex-html');
    await page.evaluate(() => {
      const body = document.querySelector('.tm-drawn .tm-drawn-body');
      body.scrollLeft = body.scrollWidth;
    });
    await frames(page, 2);
    const inSight = await page.evaluate(() => {
      const frame = document.querySelector('.tm-drawn').getBoundingClientRect();
      const pencil = document.querySelector('.tm-drawn .tm-drawn-edit').getBoundingClientRect();
      return pencil.width > 0 && pencil.left >= frame.left && pencil.right <= frame.right;
    });
    expect(inSight, 'the pencil scrolled out of sight with the drawing');
    await page.locator('.tm-drawn .tm-drawn-edit').click();
    await waitFor(page, () => !!document.querySelector('.tm-drawn-open'), null, 'the pencil did not open the block');
  });

  // ---------------------------------------------------------------------------
  // The drawn block (a math block)

  const block = 'Above.\n\n$$\nx^2\n$$\n\nBelow.\n';
  /** The text of the drawing in the open block, or of the first drawing, KaTeX's hidden MathML left out. */
  const drawingText = (selector = '.tm-drawn') =>
    page.evaluate((s) => {
      const body = document.querySelector(`${s} .tm-drawn-body`)?.cloneNode(true);
      if (!body) return null;
      for (const e of body.querySelectorAll('.katex-mathml')) e.remove();
      return body.textContent;
    }, selector);

  await check('a drawn block is named for a screen reader, with a named pencil in Rich editor only', async () => {
    await load(page, block);
    const view = await page.evaluate(() => {
      const frame = document.querySelector('.tm-drawn');
      return {
        role: frame?.getAttribute('role'),
        label: frame?.getAttribute('aria-label'),
        pencils: frame?.querySelectorAll('.tm-drawn-edit').length,
      };
    });
    expect(view.role === 'group' && view.label === 'Math', JSON.stringify(view));
    expect(view.pencils === 0, 'Rich view has a pencil');
    await load(page, block, { mode: 'edit' });
    const label = await page.evaluate(() =>
      document.querySelector('.tm-drawn .tm-drawn-edit')?.getAttribute('aria-label'),
    );
    expect(label === 'Edit the math', `the pencil is named ${JSON.stringify(label)}`);
  });

  await check('a click on a drawing leaves the cursor and the block closed; the pencil opens it', async () => {
    await load(page, block, { mode: 'edit' });
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.focus();
      view.dispatch({ selection: { anchor: 0 } });
    });
    await page.locator('.tm-drawn .tm-drawn-body').click();
    // The editor reads where the page's caret is when it next measures, which anything that
    // moves the layout asks for: the promise holds through one.
    await page.evaluate(() => window.__lab.view.requestMeasure());
    await settle(page, 600);
    let state = await page.evaluate(() => ({
      head: window.__lab.view.state.selection.main.head,
      open: !!document.querySelector('.tm-drawn-open'),
    }));
    expect(state.head === 0 && !state.open, `after a click on the drawing: ${JSON.stringify(state)}`);
    await page.locator('.tm-drawn-edit').click();
    await waitFor(page, () => !!document.querySelector('.tm-drawn-open'), null, 'the pencil did not open the block');
    await drawingsDone(page);
    state = await page.evaluate(() => ({
      open: !!document.querySelector('.tm-drawn-open'),
      source: document.querySelector('.cm-content').innerText,
    }));
    expect(state.open, 'the pencil did not open the block');
    expect(state.source.includes('x^2'), 'the source does not show');
  });

  await check('an open block keeps its drawing beneath, drawn again only after the typing pauses', async () => {
    await load(page, block, { mode: 'edit' });
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('x^2') + 3 } });
    });
    await waitFor(page, () => !!document.querySelector('.tm-drawn-open'), null, 'the block did not open');
    await drawingsDone(page);
    const before = await drawingText();
    const element = await page.evaluate(() => {
      window.__drawing = document.querySelector('.tm-drawn-open');
      return !!window.__drawing;
    });
    expect(element && before === 'x2', `the open block's drawing reads ${JSON.stringify(before)}`);
    await page.keyboard.type('+y', { delay: 30 });
    const during = await drawingText();
    expect(during === 'x2', `the drawing changed on the keystroke: ${JSON.stringify(during)}`);
    // Drawn again once the typing pauses.
    await page.waitForFunction(() => {
      const body = document.querySelector('.tm-drawn-open .tm-drawn-body')?.cloneNode(true);
      for (const e of body?.querySelectorAll('.katex-mathml') ?? []) e.remove();
      return body?.textContent === 'x2+y';
    });
    const after = await drawingText();
    expect(after === 'x2+y', `after the pause the drawing reads ${JSON.stringify(after)}`);
    expect(
      await page.evaluate(() => window.__drawing === document.querySelector('.tm-drawn-open')),
      'the drawing was rebuilt',
    );
  });

  await check('a mistake shows a message there and keeps the last good drawing', async () => {
    await page.keyboard.type('\\frac{', { delay: 20 });
    // The message comes once the typing pauses.
    await page.waitForFunction(() => !!document.querySelector('.tm-drawn-open .tm-drawn-error')?.textContent);
    const shown = {
      drawing: await drawingText('.tm-drawn-open'),
      message: await page.evaluate(() => document.querySelector('.tm-drawn-open .tm-drawn-error')?.textContent),
    };
    expect(shown.drawing === 'x2+y', `the drawing reads ${JSON.stringify(shown.drawing)}`);
    expect(!!shown.message, 'no message');
  });

  await check('leaving the block closes it', async () => {
    await page.evaluate(() => window.__lab.view.dispatch({ selection: { anchor: 0 } }));
    await waitFor(
      page,
      () => !document.querySelector('.tm-drawn-open') && !!document.querySelector('.tm-drawn'),
      null,
      'leaving the block did not close it',
    );
  });

  await check('a block longer than the limit shows as code, with a button that draws it anyway', async () => {
    const long = `$$\n${'x+'.repeat(5001)}1\n$$`;
    await load(page, long);
    let state = await page.evaluate(() => ({
      drawn: document.querySelectorAll('.tm-drawn').length,
      button: document.querySelector('.tm-drawn-anyway')?.textContent,
      code: document.querySelectorAll('.tm-drawn-source').length,
    }));
    expect(state.drawn === 0 && state.button === 'Draw anyway' && state.code > 0, JSON.stringify(state));
    await page.evaluate(() => window.__lab.view.contentDOM.focus());
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('tm-drawn-anyway')),
      'Tab does not reach the button',
    );
    await page.keyboard.press('Enter');
    await waitFor(
      page,
      () => document.querySelectorAll('.tm-drawn .katex').length === 1,
      null,
      'Draw anyway did not draw the block',
    );
  });

  await check('after a reload, a block that was being drawn is held back until asked for', async () => {
    const marked = await pages.lab('?mode=view');
    await marked.evaluate(() => {
      window.__marks = [];
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'tm-drawing') window.__marks.push(value);
        return set.call(this, key, value);
      };
    });
    await load(marked, block);
    const key = await marked.evaluate(() => window.__marks[0]);
    expect(typeof key === 'string', 'no mark was kept while drawing');
    // As if the page had gone away mid-drawing: the mark is still there when it comes back.
    await marked.evaluate((k) => sessionStorage.setItem('tm-drawing', k), key);
    await marked.reload();
    await marked.waitForFunction(() => window.__lab !== undefined);
    await marked.evaluate(() => window.__lab.ready);
    await load(marked, block);
    const held = await marked.evaluate(() => document.querySelector('.tm-drawn-held')?.textContent ?? '');
    expect(held.includes('under way'), `the block was not held back: ${JSON.stringify(held)}`);
    await marked.close();
  });

  /**
   * Once the next frames are drawn: the cursor, its line and that line's top on screen, the
   * drawn height of each line within two of it and of the lines numbered in `also`, the scroll
   * position, and whether a block is open.
   */
  const cursorState = (also = []) =>
    page.evaluate(
      (also) =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const view = window.__lab.view;
              const head = view.state.selection.main.head;
              const n = view.state.doc.lineAt(head).number;
              const near = {};
              const lines = [...also];
              for (let i = Math.max(1, n - 2); i <= Math.min(view.state.doc.lines, n + 2); i++) lines.push(i);
              for (const i of lines) near[i] = view.lineBlockAt(view.state.doc.line(i).from).height;
              resolve({
                head,
                line: n,
                top: view.coordsAtPos(head)?.top ?? NaN,
                near,
                scrollTop: view.scrollDOM.scrollTop,
                open: !!document.querySelector('.tm-drawn-open'),
              });
            }),
          ),
        ),
      also,
    );

  /**
   * How far the cursor moved on screen from `a` to `b` when that is more than one line (the
   * taller of the line left and the line reached, as drawn before or after); null otherwise.
   */
  const jumped = (a, b) => {
    const line = Math.max(a.near[a.line] ?? 0, a.near[b.line] ?? 0, b.near[a.line] ?? 0, b.near[b.line] ?? 0);
    const moved = Math.abs(b.top - a.top);
    return moved <= line + 1 ? null : `${Math.round(moved)} px`;
  };

  /** Presses `key` `times` times from where the cursor is, and the cursor's state before and after each press. */
  const walk = async (key, times) => {
    const steps = [await cursorState()];
    for (let i = 0; i < times; i++) {
      await page.keyboard.press(key);
      steps.push(await cursorState());
    }
    for (let i = 1; i < steps.length; i++) {
      const [a, b] = [steps[i - 1], steps[i]];
      const jump = jumped(a, b);
      expect(jump === null, `${key} from line ${a.line} to ${b.line} moved ${jump}`);
    }
    return steps;
  };

  await check('moving the cursor into a block with the arrow keys opens it, one line a key', async () => {
    await load(page, block, { mode: 'edit' });
    await placeCursor(page, 0);
    const steps = await walk('ArrowDown', 8);
    expect(
      steps.some((s) => s.open),
      'the block never opened',
    );
  });

  await check('moving out of a block with the arrow keys closes it, up or down, one line a key', async () => {
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await load(page, block, { mode: 'edit' });
      await placeCursor(page, block.indexOf('x^2'));
      const steps = await walk(key, 3);
      expect(steps[0].open && !steps[steps.length - 1].open, `${key}: ${JSON.stringify(steps.map((s) => s.open))}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Leaving a block opened with the pencil

  /** `middle` between paragraphs that more than fill the window above and below it. */
  const amid = (middle) => {
    const paragraph = (i) => `Paragraph ${i} holds enough plain words to wrap across the column. `.repeat(3).trim();
    const parts = Array.from({ length: 20 }, (_, i) => paragraph(i + 1));
    parts.push(middle, ...Array.from({ length: 20 }, (_, i) => paragraph(i + 21)));
    return `${parts.join('\n\n')}\n`;
  };
  const tall = '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$';

  /** Loads `tall` amid paragraphs in Rich editor, scrolls it to the middle of the window and opens it with its pencil. */
  const openTall = async () => {
    const text = amid(tall);
    await load(page, text, { mode: 'edit' });
    await page.evaluate((from) => {
      const view = window.__lab.view;
      view.focus();
      view.dispatch({ selection: { anchor: 0 }, effects: view.constructor.scrollIntoView(from, { y: 'center' }) });
    }, text.indexOf(tall));
    await waitFor(
      page,
      () => !!document.querySelector('.tm-drawn .tm-drawn-edit'),
      null,
      'tall block did not scroll into view',
    );
    await frames(page, 2);
    await page.locator('.tm-drawn .tm-drawn-edit').click();
    await waitFor(page, () => !!document.querySelector('.tm-drawn-open'), null, 'tall block did not open');
    await drawingsDone(page);
    return text;
  };

  /**
   * Runs `act` on the open block `tall` in `text` and expects it closed, the cursor at the start of
   * the line after it.
   */
  const expectClosedBefore = async (text, act) => {
    const next = text.indexOf(tall) + tall.length + 1;
    expect((await cursorState()).open, 'the block is not open');
    await act();
    await waitUntil(page, async () => !(await cursorState()).open, 'the block is still open');
    await frames(page, 2);
    const after = await cursorState();
    expect(!after.open, 'the block is still open');
    expect(
      after.head === next,
      `the cursor is at ${after.head}, not at ${next}, the start of the line after the block`,
    );
  };

  await check('the pencil is a toggle: while the block is open it is named Done and closes it', async () => {
    const text = await openTall();
    const pencil = await page.evaluate(() => {
      const button = document.querySelector('.tm-drawn-open .tm-drawn-edit');
      return (
        button && {
          label: button.getAttribute('aria-label'),
          title: button.title,
        }
      );
    });
    expect(
      pencil?.label === 'Done editing the math' && pencil.title === 'Done editing the math (Escape)',
      `the open block's pencil: ${JSON.stringify(pencil)}`,
    );
    const named = await page.getByRole('button', { name: 'Done editing the math', exact: true }).count();
    expect(named === 1, `${named} buttons are named "Done editing the math"`);
    await expectClosedBefore(text, () => page.locator('.tm-drawn-open .tm-drawn-edit').click());
    const label = await page.evaluate(() =>
      document.querySelector('.tm-drawn .tm-drawn-edit')?.getAttribute('aria-label'),
    );
    expect(label === 'Edit the math', `the closed block's pencil is named ${JSON.stringify(label)}`);
  });

  await check('Escape closes an open block, once a selection in it is reduced to the cursor', async () => {
    const text = await openTall();
    const x = text.indexOf('x^2');
    await page.evaluate((at) => window.__lab.view.dispatch({ selection: { anchor: at, head: at + 3 } }), x);
    await waitFor(
      page,
      (at) => window.__lab.view.state.selection.main.head === at + 3 && !window.__lab.view.state.selection.main.empty,
      x,
      'selection was not set',
    );
    await page.keyboard.press('Escape');
    await waitFor(
      page,
      () => window.__lab.view.state.selection.main.empty,
      null,
      'first Escape did not collapse selection',
    );
    const first = await page.evaluate(() => ({
      open: !!document.querySelector('.tm-drawn-open'),
      head: window.__lab.view.state.selection.main.head,
      empty: window.__lab.view.state.selection.main.empty,
    }));
    expect(first.open && first.empty && first.head === x + 3, `after the first Escape: ${JSON.stringify(first)}`);
    await expectClosedBefore(text, () => page.keyboard.press('Escape'));
  });

  await check('a click on the drawing beneath an open block closes it', async () => {
    const text = await openTall();
    await expectClosedBefore(text, () => page.locator('.tm-drawn-open .tm-drawn-body').click());
  });

  await check('a block that ends the document closes with the cursor at the end of the line before it', async () => {
    const text = `Above.\n\n${tall}`;
    await load(page, text, { mode: 'edit' });
    await placeCursor(page, text.indexOf('x^2'));
    await page.keyboard.press('Escape');
    await waitFor(page, () => !document.querySelector('.tm-drawn-open'), null, 'Escape did not close end block');
    const state = await page.evaluate(() => ({
      open: !!document.querySelector('.tm-drawn-open'),
      head: window.__lab.view.state.selection.main.head,
    }));
    expect(!state.open && state.head === text.indexOf(tall) - 1, JSON.stringify(state));
  });

  await check(
    'a block that is the whole document stays open, with no pencil: the cursor has nowhere else',
    async () => {
      await load(page, tall, { mode: 'edit' });
      await placeCursor(page, tall.indexOf('x^2'));
      await page.keyboard.press('Escape');
      await settle(page);
      const state = await page.evaluate(() => ({
        open: !!document.querySelector('.tm-drawn-open'),
        pencils: document.querySelectorAll('.tm-drawn-edit').length,
        head: window.__lab.view.state.selection.main.head,
      }));
      expect(state.open && state.pencils === 0 && state.head === tall.indexOf('x^2'), JSON.stringify(state));
    },
  );

  await check('in Rich view, a click on a drawing or Escape opens nothing', async () => {
    await load(page, block);
    await page.locator('.tm-drawn .tm-drawn-body').click();
    await page.keyboard.press('Escape');
    await settle(page);
    const state = await page.evaluate(() => ({
      open: document.querySelectorAll('.tm-drawn-open').length,
      pencils: document.querySelectorAll('.tm-drawn-edit').length,
      code: document.querySelectorAll('.tm-drawn-source').length,
    }));
    expect(state.open === 0 && state.pencils === 0 && state.code === 0, JSON.stringify(state));
  });

  /** Fails unless something matches each of `selectors` in the page and nothing that matches can be typed into. */
  const expectNoneEditable = async (selectors) => {
    const rows = await page.evaluate(
      (list) =>
        list.map((selector) => {
          const found = [...document.querySelectorAll(`.cm-content ${selector}`)];
          return { selector, found: found.length, editable: found.filter((e) => e.isContentEditable).length };
        }),
      selectors,
    );
    for (const { selector, found, editable: count } of rows) {
      expect(found > 0, `nothing drawn for ${selector}`);
      expect(count === 0, `${count} of ${found} ${selector} can be typed into`);
    }
  };

  await check('no drawing can be typed into in Rich editor', async () => {
    // One of every widget (each `RichWidget` subclass under src/panel) and every kind of drawn
    // block, over four documents and an open block.
    const text = [
      '---\ntitle: A note\n---',
      'See :smile:, $a^2$, <kbd>K</kbd> and a<br>b, a note[^1] and <picture><img src="a.png" alt="A"></picture>.',
      '> [!NOTE]\n> Body.',
      '$$\nx^2\n$$',
      '- [?] Maybe.',
      '<details>\n<summary>More</summary>',
      'Inside.',
      '</details>',
      '<div align="center">',
      'Centered.',
      '</div>',
      '<table><tr><td>Cell</td></tr></table>',
      '::: {.columns}\nThe left column.\n:::',
      '+---+---+\n| a | b |\n+===+===+\n| 1 | 2 |\n+---+---+',
      '```mermaid\ngraph TD;\n  A-->B;\n```',
      '[TOC]',
      '![[Other note#Part two]]',
      '[^1]: The note.',
      'The end.\n',
    ].join('\n\n');
    await load(page, text, { mode: 'edit' });
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    await page.waitForSelector('.tm-fm');
    await page.waitForSelector('.tm-drawn .katex');
    await page.waitForSelector('.tm-html-element');
    await page.waitForSelector('.tm-drawn-diagram .tm-diagram');
    await expectNoneEditable([
      '.tm-fm', // FrontmatterTable
      '.tm-drawn', // ClosedDrawing, the frame of every drawn block
      '.tm-math', // InlineFormula
      '.tm-emoji', // EmojiChar
      '.tm-callout-head', // CalloutHead
      '.tm-html-br', // LineBreak
      '.tm-footnote-ref', // FootnoteNumber, a reference
      '.tm-footnote-number', // FootnoteNumber, a note
      '.tm-task-mark', // MarkBox
      '.tm-html-element', // InlineElement
      '.tm-html-hidden', // HiddenTags
      '.tm-box-head', // BoxHead
      '.tm-drawn-html', // drawn block: HTML
      '.tm-drawn-summary', // drawn block: Details
      '.tm-grid-table', // drawn block: Table
      '.tm-drawn-diagram', // drawn block: Diagram
      '.tm-drawn-contents', // drawn block: Contents
      '.tm-drawn-embed', // drawn block: Embedded note
    ]);
    // The drawing beneath an open block (OpenDrawing).
    await placeCursor(page, text.indexOf('x^2'));
    await page.waitForSelector('.tm-drawn-open .katex');
    await expectNoneEditable(['.tm-drawn-open']);

    const more = [
      'An &copy;, a [[Other note#Part two]] and a task:',
      '- [ ] To do.',
      '![A picture](picture.png)',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '```js\nlet a = 1;\n```',
      'The end.\n',
    ].join('\n\n');
    await load(page, more, { mode: 'edit' });
    await placeCursor(page, more.length);
    await expectNoneEditable([
      '.tm-entity', // EntityChar
      '.tm-wikilink-sep', // HeadingSeparator
      '.tm-task', // TaskBox
      '.tm-image-block', // ImageWidget
      '.tm-table-block', // TableWidget
      '.tm-code-header', // CodeHeader
    ]);

    // A block over its kind's size limit (DrawAnyway), not the one drawn anyway above; its bar
    // is beneath it, so the window is scrolled to the end.
    await load(page, `Above.\n\n$$\n${'y+'.repeat(5001)}1\n$$\n`, { mode: 'edit' });
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    });
    await waitFor(page, () => !!document.querySelector('.tm-drawn-held'), null, 'held block did not scroll into view');
    await frames(page, 2);
    await expectNoneEditable(['.tm-drawn-held']);

    // Front matter set to hidden (FrontmatterBar).
    await page.evaluate(() => window.__lab.setSettings({ frontmatterDisplay: 'hidden' }));
    try {
      await load(page, '---\ntitle: A note\n---\n\nText.', { mode: 'edit' });
      await placeCursor(page, '---\ntitle: A note\n---\n\nText.'.length);
      await expectNoneEditable(['.tm-fm-bar']);
    } finally {
      await page.evaluate(() => window.__lab.setSettings({ frontmatterDisplay: 'table' }));
    }
  });

  await check('a library that cannot load leaves a message where the drawing would be, and a log line', async () => {
    // As a webview that refused the file would: KaTeX's stylesheet does not load.
    const failing = await pages.lab('?mode=view&sample=editing.md', {
      before: (page) => page.route('**/katex/katex.min.css', (route) => route.abort()),
    });
    await load(failing, 'In a line $a^2$ here.\n\n$$\nx^2\n$$\n');
    await failing.waitForFunction(() => document.querySelector('.tm-drawn-error')?.textContent, null, {
      timeout: 5000,
    });
    const shown = await failing.evaluate(() => ({
      block: document.querySelector('.tm-drawn-error')?.textContent ?? '',
      inline: document.querySelector('.tm-math.tm-math-error')?.getAttribute('title') ?? '',
      logged: window.__lab.posted.filter((m) => m.type === 'log' && /Could not load what draws/.test(m.message)).length,
    }));
    await failing.close();
    expect(/could not be drawn/.test(shown.block), `the block says ${JSON.stringify(shown.block)}`);
    expect(/could not be drawn/.test(shown.inline), `the formula says ${JSON.stringify(shown.inline)}`);
    expect(shown.logged > 0, 'nothing was logged');
  });

  await noPolicyViolation(reports);

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
