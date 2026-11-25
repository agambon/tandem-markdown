// VS Code's own features in the rich views, on the two-sided harness page in the installed
// Chrome: problems underlined at their text and carried over unsent typing, their card and
// quick fixes from the pointer and the keyboard, the rename box, suggestions for a link's
// address, and change marks beside the lines that differ from the last commit. VS Code's side
// is harness/fakes/vscode.ts.
//
//   node harness/tests/vscode.spec.mjs
//
// Builds the harness, serves it on a free port, drives harness/index.html headless with the
// vscode.md sample, and exits 0 when every check passes, 1 otherwise. No screenshots, no timing
// assertions: the waits are guards against a hang.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { pageOpener, waitFor, waitOutSuggestionDelay } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('vscode');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** The harness page with the VS Code sample, in Rich editor, once the panel has started. */
async function openHarness() {
  const page = await pages.harness('?sample=vscode.md&mode=edit');
  await waitFor(page, () => window.__harness.view !== null, null, 'the panel did not start');
  return page;
}

/** Publishes problems over the given words of the document as it is now, each with its fix when given. */
const publish = (page, problems) =>
  page.evaluate((list) => {
    const text = window.__harness.documentText();
    window.__vscodeFakes.publish(
      list.map(({ word, ...rest }) => {
        const from = text.indexOf(word);
        if (from < 0) throw new Error(`"${word}" is not in the document`);
        return { from, to: from + word.length, severity: 'warning', message: `About ${word}`, ...rest };
      }),
    );
  }, problems);

/** The underlined text in the panel. */
const underlined = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#tm-root .tm-problem')].map((e) => ({ text: e.textContent })));

/**
 * Puts the cursor `offset` characters into the first `needle` of the panel's text, with the view
 * focused, and waits until the host has been told so. VS Code's keys for the panel go by the
 * focus the panel reports (`tandemMarkdown.fieldFocus`), and so do the harness's: a key pressed
 * while the host still holds a report from a text field that just closed (the rename box) is
 * not the editor's, and nothing runs.
 */
async function placeCursorIn(page, needle, offset = 0) {
  await page.evaluate(
    ({ needle, offset }) => {
      const view = window.__harness.view;
      const at = view.state.doc.toString().indexOf(needle);
      if (at < 0) throw new Error(`"${needle}" is not in the panel`);
      view.focus();
      view.dispatch({ selection: { anchor: at + offset }, userEvent: 'select' });
    },
    { needle, offset },
  );
  await waitFor(
    page,
    () => window.__harness.host.lastFocus?.editor === true && window.__harness.host.lastFocus.field === false,
    null,
    'the host was not told the editor has the focus',
  );
}

/** How long plain typing is watched for a request for suggestions, which it must never make. */
const NOTHING_ASKED_MS = 300;

const MISSPELLED = {
  word: 'mispeled',
  severity: 'error',
  message: 'Unknown word: mispeled',
  source: 'spell',
  code: 'unknown-word',
  fix: { title: "Change to 'misspelled'", insert: 'misspelled' },
};
const MISTAKE = {
  word: 'mistaek',
  message: 'Unknown word: mistaek',
  source: 'spell',
  fix: { title: "Change to 'mistake'", insert: 'mistake' },
};
const MISSING = { word: 'mising', severity: 'information', message: 'Unknown word: mising', source: 'spell' };

try {
  await check('a published problem is underlined at its text, in both views', async () => {
    const page = await openHarness();
    await publish(page, [MISSPELLED, MISTAKE, MISSING]);
    await waitFor(page, () => document.querySelectorAll('#tm-root .tm-problem').length === 3, null, 'no underlines');
    let marks = await underlined(page);
    expect(
      JSON.stringify(marks.map((m) => m.text)) === JSON.stringify(['mispeled', 'mistaek', 'mising']),
      `underlined ${JSON.stringify(marks)}`,
    );
    await page.evaluate(() => window.__harness.host.setMode('view'));
    await waitFor(
      page,
      () => document.querySelector('#tm-root .tm-mode-view, .tm-mode-view') !== null,
      null,
      'no Rich view',
    );
    marks = await underlined(page);
    expect(marks.length === 3, `Rich view underlines ${marks.length}`);
  });

  await check("problems published while typing is unsent stand on their words, over the panel's typing", async () => {
    const page = await openHarness();
    await page.evaluate(() => window.__harness.host.holdPanelEdits());
    await placeCursorIn(page, 'A mispeled');
    await page.keyboard.type('Some typing. ');
    await publish(page, [MISSPELLED, MISTAKE]);
    await waitFor(page, () => document.querySelectorAll('#tm-root .tm-problem').length === 2, null, 'no underlines');
    let marks = await underlined(page);
    expect(marks.map((m) => m.text).join() === 'mispeled,mistaek', `underlined ${JSON.stringify(marks)}`);
    expect(
      !(await page.evaluate(() => window.__harness.documentText().includes('Some typing.'))),
      'the typing was sent',
    );
    await page.evaluate(() => window.__harness.host.releaseHeld());
    await waitFor(
      page,
      () => window.__harness.documentText().includes('Some typing.') && window.__harness.agree(),
      null,
      'the typing did not arrive',
    );
    await page.keyboard.type('More ');
    marks = await underlined(page);
    expect(marks.map((m) => m.text).join() === 'mispeled,mistaek', `after more typing ${JSON.stringify(marks)}`);
  });

  await check('pointing at a problem shows its message and fix, and the fix changes the document', async () => {
    const page = await openHarness();
    await publish(page, [MISSPELLED, MISTAKE]);
    await waitFor(page, () => document.querySelectorAll('#tm-root .tm-problem').length === 2, null, 'no underlines');
    await page.locator('#tm-root .tm-problem-error').hover();
    await waitFor(page, () => document.querySelector('.tm-problem-card-fix') !== null, null, 'no card with a fix');
    const card = await page.evaluate(() => document.querySelector('.tm-problem-card').textContent);
    expect(card.includes('Unknown word: mispeled') && card.includes('spell (unknown-word)'), `the card says ${card}`);
    await page.locator('.tm-problem-card-fix').click();
    await waitFor(
      page,
      () => window.__harness.documentText().includes('A misspelled word') && window.__harness.agree(),
      null,
      'the fix did not change the document',
    );
    await waitFor(
      page,
      () => document.querySelectorAll('#tm-root .tm-problem').length === 1,
      null,
      'the fixed word is still underlined',
    );
    const asked = await page.evaluate(() => window.__vscodeFakes.requests.filter((r) => r.type === 'codeActions'));
    expect(asked.length >= 1 && asked[0].expect && typeof asked[0].expect.hash === 'string', JSON.stringify(asked));
  });

  await check(
    'Quick Fix puts the focus on the first fix, Enter applies it, and Escape closes a card with none',
    async () => {
      const page = await openHarness();
      await publish(page, [MISTAKE, MISSING]);
      await waitFor(page, () => document.querySelectorAll('#tm-root .tm-problem').length === 2, null, 'no underlines');
      await placeCursorIn(page, 'mistaek', 3);
      await page.keyboard.press('Control+Period');
      await waitFor(
        page,
        () => document.activeElement?.classList.contains('tm-problem-card-fix'),
        null,
        'the first fix did not take the focus',
      );
      await page.keyboard.press('Enter');
      await waitFor(
        page,
        () => window.__harness.documentText().includes('**bold mistake**'),
        null,
        'Enter did not apply the fix',
      );
      await waitFor(page, () => document.querySelector('.tm-problem-menu') === null, null, 'the card stayed open');
      await placeCursorIn(page, 'mising', 2);
      await page.keyboard.press('Control+Period');
      await waitFor(
        page,
        () => (document.querySelector('.tm-problem-menu')?.textContent ?? '').includes('No quick fixes here.'),
        null,
        'the card did not say there is no fix',
      );
      await page.keyboard.press('Escape');
      await waitFor(
        page,
        () => document.querySelector('.tm-problem-menu') === null,
        null,
        'Escape did not close the card',
      );
      expect(await page.evaluate(() => window.__harness.view.hasFocus), 'the editor did not keep the focus');
    },
  );

  await check('F2 on a heading opens the rename box with its text; Enter renames it and Escape leaves it', async () => {
    const page = await openHarness();
    await placeCursorIn(page, 'Spelling', 3);
    await page.keyboard.press('F2');
    await waitFor(
      page,
      () => document.activeElement?.classList.contains('tm-rename-input'),
      null,
      'no rename box took the focus',
    );
    const box = await page.evaluate(() => {
      const input = document.activeElement;
      return { value: input.value, selected: input.selectionStart === 0 && input.selectionEnd === input.value.length };
    });
    expect(box.value === 'Spelling' && box.selected, `the box holds ${JSON.stringify(box)}`);
    await page.keyboard.type('Spelling and typos');
    await page.keyboard.press('Enter');
    await waitFor(
      page,
      () => window.__harness.documentText().includes('## Spelling and typos\n') && window.__harness.agree(),
      null,
      'Enter did not rename the heading',
    );
    expect(await page.evaluate(() => window.__harness.view.hasFocus), 'the editor did not get the focus back');
    const before = await page.evaluate(() => window.__harness.documentText());
    await placeCursorIn(page, 'The end', 2);
    await page.keyboard.press('F2');
    await waitFor(
      page,
      () => document.activeElement?.classList.contains('tm-rename-input'),
      null,
      'no second rename box',
    );
    await page.keyboard.type('Changed my mind');
    await page.keyboard.press('Escape');
    await waitFor(page, () => document.querySelector('.tm-rename') === null, null, 'Escape did not close the box');
    expect((await page.evaluate(() => window.__harness.documentText())) === before, 'Escape changed the document');
    await placeCursorIn(page, 'The last paragraph', 4);
    await page.keyboard.press('F2');
    await waitFor(
      page,
      () =>
        (document.querySelector('#tm-root .tm-notices')?.textContent ?? '').includes('Renaming is not supported here'),
      null,
      'no notice for text that cannot be renamed',
    );
  });

  await check("typing a link's address offers the workspace's files, and a folder lists what is in it", async () => {
    const page = await openHarness();
    await placeCursorIn(page, 'Type an address here:', 'Type an address here:'.length);
    await page.keyboard.type(' [x](');
    await waitFor(
      page,
      () =>
        [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((li) =>
          li.textContent.includes('Other note.md'),
        ),
      null,
      'no suggestions after "("',
    );
    await page.keyboard.type('Fo');
    const listed = () => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent);
    await waitFor(
      page,
      () => {
        const items = [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent);
        return items.some((t) => t.includes('Folder/')) && !items.some((t) => t.includes('Other note.md'));
      },
      null,
      'typing did not filter the list to what it matches',
    );
    // A note is named as the folder is, so the folder is chosen by name, not by its place in the list.
    const folderAt = (await page.evaluate(listed)).findIndex((t) => t.includes('Folder/'));
    for (let i = 0; i < folderAt; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitFor(
      page,
      () => window.__harness.view.state.doc.toString().includes('[x](Folder/'),
      null,
      'the folder was not inserted',
    );
    await waitFor(
      page,
      () =>
        [...document.querySelectorAll('.cm-tooltip-autocomplete li')].some((li) => li.textContent.includes('Topic.md')),
      null,
      'the folder did not list what is in it',
    );
    await waitOutSuggestionDelay(page);
    await page.keyboard.press('Enter');
    await waitFor(
      page,
      () => window.__harness.view.state.doc.toString().includes('[x](Folder/Topic.md'),
      null,
      'the file was not inserted',
    );
    const asked = await page.evaluate(() =>
      window.__vscodeFakes.requests.filter((r) => r.type === 'completions').map((r) => r.trigger ?? ''),
    );
    expect(asked.length >= 2 && asked.includes('/'), `asked ${JSON.stringify(asked)}`);
    // Ordinary text asks nothing.
    const count = asked.length;
    await page.keyboard.type(') and plain words.');
    await page.waitForTimeout(NOTHING_ASKED_MS);
    const after = await page.evaluate(
      () => window.__vscodeFakes.requests.filter((r) => r.type === 'completions').length,
    );
    expect(after === count, `plain typing asked VS Code ${after - count} more times`);
  });

  await check('change marks sit beside the lines that differ from the last commit, in Rich editor only', async () => {
    const page = await openHarness();
    await page.evaluate(() => {
      const text = window.__harness.documentText();
      const committed = text
        .replace('## Spelling\n', 'A line taken out since.\n## Spelling\n')
        .replace('Type an address here:\n', '')
        .replace('The last paragraph, which a change mark can sit beside.', 'The old last paragraph.');
      window.__vscodeFakes.marks(committed);
    });
    await waitFor(
      page,
      () => document.querySelectorAll('.tm-change-layer .tm-change').length === 3,
      null,
      'no change marks',
    );
    const placed = await page.evaluate(() => {
      const lineOf = (text) =>
        [...document.querySelectorAll('#tm-root .cm-line')].find((l) => l.textContent.includes(text));
      const rect = (e) => e.getBoundingClientRect();
      const mark = (kind) => rect(document.querySelector(`.tm-change-layer .tm-change-${kind}`));
      const added = mark('added');
      const changed = mark('changed');
      const removed = mark('removed');
      const typeLine = rect(lineOf('Type an address'));
      const lastLine = rect(lineOf('The last paragraph'));
      const spelling = rect(lineOf('Spelling'));
      const content = rect(document.querySelector('#tm-root .cm-content'));
      /** Whether `y` is within `line`'s height. */
      const within = (y, line) => y >= line.top - 1 && y <= line.bottom + 1;
      return {
        added: within((added.top + added.bottom) / 2, typeLine),
        changed: within((changed.top + changed.bottom) / 2, lastLine),
        removed: within(removed.top + removed.height / 2, spelling),
        margin: added.left > content.left && added.right < typeLine.left + 1,
      };
    });
    expect(placed.added && placed.changed && placed.removed && placed.margin, `marks placed ${JSON.stringify(placed)}`);
    await placeCursorIn(page, 'The last paragraph', 0);
    await page.keyboard.type('Typed. ');
    await waitFor(
      page,
      () => document.querySelectorAll('.tm-change-layer .tm-change').length === 3,
      null,
      'typing took a mark away',
    );
    await page.evaluate(() => window.__harness.host.setMode('view'));
    await waitFor(
      page,
      () => document.querySelectorAll('.tm-change-layer .tm-change').length === 0,
      null,
      'Rich view shows change marks',
    );
    await page.evaluate(() => window.__harness.host.setMode('edit'));
    await waitFor(
      page,
      () => document.querySelectorAll('.tm-change-layer .tm-change').length === 3,
      null,
      'Rich editor did not show the marks again',
    );
  });

  await check('clicking a change mark opens its peek card and Revert restores the committed line', async () => {
    const page = await openHarness();
    await page.evaluate(() => {
      const committed = window.__harness
        .documentText()
        .replace('The last paragraph, which a change mark can sit beside.', 'The old last paragraph.');
      window.__vscodeFakes.marks(committed);
    });
    await waitFor(
      page,
      () => document.querySelector('.tm-change-layer .tm-change-changed') !== null,
      null,
      'no changed mark to click',
    );
    await page.click('.tm-change-layer .tm-change-changed');
    await waitFor(
      page,
      () => document.querySelector('.tm-hunk-peek .tm-hunk-code')?.textContent === 'The old last paragraph.',
      null,
      'peek card did not show the committed line',
    );
    await page.click('.tm-hunk-peek .tm-hunk-revert');
    await waitFor(
      page,
      () =>
        document.querySelector('.tm-hunk-peek') === null &&
        window.__harness.documentText().includes('The old last paragraph.') &&
        !window.__harness.documentText().includes('The last paragraph, which a change mark can sit beside.'),
      null,
      'Revert did not restore the committed line',
    );
  });

  await noPolicyViolation(reports);

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
