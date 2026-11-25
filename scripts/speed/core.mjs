// The document core's work for a 2 MB note (scripts/speed/note.mjs), in Node, with the
// simulation's stand-ins for VS Code's document, the disk and a panel (test/sync/world.ts):
//   - checking one typed character pushed by a panel (`preparePush`), 3,000 times;
//   - one typed character's round trip, from the panel's push to the panel holding the
//     confirmed text, 100 times;
//   - one line written by another program, merged into the unsaved document, 7 times.
// The fake clock makes the core's waits free, so the times are work. Each is given as time on
// the clock and as CPU time, which a busy machine inflates less.
//
//   node scripts/speed/core.mjs

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { median } from './measure.mjs';
import { note } from './note.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const out = path.join(os.tmpdir(), 'tandem-markdown-speed');
await mkdir(out, { recursive: true });
const bundle = path.join(out, 'core-bundle.mjs');
await esbuild.build({
  stdin: {
    contents: `
export { ChangeSet, Text } from '@codemirror/state';
export { stampOf } from './src/core/hash';
export { SyncSession } from './src/core/session';
export { SyncWorld } from './test/sync/world';
`,
    resolveDir: repo,
    loader: 'ts',
    sourcefile: 'speed-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});
const { ChangeSet, SyncSession, SyncWorld, Text, stampOf } = await import(pathToFileURL(bundle).href);

const text = note(2_000_000, 7);

/** Runs `work` (which may be async) and gives its time on the clock and its CPU time, in ms. */
async function timed(work) {
  const cpu = process.cpuUsage();
  const started = performance.now();
  await work();
  const used = process.cpuUsage(cpu);
  return { clock: performance.now() - started, cpu: (used.user + used.system) / 1000 };
}

/**
 * The median time on the clock, and the mean CPU time: Windows counts CPU time in steps of
 * about 15.6 ms, which a mean of many samples evens out and a median does not.
 */
function report(what, samples, digits, per = 1) {
  const clock = median(samples.map((s) => s.clock)) / per;
  const cpu = samples.reduce((sum, s) => sum + s.cpu, 0) / samples.length / per;
  console.log(`2 MB, ${what}: median ${clock.toFixed(digits)} ms, CPU ${cpu.toFixed(digits)} ms`);
}

/** A world with one panel on the note, clean, every message delivered. */
async function world() {
  const w = new SyncWorld({
    panels: 1,
    eol: '\n',
    text,
    autoSave: false,
    vsReloadDelayMs: null,
    watcherDelayMs: 0,
  });
  await w.settle();
  return w;
}

// Checking a push of one character.
{
  const session = new SyncSession(text);
  const middle = Math.floor(text.length / 2);
  const changes = ChangeSet.of([{ from: middle, insert: 'x' }], text.length);
  const expect = stampOf(changes.apply(Text.of(text.split('\n'))));
  // Thirty samples of a hundred checks each: one check is far shorter than a step of the CPU clock.
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push(
      await timed(() => {
        for (let k = 0; k < 100; k++) {
          const push = session.preparePush('panel', 0, [changes.toJSON()], expect);
          if (!push.ok) throw new Error(`the push was refused: ${push.detail}`);
        }
      }),
    );
  }
  report('checking one typed character', samples, 3, 100);
}

// A typed character's round trip.
{
  const w = await world();
  const panel = w.panels[0];
  // The first edit makes the document dirty, which reads the disk once; it is not counted.
  panel.type(Math.floor(panel.text.length / 2), 'z');
  void panel.sync.flush();
  await w.settle();
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const at = Math.floor((((i * 7919) % 1000) / 1000) * (panel.text.length - 1));
    samples.push(
      await timed(async () => {
        panel.type(at, 'x');
        void panel.sync.flush();
        await w.settle();
      }),
    );
  }
  if (panel.text !== w.doc.lf) throw new Error('the panel and the document differ');
  report('one typed character from the panel to confirmed', samples, 1);
}

// An outside line merged into the unsaved document.
{
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const w = await world();
    const panel = w.panels[0];
    panel.type(10, 'typed ');
    await w.settle();
    const current = w.disk.textLenient();
    const at = current.indexOf('\n', Math.floor(current.length / 2));
    samples.push(
      await timed(async () => {
        w.writeOutside(`${current.slice(0, at)}\nan outside line${current.slice(at)}`);
        await w.settle();
      }),
    );
    if (!panel.text.includes('an outside line') || !panel.text.includes('typed ')) throw new Error('not merged');
  }
  report('one outside line merged into unsaved typing', samples, 0);
}
