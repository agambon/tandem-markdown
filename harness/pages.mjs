// How a browser spec opens the harness's two pages, the render lab (lab.html) and the harness
// page (index.html), and works in them: the waits in the page, the openers, a scroll and typing.

// ---------------------------------------------------------------------------
// Waits in the page

/** How long a wait in the page lasts before it fails. */
const WAIT_MS = 8000;

/** Waits until `fn`, run in the page with `arg`, is true; on time-out, throws `what` (or `what()`'s answer). */
export async function waitFor(page, fn, arg, what, timeout = WAIT_MS) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch {
    throw new Error(typeof what === 'function' ? await what() : what);
  }
}

/** Waits `count` animation frames in the page. */
export function frames(page, count = 2) {
  return page.evaluate(
    (left) =>
      new Promise((resolve) => {
        const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : resolve());
        step(left);
      }),
    count,
  );
}

/**
 * Waits, a frame of the page at a time, until `holds()` is true; after WAIT_MS throws `what`, or
 * what `what()` answers. For a condition the spec reads through helpers of its own.
 */
export async function waitUntil(page, holds, what, timeout = WAIT_MS) {
  const end = Date.now() + timeout;
  while (!(await holds())) {
    if (Date.now() > end) throw new Error(typeof what === 'function' ? await what() : what);
    await frames(page, 1);
  }
}

/**
 * A fixed wait: two frames, `ms` milliseconds, two frames. For a promise that nothing happens in
 * that time, and for what the page gives no sign of: a library a drawing loads on demand, and the
 * drawing again that follows it.
 */
export function settle(page, ms = 150) {
  return page.evaluate(async (wait) => {
    const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await twoFrames();
    await new Promise((resolve) => setTimeout(resolve, wait));
    await twoFrames();
  }, ms);
}

/** How long a drawn block may stay busy: a diagram's frame loads Mermaid before its first drawing. */
const DRAWING_MS = 30_000;

/** Waits until tracked on-demand modules and all drawn blocks in view (`aria-busy`) finish drawing. */
export async function drawingsDone(page) {
  await page.evaluate(() => window.__lab?.whenLoaded?.());
  await page.waitForFunction(() => !document.querySelector('.cm-content [aria-busy="true"]'), null, {
    timeout: DRAWING_MS,
  });
  await page.evaluate(() => window.__lab?.whenLoaded?.());
  await frames(page, 2);
}

/** On the harness page: waits until the document holds `want` and the panel agrees with it. */
export async function documentBecomes(page, want) {
  await waitFor(
    page,
    (w) => window.__harness.documentText() === w && window.__harness.agree(),
    want,
    async () =>
      `the document is ${JSON.stringify(await page.evaluate(() => window.__harness.documentText()))}, not ${JSON.stringify(want)}`,
  );
}

// ---------------------------------------------------------------------------
// Opening the pages

/** The size of a page a spec opens, unless the harness page's opener is given another `viewport`. */
const VIEWPORT = { width: 1280, height: 900 };

/** In the render lab: the policy reports the panel logged, as it does for a diagram's frame. */
const loggedViolations = () =>
  window.__lab.posted.filter((m) => m.type === 'log' && /policy violation/.test(m.message)).map((m) => m.message);

/**
 * How a spec opens its pages in `browser`, served by `server` and watched by `reports` from before
 * each one loads. Each opener's `before(page)` runs first, for what must be in place before the
 * page's own code: an init script, a recorder, a stopped clock, a route.
 */
export function pageOpener(browser, server, reports) {
  const open = async (path, query, watch, before, viewport = VIEWPORT) => {
    const page = await browser.newPage({ viewport });
    if (before) await before(page);
    await reports.watch(page, watch);
    await page.goto(`${server.url}harness/${path}${query}`);
    return page;
  };
  return {
    /**
     * The render lab (`lab.html` with `query`), once it is ready and has drawn its first lines:
     * CodeMirror draws a first guess of the viewport, then measures and draws the rest.
     */
    async lab(query = '', { before } = {}) {
      const page = await open('lab.html', query, { kept: loggedViolations }, before);
      await page.waitForFunction(() => window.__lab !== undefined);
      await page.evaluate(() => window.__lab.ready);
      await page.waitForSelector('.cm-content .cm-line');
      await frames(page);
      return page;
    },
    /** The harness page (`index.html` with `query`), once it is ready. */
    async harness(query = '', { before, viewport } = {}) {
      const page = await open('index.html', query, {}, before, viewport);
      await page.waitForFunction(() => window.__harness !== undefined);
      await page.evaluate(() => window.__harness.ready);
      return page;
    },
  };
}

// ---------------------------------------------------------------------------
// Working in the pages

/** Scrolls the page's editor (the lab's or the harness page's) so the line holding `text` is drawn. */
export async function scrollTo(page, text) {
  await page.evaluate(async (needle) => {
    const view = (window.__lab ?? window.__harness).view;
    const pos = view.state.doc.toString().indexOf(needle);
    if (pos < 0) throw new Error(`"${needle}" is not in the document`);
    view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(pos).top - 100);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, text);
}

/** Puts the cursor at `at` in the page's editor (the lab's or the harness page's), with the editor focused. */
export async function placeCursor(page, at) {
  await page.evaluate((pos) => {
    const view = (window.__lab ?? window.__harness).view;
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
  }, at);
  await waitFor(
    page,
    (pos) => (window.__lab ?? window.__harness).view.state.selection.main.head === pos,
    at,
    `the cursor did not reach ${at}`,
  );
  await frames(page, 2);
}

/**
 * CodeMirror's suggestion list ignores Enter for its interactionDelay (75 ms) after the list
 * changes, and nothing on the page says when that has passed; this is that delay with room. An
 * Enter pressed sooner types a line break, as it would for the user pressing it that fast.
 */
const SUGGESTION_DELAY_MS = 200;

/** Waits until Enter in the suggestion list the page shows chooses the selected suggestion. */
export function waitOutSuggestionDelay(page) {
  return page.waitForTimeout(SUGGESTION_DELAY_MS);
}

/** On the harness page, types `text` at the end of the document in Source and waits until the panel's text ends with it. */
export async function typeAtEndInSource(page, text) {
  await page.locator('#hx-document').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await waitFor(
    page,
    (typed) => (window.__harness.panelText() ?? '').endsWith(typed),
    text,
    'the typing did not reach the panel',
  );
}
