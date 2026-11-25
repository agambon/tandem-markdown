// The suite's entry inside the test copy of VS Code: runs every `*.test.js` beside it, in name
// order, with mocha's TDD interface (`suite`, `test`, `setup`, `teardown`), or only the files
// whose names contain a word given to `npm run itest -- <word>`. The first test waits until
// VS Code's file watcher reports changes in the workspace (watcherReady.ts).

import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';
import { WATCHER_READY_MS, watcherReady } from './watcherReady';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: false,
    timeout: 60_000,
    slow: 10_000,
    rootHooks: {
      async beforeAll(this: Mocha.Context) {
        this.timeout(WATCHER_READY_MS + 10_000);
        await watcherReady();
      },
    },
  });
  const only = (process.env.TM_ITEST_ONLY ?? '').split(',').filter(Boolean);
  const files = readdirSync(__dirname)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => only.length === 0 || only.some((word) => name.includes(word)))
    .sort();
  if (files.length === 0) return Promise.reject(new Error(`No test files match ${only.join(', ') || 'anything'}`));
  for (const name of files) mocha.addFile(path.join(__dirname, name));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} test${failures === 1 ? '' : 's'} failed`)) : resolve(),
    );
  });
}
