// The lines the test hook reads back from the log (linesAfter, from a loggedCount mark): every line
// logged after the mark, while the log still keeps it, also once the log has dropped its oldest
// lines past KEPT_LINES_MAX.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLog, KEPT_LINES_MAX, linesAfter, log, loggedCount } from '../../src/host/log';

vi.mock('vscode', async () => {
  const { Disposable } = await import('./vscodeStandIn');
  const ignored = () => undefined;
  const channel = { trace: ignored, info: ignored, warn: ignored, error: ignored, dispose: ignored };
  return { Disposable, window: { createOutputChannel: () => channel } };
});

let opened: { dispose(): void } | null = null;
afterEach(() => opened?.dispose());

/** Logs `count` trace lines named `name 0`, `name 1` and so on. */
function logLines(name: string, count: number): void {
  for (let i = 0; i < count; i++) log('trace', `${name} ${i}`);
}

const named = (name: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => `${name} ${from + i}`);

describe('the log read back from a mark', () => {
  it('holds exactly the lines logged after the mark', () => {
    opened = createLog(true);
    logLines('before', 10);
    const mark = loggedCount();
    logLines('after', 3);
    expect(linesAfter(mark).map((l) => l.message)).toEqual(named('after', 3));
  });

  it('holds every line after a mark taken just before the log is full', () => {
    opened = createLog(true);
    logLines('before', KEPT_LINES_MAX - 3);
    const mark = loggedCount();
    logLines('after', 10);
    expect(linesAfter(mark).map((l) => l.message)).toEqual(named('after', 10));
  });

  it('holds the lines after a mark taken once the log has dropped its oldest lines', () => {
    opened = createLog(true);
    logLines('before', KEPT_LINES_MAX + 10);
    const mark = loggedCount();
    logLines('after', 5);
    expect(linesAfter(mark).map((l) => l.message)).toEqual(named('after', 5));
  });

  it('holds the newest lines the log keeps when the mark is older than all of them', () => {
    opened = createLog(true);
    const mark = loggedCount();
    logLines('after', KEPT_LINES_MAX + 50);
    expect(linesAfter(mark).map((l) => l.message)).toEqual(named('after', KEPT_LINES_MAX, 50));
  });
});
