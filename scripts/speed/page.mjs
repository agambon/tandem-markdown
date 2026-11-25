// The harness page as typing.mjs, enter.mjs and definitions.mjs open it, and the instrument they
// time keys with.

/**
 * A new harness page in the Rich editor, ready, with its page errors collected in `errors`. The
 * harness's own document and disk boxes are kept empty: at these sizes they cost more than the
 * panel.
 */
export async function harnessPage(browser, server) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}harness/index.html?mode=edit`);
  await page.waitForFunction(() => window.__harness !== undefined);
  await page.evaluate(() => window.__harness.ready);
  await page.evaluate(() => {
    for (const id of ['hx-document', 'hx-disk'])
      Object.defineProperty(document.getElementById(id), 'value', {
        get: () => '',
        set: () => {},
        configurable: true,
      });
  });
  return { page, errors };
}

/**
 * Times each key from its keydown to the frame after it (`window.__keyToFrame`), and the panel's
 * own work: each transaction dispatched, applied and drawn into the DOM (`window.__update`). With
 * `keyOnly`, only the transactions dispatched while the key is handled count; CodeMirror's
 * background parse dispatches too, but not then.
 */
export function timeKeys(page, { keyOnly = false } = {}) {
  return page.evaluate((keyOnly) => {
    const view = window.__harness.view;
    window.__keyToFrame = [];
    window.__update = [];
    let inKey = false;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (...args) => {
      const started = performance.now();
      try {
        return dispatch(...args);
      } finally {
        if (!keyOnly || inKey) window.__update.push(performance.now() - started);
      }
    };
    view.contentDOM.addEventListener(
      'keydown',
      (event) => {
        const start = event.timeStamp;
        if (keyOnly) {
          inKey = true;
          setTimeout(() => (inKey = false), 0);
        }
        requestAnimationFrame(() => setTimeout(() => window.__keyToFrame.push(performance.now() - start), 0));
      },
      true,
    );
  }, keyOnly);
}
