// Smoke checks of tables and front matter in the installed Chrome, through the DOM, on the
// render lab (harness/lab.html: the editor with every drawing feature and no host).
//
//   node harness/tests/tables.spec.mjs
//
// Builds the harness, serves it on a free port, drives the lab headless, and exits 0
// when every check passes, 1 otherwise. No screenshots.

import { chromium } from 'playwright-core';
import { check, expect, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { frames, pageOpener } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('tables');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** Loads `text` into the lab with the cursor at the end (outside every table) and waits for it to draw. */
async function load(page, text) {
  await page.evaluate((t) => {
    window.__lab.load(t);
    const view = window.__lab.view;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }, text);
  await frames(page, 3);
}

const text = (page) => page.evaluate(() => window.__lab.text());
const focusedField = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el && el.classList.contains('tm-table-field') ? el.value : null;
  });

// Written as the table model writes a compact table, so a structure edit changes only the rows it adds.
const TABLE = 'Intro\n\n| Fruit | Qty |\n| :--- | ---: |\n| apple | 3 |\n| pear | 10 |\n\nAfter\n';

/** Checks that TABLE has gained an empty row after its last, with the field in that row. */
async function expectNewLastRow(page) {
  const now = await text(page);
  expect(now === TABLE.replace('| pear | 10 |', '| pear | 10 |\n|  |  |'), `the document is ${JSON.stringify(now)}`);
  expect((await focusedField(page)) === '', 'the field is not in the new row');
}

// One plain cell and one with inline marks, for clicks at measured places.
const MARKED =
  'Intro\n\n| Animal | Note |\n| --- | --- |\n| cat | likes zebra sun |\n' +
  '| dog | **bold** and [a link](https://example.com) and `co\\|de` |\n\nAfter\n';

// A cell of what a line draws beyond bold and links: hidden marks, a tag, a wikilink's shown
// text, and an emoji code drawn as its emoji.
const CELL = '==marked== #tag/sub [[Note\\|shown]] :smile:';
const DRAWN = `Intro\n\n| Kind | Text |\n| --- | --- |\n| new | ${CELL} |\n\nAfter\n`;

/**
 * The screen point `part` of the way across character `index` of the first drawn text
 * `needle` in a table cell (which may run over several text nodes).
 */
function charPoint(page, needle, index, part) {
  return page.evaluate(
    ({ needle, index, part }) => {
      for (const cell of document.querySelectorAll('.tm-table th, .tm-table td')) {
        const nodes = [];
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
        const at = nodes
          .map((node) => node.data)
          .join('')
          .indexOf(needle);
        if (at < 0) continue;
        let offset = at + index;
        const node = nodes.find((n) => (offset < n.length ? true : ((offset -= n.length), false)));
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width * part, y: r.top + r.height / 2 };
      }
      throw new Error(`no drawn cell text "${needle}"`);
    },
    { needle, index, part },
  );
}

/** A screen point in the left (`side` -1) or right (1) padding of the cell drawing `needle`, at its middle. */
function paddingPoint(page, needle, side) {
  return page.evaluate(
    ({ needle, side }) => {
      const cell = [...document.querySelectorAll('.tm-table td')].find((c) => c.textContent === needle);
      const r = cell.getBoundingClientRect();
      const style = getComputedStyle(cell);
      const x = side < 0 ? r.left + parseFloat(style.paddingLeft) / 2 : r.right - parseFloat(style.paddingRight) / 2;
      return { x, y: r.top + r.height / 2 };
    },
    { needle, side },
  );
}

/** Clicks at `point`, types `typed`, commits the cell by clicking below the table and returns the document. */
async function clickAndType(page, point, typed) {
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type(typed);
  await page.locator('.cm-line', { hasText: 'After' }).click();
  return text(page);
}

try {
  const page = await pages.lab('?sample=tables.md&mode=edit&theme=light');

  await check('the sample draws its tables as grids and its front matter as a table', async () => {
    await page.evaluate(() => {
      const view = window.__lab.view;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    });
    await frames(page, 3);
    const first = await page.locator('.tm-table-block').first();
    const headers = await first.locator('thead th').allInnerTexts();
    expect(headers.join('|') === 'Fruit|Color|Qty', `first table headers: ${headers.join('|')}`);
    const align = await first
      .locator('tbody tr')
      .first()
      .locator('td')
      .evaluateAll((cells) => cells.map((c) => c.style.textAlign));
    expect(align.join(',') === 'left,center,right', `alignment: ${align.join(',')}`);
    const fm = await page.locator('.tm-fm-table > tbody > tr > th').allInnerTexts();
    expect(fm.slice(0, 3).join(',') === 'title,version,tags', `frontmatter names: ${fm.join(',')}`);
    const nested = await page.evaluate(() => window.__lab.countKinds(['table in front matter']));
    expect(nested['table in front matter'] === 1, 'no nested table for author');
    const fit = await page.evaluate(() => {
      const table = document.querySelector('.tm-fm-table');
      const content = document.querySelector('.cm-content');
      const padding = parseFloat(getComputedStyle(content).paddingRight);
      return table.getBoundingClientRect().right <= content.getBoundingClientRect().right - padding + 1;
    });
    expect(fit, 'a long front matter value pushes its table past the column instead of wrapping');
  });

  await check('clicking a cell, typing and Tab writes that cell and nothing else', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: 'apple' }).click();
    expect((await focusedField(page)) === 'apple', 'the field does not hold the cell text "apple"');
    expect((await page.locator('.tm-table-bar:not([hidden])').count()) === 1, 'the table bar is not shown');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('kiwi');
    await page.keyboard.press('Tab');
    const after = await text(page);
    expect(after === TABLE.replace('| apple |', '| kiwi |'), `the document is ${JSON.stringify(after)}`);
    expect((await focusedField(page)) === '3', 'Tab did not open the next cell');
    expect(
      (await page.locator('.tm-table td', { hasText: 'kiwi' }).count()) === 1,
      'the grid does not show the new text',
    );
  });

  await check('Escape cancels the field', async () => {
    const before = await text(page);
    await page.keyboard.type('999');
    await page.keyboard.press('Escape');
    expect((await text(page)) === before, 'Escape changed the document');
    expect((await page.locator('.tm-table-field').count()) === 0, 'the field is still open');
    expect((await page.locator('.tm-table-bar:not([hidden])').count()) === 0, 'the bar is still shown');
  });

  await check('a click on a character of a cell puts the cursor at that character', async () => {
    const marked = '**bold** and [a link](https://example.com) and `co\\|de`';
    const cases = [
      // The drawn text clicked, which character of it, how far across that character, and
      // the cell's source once X is typed there.
      ['likes zebra sun', 6, 0.25, 'likes Xzebra sun'],
      ['likes zebra sun', 8, 0.75, 'likes zebXra sun'],
      ['bold', 1, 0.25, marked.replace('bold', 'bXold')],
      ['a link', 2, 0.25, marked.replace('a link', 'a Xlink')],
      ['co|de', 2, 0.75, marked.replace('co\\|de', 'co\\|Xde')],
    ];
    for (const [needle, index, part, cell] of cases) {
      await load(page, MARKED);
      const after = await clickAndType(page, await charPoint(page, needle, index, part), 'X');
      expect(
        after === MARKED.replace(cell.replace('X', ''), cell),
        `a click on character ${index} of "${needle}" gave ${JSON.stringify(after)}`,
      );
    }
  });

  await check('a click on what a cell draws puts the cursor at the same place in its source', async () => {
    const cases = [
      ['marked', 2, 0.25, CELL.replace('marked', 'maXrked')],
      ['#tag/sub', 2, 0.75, CELL.replace('#tag/sub', '#taXg/sub')],
      ['shown', 1, 0.25, CELL.replace('shown', 'sXhown')],
    ];
    for (const [needle, index, part, cell] of cases) {
      await load(page, DRAWN);
      const after = await clickAndType(page, await charPoint(page, needle, index, part), 'X');
      expect(
        after === DRAWN.replace(CELL, cell),
        `a click on character ${index} of "${needle}" gave ${JSON.stringify(after)}`,
      );
    }
    // The emoji stands for its whole code: a click on its right half puts the cursor after it.
    await load(page, DRAWN);
    await page.waitForSelector('.tm-table .tm-emoji');
    const box = await page.locator('.tm-table .tm-emoji').boundingBox();
    const after = await clickAndType(page, { x: box.x + box.width * 0.85, y: box.y + box.height / 2 }, 'X');
    expect(after === DRAWN.replace(':smile:', ':smile:X'), `a click on the emoji gave ${JSON.stringify(after)}`);
  });

  await check('a link or a tag in a cell opens with a click in Rich view and Ctrl+click in Rich editor', async () => {
    const opened = () =>
      page.evaluate(() =>
        window.__lab.posted.filter((m) => m.type === 'openLink' || m.type === 'searchTag').map((m) => m.href ?? m.tag),
      );
    const before = (await opened()).length;
    await page.evaluate(() => window.__lab.setMode('view'));
    await load(page, MARKED);
    await page.locator('.tm-table .tm-link', { hasText: 'a link' }).click();
    await page.evaluate(() => window.__lab.setMode('edit'));
    await load(page, DRAWN);
    await page.locator('.tm-table .tm-tag').click({ modifiers: ['Control'] });
    expect((await page.locator('.tm-table-field').count()) === 0, 'Ctrl+click on a tag opened the cell');
    await page.locator('.tm-table td', { hasText: 'new' }).click();
    expect((await focusedField(page)) === 'new', 'a plain click in Rich editor did not open the cell');
    await page.keyboard.press('Escape');
    const found = (await opened()).slice(before);
    expect(JSON.stringify(found) === '["https://example.com","tag/sub"]', `opened ${JSON.stringify(found)}`);
  });

  await check("Rich view's Tab stops on a link in a cell, and Enter follows it", async () => {
    const before = await page.evaluate(() => window.__lab.posted.filter((m) => m.type === 'openLink').length);
    await page.evaluate(() => window.__lab.setMode('view'));
    await load(page, MARKED);
    await page.evaluate(() => window.__lab.view.contentDOM.focus());
    await frames(page, 3);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => ({
      text: document.activeElement?.textContent,
      inTable: !!document.activeElement?.closest('.tm-table'),
    }));
    expect(focused.text === 'a link' && focused.inTable, `Tab went to ${JSON.stringify(focused)}`);
    await page.keyboard.press('Enter');
    const posted = await page.evaluate(
      (n) =>
        window.__lab.posted
          .filter((m) => m.type === 'openLink')
          .slice(n)
          .map((m) => m.href),
      before,
    );
    expect(JSON.stringify(posted) === '["https://example.com"]', `Enter opened ${JSON.stringify(posted)}`);
    await page.evaluate(() => window.__lab.setMode('edit'));
  });

  await check("hovering a link or a footnote's number in a cell shows its card", async () => {
    const note =
      'Intro\n\n| A | B |\n| --- | --- |\n| [a link](https://example.com) | a claim[^n] |\n\nAfter\n\n[^n]: The note.\n';
    for (const mode of ['view', 'edit']) {
      await page.evaluate((m) => window.__lab.setMode(m), mode);
      await load(page, note);
      const link = page.locator('.tm-table .tm-link', { hasText: 'a link' });
      await link.hover();
      await page.waitForSelector('.tm-link-card-address', { timeout: 3000 });
      const card = await page.evaluate(() => ({
        address: document.querySelector('.tm-link-card-address').textContent,
      }));
      expect(card.address === 'https://example.com', `in ${mode} mode the card reads ${card.address}`);
      await page.mouse.move(0, 0);
      await page.waitForSelector('.tm-link-card', { state: 'detached', timeout: 3000 });
      await page.locator('.tm-table .tm-footnote-ref').hover();
      await page.waitForSelector('.tm-link-card-text', { timeout: 3000 });
      const text = await page.evaluate(() => document.querySelector('.tm-link-card-text').textContent);
      expect(text === 'The note.', `in ${mode} mode the footnote's card reads ${JSON.stringify(text)}`);
      await page.mouse.move(0, 0);
      await page.waitForSelector('.tm-link-card', { state: 'detached', timeout: 3000 });
    }
    await page.evaluate(() => window.__lab.setMode('edit'));
  });

  await check("a click in a cell's padding puts the cursor at the nearer end, and Tab at the end", async () => {
    for (const [side, cell] of [
      [-1, 'Xlikes zebra sun'],
      [1, 'likes zebra sunX'],
    ]) {
      await load(page, MARKED);
      const after = await clickAndType(page, await paddingPoint(page, 'likes zebra sun', side), 'X');
      expect(
        after === MARKED.replace('likes zebra sun', cell),
        `a click in the ${side < 0 ? 'left' : 'right'} padding gave ${JSON.stringify(after)}`,
      );
    }
    await load(page, MARKED);
    const cat = await charPoint(page, 'cat', 1, 0.5);
    await page.mouse.click(cat.x, cat.y);
    await page.keyboard.press('Tab');
    await page.keyboard.type('Y');
    expect(
      (await focusedField(page)) === 'likes zebra sunY',
      'Tab did not open the next cell with the cursor at its end',
    );
    await page.keyboard.press('Escape');
  });

  await check('while a cell is open the formatting buttons are off and leave the document alone', async () => {
    await load(page, TABLE);
    // The editor's cursor in "Intro", far from the table, as when a cell is clicked.
    await page.evaluate(() => window.__lab.view.dispatch({ selection: { anchor: 2 } }));
    await page.locator('.tm-table td', { hasText: 'apple' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    const bold = page.locator('.tm-tb-button[aria-label="Bold"]');
    expect((await bold.getAttribute('aria-disabled')) === 'true', 'Bold is not shown as off while a cell is open');
    // Playwright will not click a button marked disabled; the user can, so the clicks are forced.
    await bold.click({ force: true });
    await page.locator('.tm-tb-button[aria-label="Bullet list"]').click({ force: true });
    await page.locator('.tm-tb-button[aria-label="Rule"]').click({ force: true });
    await page.locator('.tm-tb-heading > button').click({ force: true });
    expect(await page.locator('.tm-tb-menu').isHidden(), 'the heading menu opened');
    expect((await text(page)) === TABLE, `a button changed the document: ${JSON.stringify(await text(page))}`);
    expect((await focusedField(page)) === 'appleX', 'the cell lost its field or its text');
    // Leaving the cell writes it, and the buttons work again.
    await page.locator('.cm-line', { hasText: 'After' }).click();
    expect(
      (await text(page)) === TABLE.replace('| apple |', '| appleX |'),
      `leaving the cell wrote ${JSON.stringify(await text(page))}`,
    );
    expect((await bold.getAttribute('aria-disabled')) === null, 'Bold is still off after the cell closed');
  });

  await check('Enter in the last row adds a row and moves down', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: 'pear' }).click();
    await page.keyboard.press('Enter');
    await expectNewLastRow(page);
    await page.keyboard.type('fig');
    await page.locator('.cm-line', { hasText: 'After' }).click();
    expect((await text(page)).includes('| fig |  |'), 'clicking away did not commit the field');
    expect((await page.locator('.tm-table-field').count()) === 0, 'the field is still open after clicking away');
  });

  await check('Tab in the last cell adds a row, Shift+Tab goes back a cell', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: '10' }).click();
    await page.keyboard.press('Tab');
    await expectNewLastRow(page);
    await page.keyboard.press('Shift+Tab');
    expect((await focusedField(page)) === '10', 'Shift+Tab did not go back to the cell before');
    await page.keyboard.press('Escape');
  });

  await check('a table wider than the column scrolls sideways inside it', async () => {
    await load(
      page,
      `| ${'a_long_unbreakable_cell_value_'.repeat(4)} | ${'another_one_'.repeat(8)} |\n| --- | --- |\n| x | y |\n\nEnd\n`,
    );
    const sizes = await page.evaluate(() => {
      const scroll = document.querySelector('.tm-table-scroll');
      const content = document.querySelector('.cm-content');
      return {
        scroll: scroll.scrollWidth,
        client: scroll.clientWidth,
        overflow: content.scrollWidth - content.clientWidth,
      };
    });
    expect(sizes.scroll > sizes.client, `the table does not scroll: ${JSON.stringify(sizes)}`);
    expect(sizes.overflow <= 0, `the page itself is pushed wider: ${JSON.stringify(sizes)}`);
  });

  await check('the bar\'s "Insert row below" adds a row', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: 'apple' }).click();
    await page.locator('.tm-table-bar button[data-action="insertRowBelow"]').click();
    const after = await text(page);
    expect(
      after === TABLE.replace('| apple | 3 |\n', '| apple | 3 |\n|  |  |\n'),
      `the document is ${JSON.stringify(after)}`,
    );
    expect((await page.locator('.tm-table tbody tr').count()) === 3, 'the grid does not have three body rows');
    expect((await focusedField(page)) === '', 'the field did not move to the new row');
    await page.keyboard.press('Escape');
  });

  await check('a field stays open while another cell changes, and writes its own cell', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: 'apple' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' pie');
    // An update from the document changes another cell of the same table.
    await page.evaluate(() => {
      const view = window.__lab.view;
      const at = view.state.doc.toString().indexOf('pear');
      view.dispatch({ changes: { from: at, to: at + 4, insert: 'quince' } });
    });
    await frames(page);
    expect(
      (await focusedField(page)) === 'apple pie',
      'the field closed or lost its text when the table was drawn again',
    );
    expect(
      (await page.locator('.tm-table td', { hasText: 'quince' }).count()) === 1,
      'the other cell was not drawn again',
    );
    await page.keyboard.press('Tab');
    const after = await text(page);
    expect(
      after === TABLE.replace('| apple |', '| apple pie |').replace('| pear |', '| quince |'),
      `the document is ${JSON.stringify(after)}`,
    );
    await page.keyboard.press('Escape');
  });

  await check('a commit after its cell changed underneath is refused, with the text in a notice', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: 'apple' }).click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('mine');
    await page.evaluate(() => {
      const view = window.__lab.view;
      const at = view.state.doc.toString().indexOf('apple');
      view.dispatch({ changes: { from: at, insert: 'red ' } });
    });
    await page.keyboard.press('Enter');
    const after = await text(page);
    expect(after === TABLE.replace('| apple |', '| red apple |'), `the document is ${JSON.stringify(after)}`);
    const notice = await page.locator('.tm-notice-text').last().innerText();
    expect(notice.includes('mine'), `the notice does not show the typed text: ${notice}`);
    expect(
      (await page.locator('.tm-notice-action', { hasText: 'Copy text' }).count()) >= 1,
      'the notice has no Copy text button',
    );

    // The page's clipboard is a stand-in that refuses, or keeps what it is given in
    // `window.__copied`: the system clipboard is never written.
    const notices = () => page.locator('.tm-notice-text').allInnerTexts();
    const copyText = async (refused) => {
      await page.evaluate((refused) => {
        window.__copied = [];
        const writeText = refused
          ? () => Promise.reject(new Error('Denied'))
          : async (t) => void window.__copied.push(t);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      }, refused);
      await page
        .locator('.tm-notice', { hasText: 'mine' })
        .locator('.tm-notice-action', { hasText: 'Copy text' })
        .click();
      await frames(page, 4);
    };

    // A copy that fails leaves the notice, and says the text is still in it.
    await copyText(true);
    let shown = await notices();
    expect(
      shown.some((t) => t === 'Could not copy the text; it is still in the message above.'),
      `no word that the copy failed: ${JSON.stringify(shown)}`,
    );
    expect(
      shown.some((t) => t.includes('mine')),
      'the notice with the typed text went although the copy failed',
    );

    // A copy that succeeds copies the whole text, and only then the notice goes.
    await copyText(false);
    shown = await notices();
    expect(!shown.some((t) => t.includes('what you typed there')), `the notice stayed: ${JSON.stringify(shown)}`);
    const copied = await page.evaluate(() => window.__copied);
    expect(copied.length === 1 && copied[0] === 'mine', `copied ${JSON.stringify(copied)}`);
  });

  await check('"Edit as text" shows the table\'s source lines', async () => {
    await load(page, TABLE);
    await page.locator('.tm-table td', { hasText: 'pear' }).click();
    await page.locator('.tm-table-bar button[data-action="editAsText"]').click();
    await frames(page);
    expect((await page.locator('.tm-table-block').count()) === 0, 'the grid is still drawn');
    const shown = await page.evaluate(() => document.querySelector('.cm-content').innerText);
    expect(
      ['| Fruit | Qty |', '| :--- | ---: |', '| apple | 3 |', '| pear | 10 |'].every((line) => shown.includes(line)),
      `the source lines are not shown: ${JSON.stringify(shown)}`,
    );
    const head = await page.evaluate(() => window.__lab.view.state.selection.main.head);
    expect(head === TABLE.indexOf('pear'), `the cursor is at ${head}, not at the cell`);
  });

  await check('in Rich view a click on a cell opens nothing', async () => {
    await load(page, TABLE);
    await page.evaluate(() => window.__lab.setMode('view'));
    await frames(page);
    await page.locator('.tm-table td', { hasText: 'apple' }).click();
    expect((await page.locator('.tm-table-field').count()) === 0, 'a field opened in Rich view');
    await page.evaluate(() => window.__lab.setMode('edit'));
  });

  await check('the front matter pencil shows the raw text', async () => {
    const tables = async () =>
      (await page.evaluate(() => window.__lab.countKinds(['front matter table'])))['front matter table'];
    await load(page, '---\ntitle: x\nlist: [a, b]\n---\n\nBody\n');
    expect((await tables()) === 1, 'the front matter is not drawn as a table');
    await page.locator('.tm-fm-edit').click();
    await frames(page);
    expect((await tables()) === 0, 'the table is still drawn');
    const raw = await page.evaluate(() => document.querySelector('.cm-content').innerText);
    expect(
      ['---', 'title: x', 'list: [a, b]'].every((line) => raw.includes(line)),
      `the raw lines are not shown: ${JSON.stringify(raw)}`,
    );
    await page.locator('.cm-line', { hasText: 'Body' }).click();
    // The reveal answers stay as they were for a moment after a click (src/panel/render/framework.ts),
    // then settle.
    await page.waitForSelector('.tm-fm-table', { timeout: 2000 }).catch(() => {});
    expect((await tables()) === 1, 'leaving did not draw the table again');
  });

  await check('a grid table cell draws task checkboxes that toggle in place without shifting borders', async () => {
    const grid = [
      '+------------------+----------+',
      '| Tasks            | Notes    |',
      '+==================+==========+',
      '| - [ ] buy milk   | ready    |',
      '| - [x] send mail  | done     |',
      '| - [?] check date | pending  |',
      '+------------------+----------+',
      '',
      'End',
    ].join('\n');
    await page.evaluate(() => window.__lab.setSettings({ syntax: { gridTables: true } }));
    try {
      await load(page, grid);
      await page.waitForSelector('.tm-grid-table input.tm-task');
      const boxes = page.locator('.tm-grid-table input.tm-task');
      expect((await boxes.count()) === 2, `expected 2 checkboxes, got ${await boxes.count()}`);
      expect(!(await boxes.nth(0).isChecked()), 'first task should start unchecked');
      expect(await boxes.nth(1).isChecked(), 'second task should start checked');
      expect((await page.locator('.tm-grid-table .tm-task-mark').count()) === 1, 'marked task should draw');
      await boxes.nth(0).click();
      await frames(page, 2);
      const after = await text(page);
      expect(after === grid.replace('- [ ] buy milk', '- [x] buy milk'), `got ${JSON.stringify(after)}`);
      expect(await page.locator('.tm-grid-table input.tm-task').nth(0).isChecked(), 'first task should now be checked');
    } finally {
      await page.evaluate(() => window.__lab.setSettings({ syntax: {} }));
    }
  });

  await noPolicyViolation(reports);

  await check('no uncaught page error and no feature fault', async () => {
    expect(reports.errors.length === 0, reports.errors.join('; '));
    const faults = await page.evaluate(() => window.__lab.faults());
    expect(faults.length === 0, `faulted: ${faults.join(', ')}`);
  });
} finally {
  await browser.close();
  await server.close();
}

report();
