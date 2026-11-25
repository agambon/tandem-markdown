// The checks run once before a release, on this machine, one after another: the unit tests, the
// long simulation sweep and the long merge oracle run, every browser spec, the package and its
// list of files, and the in-VS-Code suite on each version named. .github/workflows/release.yml
// runs the same set on Linux, Windows and macOS; this is the way to run it where CI is not.
//
//   node scripts/release-checks.mjs [--out <folder>] [--vscode 1.120.0,stable] [--no-vscode]
//
// Each step's output goes to <folder>/<step>.log (by default a folder in the system's temporary
// folder, named in the first line printed), and a line per step says whether it passed. The
// in-VS-Code suite opens a real window: leave the machine alone while it runs.

import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checksFor } from './areas.mjs';

const root = path.join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = path.resolve(option('--out', path.join(os.tmpdir(), 'tandem-markdown-release-checks')));
const versions = args.includes('--no-vscode') ? [] : option('--vscode', '1.120.0,stable').split(',');
mkdirSync(out, { recursive: true });
console.log(`Logs in ${out}`);

/** A first seed no earlier sweep from this machine is likely to have used, printed with the result. */
const firstSeed = (Date.now() % 1_000_000_000) + 1;

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  { name: 'unit-tests', command: [npm, 'test'] },
  {
    name: 'simulation-20000',
    command: [npx, 'vitest', 'run', 'test/sync/simulation.test.ts'],
    env: { SIM_FIRST: String(firstSeed), SIM_RUNS: '20000' },
  },
  {
    name: 'merge-oracle-200000',
    command: [npx, 'vitest', 'run', 'test/core/merge3.test.ts'],
    env: { TEST_SEED: 'random', MERGE3_ORACLE_RUNS: '200000' },
  },
  // Every spec: a change to package.json is one every spec covers.
  ...checksFor(['package.json']).specs.map((spec) => ({
    name: `spec-${spec}`,
    command: [process.execPath, path.join('harness', 'tests', `${spec}.spec.mjs`)],
  })),
  { name: 'package', command: [npm, 'run', 'package'] },
  { name: 'package-files', command: [npx, 'vsce', 'ls', '--no-dependencies'] },
  ...versions.map((version) => ({
    name: `vscode-${version}`,
    command: [npm, 'run', 'itest'],
    env: { VSCODE_TEST_VERSION: version, TM_ITEST_DIR: path.join(out, `itest-${version}`) },
  })),
];

const summary = [];
for (const step of steps) {
  const log = path.join(out, `${step.name}.log`);
  const fd = openSync(log, 'w');
  const started = Date.now();
  const [command, ...rest] = step.command;
  const result = spawnSync(command, rest, {
    cwd: root,
    env: { ...process.env, ...step.env },
    stdio: ['ignore', fd, fd],
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  closeSync(fd);
  const seconds = Math.round((Date.now() - started) / 1000);
  const line = `${result.status === 0 ? 'PASS' : 'FAIL'}  ${step.name} (${seconds} s)${
    step.env?.SIM_FIRST ? `, seeds ${step.env.SIM_FIRST} on` : ''
  }`;
  console.log(line);
  summary.push(line);
}
writeFileSync(path.join(out, 'summary.txt'), `${summary.join('\n')}\n`);
process.exit(summary.every((line) => line.startsWith('PASS')) ? 0 : 1);
