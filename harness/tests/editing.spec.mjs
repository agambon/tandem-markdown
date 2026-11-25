// Smoke checks of the editing commands, typing rules and toolbar, in the installed Chrome.
//
//   node harness/tests/editing.spec.mjs
//
// Builds the harness and drives the two-sided harness page (harness/index.html: the real panel
// against the real DocumentCoordinator through the fake host), so every edit is checked in the
// document, not only in the panel. Where a check is about the forwarded-command path, the fake
// host posts a real `{ type: 'command', id }` to the panel, as the host does when a VS Code
// keybinding fires. Two checks need the render lab (harness/lab.html), which has no VS Code
// behind it: that the panel's own keymap leaves Ctrl+B and Ctrl+I to VS Code, and a read-only
// document. Serves the harness on a free port, exits 0 when every check passes. No screenshots:
// everything is read through the DOM and the document text.

import { chromium } from 'playwright-core';
import { check, expect, noPageError, noPolicyViolation, PageReports, report } from '../checks.mjs';
import { documentBecomes, frames, pageOpener, waitFor } from '../pages.mjs';
import { serveOwnBuild } from '../serve.mjs';

const server = await serveOwnBuild('editing');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = new PageReports();
const pages = pageOpener(browser, server, reports);

/** The harness page, once its toolbar is drawn. */
async function openHarness(query) {
  const page = await pages.harness(query);
  await page.waitForSelector('#tm-root .tm-tb');
  await frames(page);
  return page;
}

/** The render lab, once its toolbar is drawn. */
async function openLab(query) {
  const page = await pages.lab(query);
  await page.waitForSelector('.tm-toolbar .tm-tb');
  await frames(page);
  return page;
}

// ---------------------------------------------------------------------------
// The harness page

/** The document's text: VS Code's in-memory text on the host side. */
const documentText = (page) => page.evaluate(() => window.__harness.documentText());

/** Opens `text` as a fresh file and puts the selection on the first `needle` (or the cursor after it). */
async function loadAndSelect(page, text, needle, { cursorAfter = false } = {}) {
  await page.evaluate((t) => window.__harness.open(t, 'editing.md'), text);
  await page.waitForSelector('#tm-root .tm-tb');
  await page.evaluate(
    ({ text, needle, cursorAfter }) => {
      const view = window.__harness.view;
      const at = text.indexOf(needle);
      if (at < 0) throw new Error(`"${needle}" is not in the text`);
      const selection = cursorAfter ? { anchor: at + needle.length } : { anchor: at, head: at + needle.length };
      view.dispatch({ selection });
      view.focus();
    },
    { text, needle, cursorAfter },
  );
  await frames(page);
}

/** Waits until nothing is waiting on the host's side. */
const settled = (page) => page.evaluate(() => window.__harness.host.whenQuiet(5000));

/**
 * Posts `{ type: 'command', id, args }` to the panel through the fake host, as the host does for
 * a keybinding, and waits until the panel has it: the host delivers it in a later task, and a
 * key pressed meanwhile can reach the panel first.
 */
async function forward(page, id, args) {
  await page.evaluate(({ id, args }) => window.__harness.host.post({ type: 'command', id, args }), { id, args });
  await settled(page);
}

/** Waits until the toolbar's view control marks `name` ("Rich view", "Rich editor") as the view shown. */
const viewMarked = (page, name, what) =>
  waitFor(
    page,
    (name) =>
      document.querySelector('#tm-root .tm-tb-views button[aria-pressed="true"]')?.getAttribute('aria-label') === name,
    name,
    what,
  );

/** Has the fake host switch the panel to `mode`, and waits until the toolbar shows it. */
async function hostSwitchesTo(page, mode, what) {
  await page.evaluate((mode) => window.__harness.host.setMode(mode), mode);
  await viewMarked(page, mode === 'view' ? 'Rich view' : 'Rich editor', what);
}

const pressed = (page, label) =>
  page.locator(`#tm-root .tm-tb button[aria-label="${label}"]`).getAttribute('aria-pressed');
const editorHasFocus = (page) => page.evaluate(() => document.activeElement?.classList.contains('cm-content') ?? false);
const visibleButtons = (page, root = '#tm-root') =>
  page
    .locator(`${root} .tm-tb button`)
    .evaluateAll((buttons) =>
      buttons.filter((b) => b.offsetParent !== null).map((b) => b.getAttribute('aria-label') ?? b.textContent),
    );

/** The insert menu's rows: each one's label, and the markdown at its right and whether a screen reader skips it. */
const menuRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-tooltip-autocomplete [role="option"]')].map((row) => {
      const hint = row.querySelector('.tm-insert-hint');
      return {
        label: row.querySelector('.cm-completionLabel')?.textContent ?? '',
        hint: hint?.textContent ?? '',
        hintHidden: hint?.getAttribute('aria-hidden') === 'true',
      };
    }),
  );

/** @codemirror/autocomplete's `interactionDelay`, which the insert menu leaves at its default. */
const MENU_INTERACTION_DELAY_MS = 75;

/** Notes on the insert menu's element the page's time when it is first seen open. */
const markMenuShown = (page) =>
  page.evaluate(() => {
    document.querySelector('.cm-tooltip-autocomplete').dataset.shownAt = String(Date.now());
  });

/**
 * Waits until the insert menu takes an accept key. CodeMirror ignores Enter while the menu waits
 * on its answer to the last key typed (the menu is then `cm-tooltip-autocomplete-disabled`), and
 * until the menu has been open for its interaction delay. A menu that closed and opened again is
 * a new element, counted from when it is first seen here.
 */
async function menuTakesAccept(page) {
  await waitFor(
    page,
    (delay) => {
      const menu = document.querySelector('.cm-tooltip-autocomplete');
      if (!menu || menu.classList.contains('cm-tooltip-autocomplete-disabled')) return false;
      menu.dataset.shownAt ??= String(Date.now());
      return Date.now() - Number(menu.dataset.shownAt) >= delay;
    },
    MENU_INTERACTION_DELAY_MS,
    'the insert menu never took an accept key',
  );
}

try {
  const page = await openHarness('?sample=editing.md&mode=edit');

  await check('every toolbar button has a name and a tooltip, the shortcut in it where there is one', async () => {
    const labels = await page
      .locator('#tm-root .tm-tb button')
      .evaluateAll((buttons) =>
        buttons.map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent, title: b.title })),
      );
    expect(
      labels.length > 0 && labels.every((l) => l.name && l.title),
      `a button has no name or no tooltip: ${JSON.stringify(labels)}`,
    );
    expect(
      labels.find((l) => l.name === 'Bold').title === 'Bold (Ctrl+B)',
      "Bold's tooltip does not give its shortcut",
    );
  });

  await check('a toggleBold command from the host makes the selection bold in the document', async () => {
    await loadAndSelect(page, 'Make this bold.\n', 'this');
    await forward(page, 'toggleBold');
    await documentBecomes(page, 'Make **this** bold.\n');
  });

  await check('the Bold button shows pressed there, and not elsewhere', async () => {
    await frames(page);
    expect((await pressed(page, 'Bold')) === 'true', 'Bold is not pressed inside the bold text');
    await page.evaluate(() => window.__harness.view.dispatch({ selection: { anchor: 1 } }));
    await frames(page);
    expect((await pressed(page, 'Bold')) === 'false', 'Bold is still pressed outside the bold text');
  });

  await check("Ctrl+B and Ctrl+I in the panel format the selection once, through VS Code's keybindings", async () => {
    await loadAndSelect(page, 'Make this bold.\n', 'this');
    await page.keyboard.press('Control+b');
    await documentBecomes(page, 'Make **this** bold.\n');
    // The panel's own Ctrl+I ("select the parent syntax node") would widen the selection to
    // the paragraph before Italic arrives, and the whole line would be made italic.
    await loadAndSelect(page, 'One two three.\n', 'two');
    await page.keyboard.press('Control+i');
    await documentBecomes(page, 'One *two* three.\n');
  });

  await check('clicking Bold formats the selection and leaves focus in the editor', async () => {
    await loadAndSelect(page, 'Make this bold.\n', 'this');
    await page.locator('#tm-root .tm-tb button[aria-label="Bold"]').click();
    await documentBecomes(page, 'Make **this** bold.\n');
    expect(await editorHasFocus(page), 'the editor lost focus to the button');
    await page.locator('#tm-root .tm-tb button[aria-label="Bold"]').click();
    await documentBecomes(page, 'Make this bold.\n');
  });

  await check('clicking Find opens find with focus in its field (a command that moves focus keeps it)', async () => {
    await loadAndSelect(page, 'Find a word.\n', 'word', { cursorAfter: true });
    await page.locator('#tm-root .tm-tb button[aria-label="Find"]').click();
    await frames(page);
    const where = await page.evaluate(() => ({
      open: !!document.querySelector('.tm-find'),
      field: document.activeElement?.classList.contains('tm-find-field') ?? false,
    }));
    expect(where.open, 'no find panel');
    expect(where.field, 'focus is not in the find field');
    await page.keyboard.press('Escape');
  });

  await check('Enter in a list makes a new item', async () => {
    await loadAndSelect(page, '- first', 'first', { cursorAfter: true });
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await documentBecomes(page, '- first\n- second');
  });

  await check('Tab indents it, keeps focus, and Shift+Tab brings it back', async () => {
    await page.keyboard.press('Tab');
    await documentBecomes(page, '- first\n  - second');
    expect(await editorHasFocus(page), 'Tab moved focus out of the editor');
    await page.keyboard.press('Shift+Tab');
    await documentBecomes(page, '- first\n- second');
    expect(await editorHasFocus(page), 'Shift+Tab moved focus out of the editor');
  });

  await check('Enter on the empty item ends the list', async () => {
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await documentBecomes(page, '- first\n- second\n');
  });

  await check(
    'with Tab Moves Focus on, Tab and Shift+Tab leave the editor and the text, and Ctrl+M keeps it on',
    async () => {
      const text = '- first\n- second';
      await loadAndSelect(page, text, 'second', { cursorAfter: true });
      await forward(page, 'setTabMovesFocus', { on: true });
      try {
        // CodeMirror's own toggle for this key is left out: the mode is VS Code's.
        await page.keyboard.press('Control+m');
        await page.keyboard.press('Tab');
        expect(!(await editorHasFocus(page)), 'Tab stayed in the editor');
        await page.evaluate(() => window.__harness.view.focus());
        await page.keyboard.press('Shift+Tab');
        expect(!(await editorHasFocus(page)), 'Shift+Tab stayed in the editor');
        const panelText = await page.evaluate(() => window.__harness.panelText());
        expect(panelText === text, `Tab changed the text to ${JSON.stringify(panelText)}`);
      } finally {
        await forward(page, 'setTabMovesFocus', { on: false });
      }
      await page.evaluate(() => window.__harness.view.focus());
      await page.keyboard.press('Tab');
      await documentBecomes(page, '- first\n  - second');
      expect(await editorHasFocus(page), 'with the mode off, Tab moved focus out of the editor');
    },
  );

  await check('typing * over a selection wraps it', async () => {
    await loadAndSelect(page, 'One word here.', 'word');
    await page.keyboard.type('*');
    await documentBecomes(page, 'One *word* here.');
  });

  await check('the heading menu shows the level and sets a new one', async () => {
    await loadAndSelect(page, '# Title\n\nText', 'Title', { cursorAfter: true });
    const menuButton = page.locator('#tm-root .tm-tb button[aria-haspopup="menu"]');
    expect(
      (await menuButton.innerText()).includes('Heading 1'),
      `the menu button reads ${await menuButton.innerText()}`,
    );
    await menuButton.click();
    const checked = await page.locator('#tm-root .tm-tb-menu [role="menuitemradio"][aria-checked="true"]').innerText();
    expect(checked.includes('Heading 1'), `the checked item is ${checked}`);
    await page.locator('#tm-root .tm-tb-menu [role="menuitemradio"]', { hasText: 'Heading 2' }).click();
    await documentBecomes(page, '## Title\n\nText');
    expect(await page.locator('#tm-root .tm-tb-menu').isHidden(), 'the menu stayed open');
    expect(await editorHasFocus(page), 'choosing a level took focus from the editor');
  });

  await check('typing / opens the insert menu, named Insert, and Enter makes the line a heading', async () => {
    await loadAndSelect(page, 'Intro\n', 'Intro', { cursorAfter: true });
    await page.keyboard.type(' /h2');
    await page.waitForSelector('.cm-tooltip-autocomplete [role="listbox"][aria-label="Insert"]');
    await menuTakesAccept(page);
    const rows = await menuRows(page);
    expect(rows.length === 1 && rows[0].label === 'Heading 2', `the menu shows ${JSON.stringify(rows)}`);
    expect(rows[0].hint === '##' && rows[0].hintHidden, `the row's markdown: ${JSON.stringify(rows[0])}`);
    await page.keyboard.press('Enter');
    await documentBecomes(page, '## Intro\n');
  });

  await check('Escape closes the insert menu and leaves the / typed', async () => {
    await loadAndSelect(page, 'Intro\n', 'Intro', { cursorAfter: true });
    await page.keyboard.type(' /');
    await page.waitForSelector('.cm-tooltip-autocomplete [aria-label="Insert"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.cm-tooltip-autocomplete', { state: 'detached' });
    await documentBecomes(page, 'Intro /\n');
  });

  await check('the Insert button opens the menu with nothing typed; typing narrows it and Enter inserts', async () => {
    await loadAndSelect(page, 'Intro\n\n', 'Intro\n\n', { cursorAfter: true });
    const button = page.locator('#tm-root .tm-tb button[aria-label="Insert"]');
    expect(
      (await button.getAttribute('title')) === 'Insert (/)',
      `its tooltip is ${await button.getAttribute('title')}`,
    );
    await button.click();
    await page.waitForSelector('.cm-tooltip-autocomplete [aria-label="Insert"]');
    await markMenuShown(page);
    expect((await menuRows(page)).length > 20, 'the menu does not show every entry');
    expect(await editorHasFocus(page), 'the button took focus from the editor');
    await page.keyboard.type('quote');
    await menuTakesAccept(page);
    await waitFor(
      page,
      () => document.querySelectorAll('.cm-tooltip-autocomplete [role="option"]').length === 1,
      null,
      async () => `typing narrows the menu to ${JSON.stringify(await menuRows(page))}`,
    );
    await page.keyboard.press('Enter');
    await documentBecomes(page, 'Intro\n\n> ');
  });

  await check('the view control asks the host to switch, and shows the view the host chose', async () => {
    const before = await page.evaluate(() => window.__harness.host.received.length);
    await page.locator('#tm-root .tm-tb button[aria-label="Source"]').click();
    await page.locator('#tm-root .tm-tb-views button[aria-label="Rich view"]').click();
    await waitFor(
      page,
      () => window.__harness.view && window.__harness.host.mode === 'view',
      null,
      'the host did not switch to Rich view',
    );
    const posted = await page.evaluate((n) => window.__harness.host.received.slice(n), before);
    const switches = posted.filter((m) => m.type === 'switchView').map((m) => m.to);
    expect(JSON.stringify(switches) === '["source","view"]', `posted ${JSON.stringify(posted)}`);
    await viewMarked(page, 'Rich view', 'Rich view is not marked as the current view');
    await hostSwitchesTo(page, 'edit', 'the panel did not come back to Rich editor');
  });

  await check('the editor is named for the view and the file', async () => {
    await loadAndSelect(page, 'Some text', 'text', { cursorAfter: true });
    const named = (want) =>
      waitFor(
        page,
        (w) => document.querySelector('#tm-root .cm-content')?.getAttribute('aria-label') === w,
        want,
        async () =>
          `the editor is named ${await page.evaluate(() => document.querySelector('#tm-root .cm-content')?.getAttribute('aria-label'))}, not ${want}`,
      );
    await named('Rich editor, editing.md');
    await page.evaluate(() => window.__harness.host.setMode('view'));
    await named('Rich view, editing.md');
    await page.evaluate(() => window.__harness.host.setMode('edit'));
    await named('Rich editor, editing.md');
  });

  await check('Alt+F10 reaches the bar, arrow keys move along it, Escape returns to the editor', async () => {
    await loadAndSelect(page, 'Some text', 'text', { cursorAfter: true });
    await page.keyboard.press('Alt+F10');
    const first = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(first === 'Bold', `Alt+F10 focused ${first}`);
    await page.keyboard.press('ArrowRight');
    const second = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(second === 'Italic', `ArrowRight focused ${second}`);
    await page.keyboard.press('End');
    const last = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(last === 'Find', `End focused ${last}`);
    await page.keyboard.press('Escape');
    expect(await editorHasFocus(page), 'Escape did not return focus to the editor');
  });

  // Ctrl+B formats the selection, Tab leaves the bar, and the find box is reported as a field.
  await check('focus on the toolbar counts as focus in the panel', async () => {
    await loadAndSelect(page, 'Make this bold.\n', 'this');
    await page.keyboard.press('Alt+F10');
    await waitFor(
      page,
      () =>
        document.activeElement?.closest('.tm-tb') &&
        window.__harness.host.lastFocus?.editor === true &&
        window.__harness.host.lastFocus?.field === false,
      null,
      async () =>
        `with focus on the toolbar the panel reports ${JSON.stringify(await page.evaluate(() => window.__harness.host.lastFocus))}`,
    );
    await page.keyboard.press('Control+b');
    await documentBecomes(page, 'Make **this** bold.\n');
    await page.keyboard.press('Tab');
    expect(!(await page.evaluate(() => !!document.activeElement?.closest('.tm-tb'))), 'Tab did not leave the toolbar');
    await documentBecomes(page, 'Make **this** bold.\n');
    await page.locator('#tm-root .tm-tb button[aria-label="Find"]').click();
    await waitFor(
      page,
      () => window.__harness.host.lastFocus?.editor === true && window.__harness.host.lastFocus?.field === true,
      null,
      'the find box is not reported as a field',
    );
    await page.keyboard.press('Escape');
  });

  await check(
    'Rich view shows only the view control and Find, and ignores a formatting command from the host',
    async () => {
      await loadAndSelect(page, 'Make this bold.\n', 'this');
      await hostSwitchesTo(page, 'view', 'the panel did not switch to Rich view');
      const visible = await visibleButtons(page);
      expect(
        JSON.stringify(visible) === '["Source","Rich view","Rich editor","Find"]',
        `visible: ${JSON.stringify(visible)}`,
      );
      await forward(page, 'toggleBold');
      await frames(page);
      expect(
        (await documentText(page)) === 'Make this bold.\n',
        `the text is ${JSON.stringify(await documentText(page))}`,
      );
      expect(
        (await page.evaluate(() => window.__harness.runCommand('toggleBold'))) === false,
        'a formatting command ran in Rich view',
      );
      await hostSwitchesTo(page, 'edit', 'the panel did not come back to Rich editor');
    },
  );

  // ---------------------------------------------------------------------------
  // The render lab: no VS Code behind the panel

  const lab = await openLab('?sample=editing.md&mode=edit');
  // Pressed on the lab, which has no host, they change neither the text nor the selection.
  await check("the panel's own keymap leaves Ctrl+B and Ctrl+I to VS Code", async () => {
    for (const [key, text, needle] of [
      ['Control+b', 'Make this bold.\n', 'this'],
      ['Control+i', 'One two three.\n', 'two'],
    ]) {
      await lab.evaluate(
        ({ text, needle }) => {
          window.__lab.load(text);
          const at = text.indexOf(needle);
          window.__lab.view.dispatch({ selection: { anchor: at, head: at + needle.length } });
          window.__lab.view.focus();
        },
        { text, needle },
      );
      await frames(lab);
      const before = await lab.evaluate(() => JSON.stringify(window.__lab.view.state.selection.toJSON()));
      await lab.keyboard.press(key);
      await frames(lab);
      const after = await lab.evaluate(() => JSON.stringify(window.__lab.view.state.selection.toJSON()));
      const now = await lab.evaluate(() => window.__lab.text());
      expect(now === text, `${key}: the text is ${JSON.stringify(now)}`);
      expect(after === before, `${key}: the selection moved from ${before} to ${after}`);
    }
  });

  const readOnly = await openLab('?sample=editing.md&mode=view&readonly');
  await check('on a read-only document the formatting buttons are not shown and Rich editor is off', async () => {
    const visible = await visibleButtons(readOnly, '.tm-toolbar');
    expect(
      JSON.stringify(visible) === '["Source","Rich view","Rich editor","Find"]',
      `visible: ${JSON.stringify(visible)}`,
    );
    expect(
      await readOnly.locator('.tm-tb-views button[aria-label="Rich editor"]').isDisabled(),
      'Rich editor can be chosen',
    );
  });

  // The panel's own record of them too.
  await noPolicyViolation(reports, () =>
    page.evaluate(async () => (await window.__harness.host.runInPanel([{ type: 'state' }])).result.cspViolations ?? []),
  );

  await noPageError(reports);
} finally {
  await browser.close();
  await server.close();
}

report();
