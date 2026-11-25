// A rich view scrolled through a 1 MB note (scripts/speed/note.mjs) three ways: alone; linked, its
// reports going no further than the page, which is the panel's own cost; and with a second rich
// view following it. In the installed Chrome, headless. Each view is the harness page (the real
// panel with every default syntax on, the harness's own document and disk boxes kept empty as in
// typing.mjs), in a browser context of its own: its own renderer process, shown beside the other as
// webviews are in VS Code. This script stands in for the host. For each run: the time between the
// leader's frames (median, 95th percentile, longest, and how many took over LATE_MS), the time the
// listeners on its scroller take per scroll event (the beacon's sending among them), how many
// places it reported, and how many frames the follower took to show the last place once it had it.
//
//   node scripts/speed/follow.mjs [--frames 300] [--step 40]

import { chromium } from 'playwright-core';
import { serveOwnBuild } from '../../harness/serve.mjs';
import { numberOption, quantile } from './measure.mjs';
import { note } from './note.mjs';

const FRAMES = numberOption('--frames', 300);
const STEP_PX = numberOption('--step', 40);
/** A frame at 60 Hz, and the interval past which a frame counts as late. */
const FRAME_MS = 1000 / 60;
const LATE_MS = 1.5 * FRAME_MS;
/** Frames the follower is watched for after the last place reaches it. */
const GIVE_UP_FRAMES = 120;

const server = await serveOwnBuild('follow');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const text = note(1_000_000, 11);

async function openView(name) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}harness/index.html?mode=view`);
  await page.waitForFunction(() => window.__harness !== undefined);
  await page.evaluate(() => window.__harness.ready);
  await page.evaluate(
    async ({ t, n }) => {
      for (const id of ['hx-document', 'hx-disk'])
        Object.defineProperty(document.getElementById(id), 'value', {
          get: () => '',
          set: () => {},
          configurable: true,
        });
      await window.__harness.open(t, n);
    },
    { t: text, n: `${name}.md` },
  );
  return { page, context, errors };
}

/** The place at the view's top and how far, in pixels, it is from `line` (run in a page). */
function placeIn(line) {
  const v = window.__harness.view;
  const h = v.scrollDOM.scrollTop - v.documentPadding.top;
  const b = v.lineBlockAtHeight(Math.max(0, h));
  const first = v.state.doc.lineAt(b.from).number - 1;
  const lines = v.state.doc.lineAt(b.to).number - first;
  const at = first + (b.height > 0 ? (Math.min(b.height, Math.max(0, h - b.top)) / b.height) * lines : 0);
  return { at, apart: Math.abs(at - line) * (b.height / lines) };
}

/**
 * `alone`: the view is not linked. `linked`: it is, and its reports go no further than the page,
 * which is the panel's own cost. `follower`: they reach a second view, which follows.
 */
async function run(mode) {
  const leader = await openView('leader');
  const follower = mode === 'follower' ? await openView('follower') : null;
  // Let the first drawing, the background parse and the libraries loaded on demand finish.
  await leader.page.waitForTimeout(3000);
  if (follower) {
    await follower.page.evaluate(() => {
      window.__received = 0;
      let newest = 0;
      const host = window.__harness.host;
      window.__place = (n, line) => {
        window.__received++;
        // Beacons can overtake each other on their way: an older place is passed over.
        if (n <= newest) return;
        newest = n;
        // Past the fake host's queue, whose bookkeeping for each message would cost this page too.
        for (const c of host.connections.values()) if (!c.closed) host.deliverToPanel(c.id, { type: 'scrollTo', line });
      };
      window.__harness.host.post({ type: 'scrollLink', linked: true });
    });
    await leader.page.route('**/follow-place', (route) => {
      const [n, line] = (route.request().postData() ?? '').split(' ').map(Number);
      void follower.page.evaluate(([a, b]) => window.__place(a, b), [n, line]);
      void route.fulfill({ status: 204 });
    });
  }
  // The leader's `scrolled` reports are taken before the fake host queues them: its bookkeeping for
  // each message, which a webview's message to VS Code does not have, costs the page about one
  // frame in four at this size. With a follower, each goes out as a beacon, which the route above
  // hands to the follower's panel as `scrollTo`, past the fake host there too.
  if (mode !== 'alone') {
    await leader.page.evaluate((send) => {
      const host = window.__harness.host;
      const queue = host.toHost;
      const queued = queue.push.bind(queue);
      const kick = host.kick.bind(host);
      window.__reported = 0;
      let taken = false;
      queue.push = (item) => {
        if (item.value.message.type !== 'scrolled') return queued(item);
        taken = true;
        window.__reported++;
        if (send) navigator.sendBeacon('/follow-place', `${window.__reported} ${item.value.message.line}`);
        return queue.length;
      };
      host.kick = () => {
        if (taken) taken = false;
        else kick();
      };
      host.post({ type: 'scrollLink', linked: true });
    }, mode === 'follower');
  }
  const result = await leader.page.evaluate(
    ({ frames, step }) =>
      new Promise((resolve) => {
        const scroller = window.__harness.view.scrollDOM;
        const listened = [];
        // First and last on the scroller, so the time between is what the listeners take: the
        // editor's, the view state's and the follow's.
        const started = { at: 0 };
        scroller.addEventListener('scroll', () => (started.at = performance.now()), { capture: true, passive: true });
        scroller.addEventListener('scroll', () => listened.push(performance.now() - started.at), { passive: true });
        // The user's wheel, so what follows is the user's scroll.
        scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: step }));
        const stamps = [];
        let left = frames;
        const frame = (t) => {
          stamps.push(t);
          if (left-- <= 0) {
            const gaps = stamps.slice(1).map((s, i) => s - stamps[i]);
            resolve({ gaps, listened });
            return;
          }
          scroller.scrollTop += step;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    { frames: FRAMES, step: STEP_PX },
  );
  let caughtUp = null;
  const reports = mode === 'alone' ? 0 : await leader.page.evaluate(() => window.__reported);
  if (follower) {
    await follower.page.waitForFunction((n) => window.__received >= n, reports);
    const leaderTop = (await leader.page.evaluate(placeIn, 0)).at;
    caughtUp = await follower.page.evaluate(
      ({ line, giveUp, place }) =>
        new Promise((resolve) => {
          const placeAt = new Function(`return (${place})`)();
          let frames = 0;
          const look = () => {
            const { apart } = placeAt(line);
            if (apart < 1 || frames >= giveUp) resolve({ frames, apart });
            else {
              frames++;
              requestAnimationFrame(look);
            }
          };
          look();
        }),
      { line: leaderTop, giveUp: GIVE_UP_FRAMES, place: placeIn.toString() },
    );
  }
  const gaps = result.gaps.sort((x, y) => x - y);
  const listened = result.listened.sort((x, y) => x - y);
  const errors = [...leader.errors, ...(follower?.errors ?? [])];
  console.log(
    `${{ alone: 'alone          ', linked: 'linked         ', follower: 'with a follower' }[mode]}: frames ` +
      `median ${quantile(gaps, 0.5).toFixed(1)} ms, 95th percentile ${quantile(gaps, 0.95).toFixed(1)} ms, ` +
      `longest ${gaps[gaps.length - 1].toFixed(1)} ms, ${gaps.filter((g) => g > LATE_MS).length} of ${gaps.length} ` +
      `over ${LATE_MS.toFixed(0)} ms; scroll listeners median ${quantile(listened, 0.5).toFixed(3)} ms, most ` +
      `${listened[listened.length - 1].toFixed(3)} ms over ${listened.length} scroll events` +
      (mode === 'alone' ? '' : `; ${reports} places reported`) +
      (caughtUp
        ? `; the follower showed the last ${caughtUp.frames} frames after it arrived` +
          (caughtUp.apart < 1 ? '' : ` (still ${caughtUp.apart.toFixed(1)} px away)`)
        : '') +
      (errors.length ? `; page errors: ${errors.join('; ')}` : ''),
  );
  await leader.context.close();
  await follower?.context.close();
}

try {
  console.log(
    `${(text.length / 1000).toFixed(0)} KB, ${text.split('\n').length} lines, ${STEP_PX} px a frame for ${FRAMES} frames`,
  );
  // In turns, so a busier moment of the machine falls on all three ways alike.
  for (let round = 0; round < 3; round++) {
    await run('alone');
    await run('linked');
    await run('follower');
  }
} finally {
  await browser.close();
  await server.close();
}
