// Smoke checks of find and replace, paste and copy, and revealHeading in the installed Chrome,
// on the render lab, through the DOM.
//
//   node harness/tests/find-paste.spec.mjs
//
// Builds the harness, serves it on a free port, drives harness/lab.html headless, and exits
// 0 when every check passes, 1 otherwise. No screenshots. Panel commands run through
// `window.__lab.runCommand(id, args)` (on a lab without it, through the page's own buttons, and
// the revealHeading check is skipped); one check clicks the toolbar's Find button either way.
// The clipboard checks use synthetic paste and copy events carrying their own DataTransfer, so
// the system clipboard is never read or written. The HTML fixtures and the markdown each should
// become are in test/panel/paste/fixtures.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report, Skip } from '../checks.mjs';
import { frames, pageOpener } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const fixtures = path.join(repo, 'test', 'panel', 'paste', 'fixtures');
const fixture = (name) => readFileSync(path.join(fixtures, name), 'utf8');

const server = await serveOwnBuild('find-paste');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** How long an HTML paste may wait for its converter to load. A guard against a hang, not a measurement. */
const CONVERTER_WAIT_MS = 5000;

/** The page sees the platform a Mac reports. */
const onMac = (page) =>
  page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));

const hasRunCommand = (page) => page.evaluate(() => typeof window.__lab.runCommand === 'function');

/** Runs the `find` command: through the lab's hook, or the toolbar's Find button. Says which. */
async function runFind(page) {
  if (await hasRunCommand(page)) {
    await page.evaluate(() => window.__lab.runCommand('find'));
    return 'runCommand';
  }
  const button = page.locator('.tm-toolbar button[aria-label="Find"]');
  if ((await button.count()) === 0)
    throw new Error('nothing on the lab page runs the find command (no __lab.runCommand, no toolbar Find button)');
  await button.click();
  return 'toolbar';
}

/** Closes find if it is open, sets the mode, loads `text`, and puts the cursor at the start. */
async function reset(page, text, mode = 'edit') {
  await page.evaluate(
    ({ text, mode }) => {
      document.querySelector('.tm-find .tm-find-close')?.click();
      window.__lab.setMode(mode);
      window.__lab.load(text);
    },
    { text, mode },
  );
  await cursorAt(page, 0);
}

/** Opens find and makes sure the find field has focus (see the first check for why it may not). */
async function openFind(page) {
  await runFind(page);
  await frames(page);
  if (!(await findState(page)).focusInField) await page.locator('.tm-find-field').focus();
}

/** Puts the cursor at `pos` with the editor focused. */
async function cursorAt(page, pos) {
  await page.evaluate((at) => {
    const view = window.__lab.view;
    view.focus();
    view.dispatch({ selection: { anchor: at } });
  }, pos);
  await frames(page);
}

const docText = (page) => page.evaluate(() => window.__lab.text());
const findState = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.tm-find');
    const field = panel?.querySelector('.tm-find-field');
    const sel = window.__lab.view.state.selection.main;
    return {
      open: !!panel,
      count: panel?.querySelector('.tm-find-count')?.textContent ?? null,
      value: field?.value ?? null,
      focusInField: !!field && document.activeElement === field,
      focusInEditor: document.activeElement === window.__lab.view.contentDOM,
      selection: { from: sel.from, to: sel.to },
      selected: window.__lab.view.state.sliceDoc(sel.from, sel.to),
      replaceToggleHidden: panel?.querySelector('.tm-find-expand')?.hidden ?? null,
      replaceRowHidden: panel?.querySelector('.tm-replace-row')?.hidden ?? null,
    };
  });

/** Dispatches a paste event carrying `data` on the editor, as the browser does for Ctrl+V. */
async function paste(page, data) {
  await page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(items.strings)) transfer.setData(type, value);
    for (const file of items.files ?? [])
      transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    window.__lab.view.contentDOM.dispatchEvent(event);
  }, data);
  await frames(page);
}

try {
  const page = await pages.lab('?sample=long.md&mode=edit');
  const sample = await docText(page);
  const lanterns = [...sample.matchAll(/lantern/gi)].map((m) => m.index);

  // ---------------------------------------------------------------------------
  // Find
  // Each check starts from the sample in Rich editor with find closed, so one failure does
  // not leave the next check a page in another state.

  let findPath = '';
  await check('the find command opens find, with focus in the find field', async () => {
    await reset(page, sample);
    findPath = await runFind(page);
    await frames(page);
    const s = await findState(page);
    expect(s.open, 'no find panel');
    expect(
      s.focusInField,
      `focus is not in the find field but in ${s.focusInEditor ? 'the editor' : 'something else'} (opened through ${findPath})`,
    );
  });

  await check("the toolbar's Find button opens find with focus in the find field", async () => {
    await reset(page, sample);
    const button = page.locator('.tm-toolbar button[aria-label="Find"]');
    expect((await button.count()) === 1, 'the toolbar has no Find button');
    await button.click();
    await frames(page);
    const s = await findState(page);
    expect(s.open, 'no find panel');
    expect(
      s.focusInField,
      `focus is not in the find field but in ${s.focusInEditor ? 'the editor' : 'something else'}`,
    );
  });

  await check('typing finds the first match from the cursor and counts them', async () => {
    await reset(page, sample);
    await openFind(page);
    await page.keyboard.type('lantern');
    await frames(page);
    const s = await findState(page);
    expect(s.value === 'lantern', `the field holds "${s.value}"`);
    expect(s.count === `1 of ${lanterns.length}`, `the count reads "${s.count}", not "1 of ${lanterns.length}"`);
    expect(s.selection.from === lanterns[0], `the first match was not selected (${JSON.stringify(s.selection)})`);
    expect(s.focusInField, 'focus left the find field while typing');
    expect((await docText(page)) === sample, 'typing in the find field changed the document');
  });

  await check('Enter and Shift+Enter step through the matches; a match in bold shows its marks', async () => {
    await reset(page, sample);
    await openFind(page);
    await page.keyboard.type('lantern');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await frames(page);
    let s = await findState(page);
    expect(s.count === `3 of ${lanterns.length}`, `after two Enters the count reads "${s.count}"`);
    expect(s.selection.from === lanterns[2], 'the third match is not selected');
    expect(s.focusInField, 'Enter took focus out of the find field');
    const caret = await page.evaluate(() => {
      const f = document.querySelector('.tm-find-field');
      return [f.selectionStart, f.selectionEnd];
    });
    expect(caret[0] === 7 && caret[1] === 7, `Enter selected the field's text (${caret})`);
    const line = await page.evaluate((pos) => {
      const { node } = window.__lab.view.domAtPos(pos);
      const el = node.nodeType === 1 ? node : node.parentElement;
      return el.closest('.cm-line').textContent;
    }, lanterns[2]);
    expect(line.includes('**lantern**'), `the bold marks around the match are not shown: "${line}"`);
    await page.keyboard.press('Shift+Enter');
    await frames(page);
    s = await findState(page);
    expect(s.count === `2 of ${lanterns.length}`, `after Shift+Enter the count reads "${s.count}"`);
  });

  await check("Ctrl+Z in the find field undoes its own typing (the browser's undo, as fieldUndo runs it)", async () => {
    await reset(page, sample);
    await openFind(page);
    await page.keyboard.type('lantern');
    await page.keyboard.press('Space');
    await page.keyboard.type('xyz');
    expect((await findState(page)).value === 'lantern xyz', 'typing did not reach the field');
    await page.evaluate(() => document.execCommand('undo'));
    await frames(page);
    const s = await findState(page);
    expect(s.value !== 'lantern xyz' && 'lantern xyz'.startsWith(s.value), `undo left "${s.value}"`);
    expect(s.focusInField, 'undo took focus out of the field');
    expect((await docText(page)) === sample, 'undo in the find field changed the document');
    const n = s.value ? sample.toLowerCase().split(s.value.toLowerCase()).length - 1 : 0;
    const follows = s.value === '' ? s.count === '' : n === 0 ? s.count === 'No results' : s.count.endsWith(`of ${n}`);
    expect(follows, `after undo the field holds "${s.value}" but the count reads "${s.count}"`);
  });

  await check('the option toggles have tooltips naming their keys, and Alt+C turns match case on', async () => {
    await reset(page, sample);
    await openFind(page);
    await page.keyboard.type('lantern');
    const toggles = await page.evaluate(() =>
      [...document.querySelectorAll('.tm-find-option')].map((b) => ({
        title: b.title,
        pressed: b.getAttribute('aria-pressed'),
      })),
    );
    expect(toggles.length === 3, `${toggles.length} toggles`);
    expect(
      toggles.map((t) => t.title).join('|') ===
        'Match Case (Alt+C)|Match Whole Word (Alt+W)|Use Regular Expression (Alt+R)',
      JSON.stringify(toggles),
    );
    expect(
      toggles.every((t) => t.pressed === 'false'),
      JSON.stringify(toggles),
    );
    await page.keyboard.press('Alt+c');
    await frames(page);
    const pressed = await page.evaluate(() => document.querySelector('.tm-find-option').getAttribute('aria-pressed'));
    const s = await findState(page);
    const exact = [...sample.matchAll(/lantern/g)].length;
    expect(pressed === 'true', 'Alt+C did not press Match Case');
    expect(s.count?.endsWith(`of ${exact}`), `with match case the count reads "${s.count}", expected ${exact}`);
    expect(s.focusInField, 'Alt+C took focus out of the field');
  });

  await check('on a Mac the panel names Mac keys, and Option with a letter types in the find box', async () => {
    const mac = await pages.lab('?sample=long.md&mode=edit', { before: onMac });
    try {
      const bold = await mac.locator('.tm-toolbar button[aria-label="Bold"]').getAttribute('title');
      expect(bold === 'Bold (⌘B)', `the Bold button's tooltip reads ${bold}`);
      await openFind(mac);
      const titles = await mac.evaluate(() =>
        [...document.querySelectorAll('.tm-find-option')].map((b) => b.title).join('|'),
      );
      expect(titles === 'Match Case (⌥⌘C)|Match Whole Word (⌥⌘W)|Use Regular Expression (⌥⌘R)', titles);
      await mac.evaluate(() =>
        window.addEventListener('keydown', (e) => (window.__lastKey = { key: e.key, prevented: e.defaultPrevented })),
      );
      await mac.keyboard.press('Alt+c');
      const option = await mac.evaluate(() => ({
        ...window.__lastKey,
        pressed: document.querySelector('.tm-find-option').getAttribute('aria-pressed'),
      }));
      expect(!option.prevented && option.pressed === 'false', `Option+C was taken: ${JSON.stringify(option)}`);
      await mac.keyboard.press('Meta+Alt+c');
      const pressed = await mac.evaluate(() => document.querySelector('.tm-find-option').getAttribute('aria-pressed'));
      expect(pressed === 'true', 'Option+Cmd+C did not press Match Case');
    } finally {
      await mac.close();
    }
  });

  await check('Escape closes find and puts focus back in the editor', async () => {
    await reset(page, sample);
    await openFind(page);
    await page.keyboard.type('lantern');
    await page.keyboard.press('Escape');
    await frames(page);
    const s = await findState(page);
    expect(!s.open, 'the panel is still open');
    expect(s.focusInEditor, 'focus is not in the editor');
    expect(s.selected.toLowerCase() === 'lantern', 'the match found is no longer selected');
  });

  await check('Replace all changes every match in one go', async () => {
    await reset(page, sample);
    try {
      let via = 'runCommand';
      if (await hasRunCommand(page)) await page.evaluate(() => window.__lab.runCommand('replace'));
      else {
        via = "the panel's Toggle Replace button";
        await openFind(page);
        await page.locator('.tm-find-expand').click();
      }
      await frames(page);
      let s = await findState(page);
      expect(s.replaceRowHidden === false, `the replace row is not showing (opened through ${via})`);
      await page.locator('.tm-find-field').fill('lantern');
      await page.locator('.tm-replace-field').fill('beacon');
      await page.locator('.tm-find-action[aria-label="Replace All"]').click();
      await frames(page);
      const text = await docText(page);
      expect(!/lantern/i.test(text), 'a match was left');
      expect(text === sample.replace(/lantern/gi, 'beacon'), 'Replace all changed more than the matches');
      s = await findState(page);
      expect(s.count === 'No results', `the count reads "${s.count}" after Replace all`);
    } finally {
      await reset(page, sample);
    }
  });

  await check('Rich view has find only, and marks the visible text next to a hidden match', async () => {
    await reset(page, sample, 'view');
    try {
      await page.evaluate(() => window.__lab.view.contentDOM.focus());
      await openFind(page);
      let s = await findState(page);
      expect(s.replaceToggleHidden === true && s.replaceRowHidden === true, 'Rich view offers replace');
      await page.keyboard.type('lantern in a comment');
      await frames(page);
      s = await findState(page);
      expect(s.count === '1 of 1', `the count reads "${s.count}"`);
      const commentShown = await page.evaluate(() =>
        document.querySelector('.cm-content').textContent.includes('lantern in a comment'),
      );
      expect(!commentShown, 'the comment shows in Rich view, so this check proves nothing');
      const near = await page.evaluate(() => [...document.querySelectorAll('.tm-find-near')].map((e) => e.textContent));
      expect(
        near.length === 1 && /^\w+$/.test(near[0]),
        `the visible word next to the hidden comment is not marked (${JSON.stringify(near)})`,
      );
      expect(
        sample.includes(`${near[0]}.\n\n<!-- lantern`) || sample.includes(`-->\n\n${near[0]}`),
        `"${near[0]}" is not next to the comment`,
      );
    } finally {
      await reset(page, sample);
    }
  });

  await check('revealHeading scrolls the heading to the top and puts the cursor at its text', async () => {
    if (!(await hasRunCommand(page)))
      throw new Skip('the lab has no __lab.runCommand, and nothing else on it runs revealHeading');
    await reset(page, sample);
    // A heading with a screen of text below it: one near the end cannot reach the top.
    const from = sample.indexOf('## Section 15');
    const ran = await page.evaluate((at) => window.__lab.runCommand('revealHeading', { from: at }), from);
    expect(ran === true, 'the command returned false');
    await frames(page, 4);
    const where = await page.evaluate((at) => {
      const view = window.__lab.view;
      const block = view.lineBlockAt(at);
      return {
        lineTop: view.documentTop + block.top - view.scrollDOM.getBoundingClientRect().top,
        head: view.state.selection.main.head,
      };
    }, from);
    expect(where.lineTop >= -1 && where.lineTop < 40, `the heading line is ${where.lineTop}px from the top`);
    expect(where.head === from + 3, `the cursor is at ${where.head}, not ${from + 3}`);
  });

  // ---------------------------------------------------------------------------
  // Paste

  for (const [name, label] of [
    ['web-page', 'a web page'],
    ['word', 'Word'],
    ['google-docs', 'Google Docs'],
  ]) {
    await check(`a paste event with HTML from ${label} inserts its markdown`, async () => {
      await page.evaluate(() => window.__lab.load(''));
      await cursorAt(page, 0);
      await paste(page, { strings: { 'text/plain': fixture(`${name}.txt`), 'text/html': fixture(`${name}.html`) } });
      // An HTML paste is held until its converter has loaded (on the first one), then inserted
      // whole: wait for the text, not for frames.
      await page.waitForFunction(() => window.__lab.text() !== '', null, { timeout: CONVERTER_WAIT_MS });
      const got = await docText(page);
      const want = fixture(`${name}.expected.md`).trimEnd();
      if (got !== want) {
        const g = got.split('\n');
        const w = want.split('\n');
        const i = g.findIndex((line, k) => line !== w[k]);
        throw new Error(
          `line ${i + 1} is ${JSON.stringify(g[i])}, expected ${JSON.stringify(w[i])}\n--- got ---\n${got}`,
        );
      }
    });
  }

  await check("VS Code's own copy pastes as its plain text", async () => {
    await page.evaluate(() => window.__lab.load('Before\n\n'));
    await cursorAt(page, 8);
    const code = fixture('vscode.txt');
    await paste(page, {
      strings: {
        'text/plain': code,
        'text/html': fixture('vscode.html'),
        'vscode-editor-data': '{"version":1,"mode":"typescript"}',
      },
    });
    expect((await docText(page)) === `Before\n\n${code}`, `got ${JSON.stringify(await docText(page))}`);
  });

  await check('a web address pasted over selected text makes a link', async () => {
    await page.evaluate(() => window.__lab.load('Read the guide first.'));
    await page.evaluate(() => {
      window.__lab.view.focus();
      window.__lab.view.dispatch({ selection: { anchor: 5, head: 14 } });
    });
    await paste(page, { strings: { 'text/plain': 'https://example.com/guide' } });
    expect(
      (await docText(page)) === 'Read [the guide](https://example.com/guide) first.',
      `got ${JSON.stringify(await docText(page))}`,
    );
  });

  await check('tab-separated text becomes a table of its own', async () => {
    await page.evaluate(() => window.__lab.load('Intro\n'));
    await cursorAt(page, 6);
    await paste(page, { strings: { 'text/plain': 'Name\tAge\nAda\t36\n' } });
    expect(
      (await docText(page)) === 'Intro\n\n| Name | Age |\n| ---- | --- |\n| Ada  | 36  |',
      `got ${JSON.stringify(await docText(page))}`,
    );
  });

  await check('inside a code block the plain text is inserted, even with HTML on the clipboard', async () => {
    await page.evaluate(() => window.__lab.load('```js\nlet a = 1;\n\n```\n'));
    await cursorAt(page, 17);
    await paste(page, { strings: { 'text/plain': 'Getting started', 'text/html': '<h2>Getting <b>started</b></h2>' } });
    expect(
      (await docText(page)) === '```js\nlet a = 1;\nGetting started\n```\n',
      `got ${JSON.stringify(await docText(page))}`,
    );
  });

  await check('a pasted image is sent to the host to save, and nothing is inserted until it answers', async () => {
    await page.evaluate(() => window.__lab.load('Shot: '));
    await cursorAt(page, 6);
    const before = await page.evaluate(() => window.__lab.posted.length);
    await paste(page, {
      strings: {},
      files: [{ name: 'image.png', type: 'image/png', bytes: [137, 80, 78, 71, 13, 10] }],
    });
    await page.waitForFunction((n) => window.__lab.posted.length > n, before, { timeout: 3000 });
    const sent = await page.evaluate((n) => window.__lab.posted.slice(n), before);
    const request = sent.find((m) => m.type === 'saveImage');
    expect(request, `no saveImage request; posted ${JSON.stringify(sent)}`);
    expect(
      request.name === 'image.png' &&
        request.mime === 'image/png' &&
        request.dataBase64 === 'iVBORw0K' &&
        typeof request.requestId === 'string',
      JSON.stringify(request),
    );
    expect((await docText(page)) === 'Shot: ', 'something was inserted before the host answered');
  });

  // ---------------------------------------------------------------------------
  // Copy

  await check(
    'copy puts the markdown as text and as HTML with raw HTML escaped; pasting it back is exact',
    async () => {
      const source = 'A **bold** word and <b>raw</b> html, [[a wikilink]].';
      await page.evaluate((text) => window.__lab.load(`${text}\n`), source);
      await page.evaluate((length) => {
        window.__lab.view.focus();
        window.__lab.view.dispatch({ selection: { anchor: 0, head: length } });
      }, source.length);
      await frames(page);
      const copied = await page.evaluate(() => {
        const transfer = new DataTransfer();
        window.__lab.view.contentDOM.dispatchEvent(
          new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
        return Object.fromEntries(transfer.types.map((t) => [t, transfer.getData(t)]));
      });
      expect(copied['text/plain'] === source, `text/plain is ${JSON.stringify(copied['text/plain'])}`);
      expect(
        copied['text/html']?.includes('<strong>bold</strong>'),
        `text/html is ${JSON.stringify(copied['text/html'])}`,
      );
      expect(
        copied['text/html'].includes('&lt;b&gt;raw&lt;/b&gt;') && !copied['text/html'].includes('<b>'),
        'raw HTML was not escaped',
      );
      expect(copied['application/x-tandem-markdown'] === '1', 'the own-copy mark is missing');
      await cursorAt(page, source.length + 1);
      await paste(page, { strings: copied });
      expect(
        (await docText(page)) === `${source}\n${source}`,
        `pasting the copy back gave ${JSON.stringify(await docText(page))}`,
      );
    },
  );

  await check('typing still lands in the editor', async () => {
    await page.evaluate(() => window.__lab.load('Some text'));
    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    expect((await docText(page)) === 'Some text more', `got ${JSON.stringify(await docText(page))}`);
  });

  await noPolicyViolation(reports);

  await noPageError(reports);

  if (findPath)
    console.log(
      `(find was opened through ${findPath === 'toolbar' ? "the toolbar's Find button" : '__lab.runCommand'})`,
    );
} finally {
  await browser.close();
  await server.close();
}

report();
