// The checks of a browser spec: each runs to its end or throws, and its result is printed as it
// finishes; `report` prints how many passed and ends the process, with 1 when any failed.
// After them, the watch every spec keeps for what the panel must never cause, and the checks
// that read it: a content-policy report, an uncaught page error, a dialog, a request that leaves
// the page. How a spec opens its pages and works in them is in harness/pages.mjs.

/**
 * The message of a thrown value: an Error's message, or the value itself as a string. A copy of
 * `errorMessage` in src/core/errors.ts, since the specs and scripts run in Node with no build step.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Thrown by a check that cannot run where it is: the check is skipped, not failed. */
export class Skip extends Error {}

const results = [];

export async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push('pass');
    console.log(`PASS  ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    const outcome = error instanceof Skip ? 'skip' : 'fail';
    results.push(outcome);
    console.log(`${outcome.toUpperCase()}  ${name} (${Date.now() - started} ms)\n      ${errorMessage(error)}`);
  }
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Prints how many checks passed, and ends the process. */
export function report() {
  const count = (outcome) => results.filter((r) => r === outcome).length;
  const skipped = count('skip');
  console.log(`${count('pass')} of ${results.length} passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(count('fail') ? 1 : 0);
}

// ---------------------------------------------------------------------------
// What the panel must never cause

/** What `read`, run in every frame of `page`, gives; a frame that went away while they were read gives nothing. */
async function inEveryFrame(page, read) {
  const found = [];
  for (const frame of page.frames()) found.push(...(await frame.evaluate(read).catch(() => [])));
  return found;
}

/** A spec's record of the content-policy reports and uncaught errors in its pages. */
export class PageReports {
  /** Chrome's console messages about the policy. */
  policy = [];
  /** Uncaught errors, by message. */
  errors = [];
  /** The pages it watches, in the order they opened, each with what reads the reports it keeps besides. */
  #watched = [];

  /**
   * Records `page`'s reports from before it loads: the `securitypolicyviolation` events of the
   * page and of every frame in it, each in its own `window.__violations`. `kept`, run in the
   * page, gives the reports it keeps besides (the render lab: those the panel logged from a
   * diagram's frame).
   */
  async watch(page, { kept } = {}) {
    await page.addInitScript(() => {
      window.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        window.__violations.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || '(inline)'}`),
      );
    });
    this.#watched.push({ page, kept });
    page.on('console', (message) => {
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) this.policy.push(text);
    });
    page.on('pageerror', (error) => this.errors.push(error.message));
  }

  /** The pages it watches, in the order they opened. */
  get pages() {
    return this.#watched.map(({ page }) => page);
  }

  /** The policy reports the pages it watches keep, in every frame; a page closed already took its own with it. */
  async kept() {
    const found = [];
    for (const { page, kept } of this.#watched) {
      if (page.isClosed()) continue;
      found.push(...(await inEveryFrame(page, () => window.__violations ?? [])));
      if (kept) found.push(...(await page.evaluate(kept)));
    }
    return found;
  }
}

/**
 * The check that no page or frame reported a policy violation: what they kept (`PageReports.kept`),
 * what `more()` gives besides (the panel's own record), and Chrome's console.
 */
export async function noPolicyViolation(reports, more = async () => []) {
  await check('no content-policy violation is logged, in a page or a frame', async () => {
    const found = [...(await reports.kept()), ...(await more()), ...reports.policy];
    expect(found.length === 0, found.slice(0, 5).join('; '));
  });
}

/** The check that no page threw: every error `counts` keeps. */
export async function noPageError(reports, counts = () => true) {
  await check('no uncaught page error', async () => {
    const found = reports.errors.filter(counts);
    expect(found.length === 0, found.slice(0, 5).join('; '));
  });
}

/**
 * In `page` and every frame in it: a call to a dialog is recorded in `window.__fired` and opens
 * nothing. A dialog Chrome shows all the same is dismissed, and recorded in the list this gives.
 */
export async function dialogCanary(page) {
  const shown = [];
  page.on('dialog', async (dialog) => {
    shown.push(`dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });
  await page.addInitScript(() => {
    window.__fired = [];
    for (const name of ['alert', 'confirm', 'prompt', 'print']) {
      window[name] = (...args) => window.__fired.push(`${name}(${args.join(', ')})`);
    }
  });
  return shown;
}

/** The check that no script ran in `page` or a frame in it: none called a dialog, and Chrome showed none (`shown`). */
export async function noScriptRan(page, shown) {
  await check('no script ran, in the page or in a frame', async () => {
    const fired = [...(await inEveryFrame(page, () => window.__fired ?? [])), ...shown];
    expect(fired.length === 0, fired.slice(0, 5).join('; '));
  });
}

/** The check that nothing in `outside` (`requestsOutside`) left the page. */
export async function noRequestOutside(outside) {
  await check('nothing was requested from outside', async () => {
    expect(
      outside.length === 0,
      outside
        .slice(0, 5)
        .map((r) => r.url())
        .join(', '),
    );
  });
}

/**
 * The requests `page` makes to anywhere but `server` (a `data:` address and a frame's own
 * document aside), kept up to date. A request the policy refuses is reported and then failed with
 * `csp`; it never left the browser, so it is taken off again. A refused request to `server` was
 * never on the list.
 */
export function requestsOutside(page, server) {
  const outside = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(server.url) && !url.startsWith('data:') && url !== 'about:srcdoc') outside.push(request);
  });
  page.on('requestfailed', (request) => {
    const at = outside.indexOf(request);
    if (at >= 0 && request.failure()?.errorText === 'csp') outside.splice(at, 1);
  });
  return outside;
}
