// The stat and the bytes of a document's file, for the reconciler, through Node's file system
// (docs/ARCHITECTURE.md, "Reading the file"). `workspace.fs` would first make a round trip to the
// window on every call, as VS Code 1.146 does, and around a save the window is busy saving. A stat
// queries attributes only; a read opens the file shared for reading, writing and deleting, so
// neither can refuse another program's write.
//
// Reads run one at a time in a worker thread, each opened, read and closed in one go. A read with
// no answer after READ_ANSWER_MS is abandoned: it fails (the check is tried again), the worker is
// stopped, and the reads queued behind it go to a new one. A guard against a hang (a network share
// that dropped), not a clock that decides what is written.

import { readFile, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { errorMessage } from '../../core/errors';
import type { DiskRead, FileStat } from '../../core/reconcile/types';

/** The file's modification time and size, or null when there is no file (or it cannot be seen). */
export async function statFile(path: string): Promise<FileStat | null> {
  try {
    const s = await stat(path);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** The file's bytes, read in the worker thread (or on the event loop when no worker can start). */
export async function readFileBytes(path: string): Promise<DiskRead> {
  const reader = startReader();
  if (reader === null) {
    try {
      const b = await readFile(path);
      return { ok: true, bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
    } catch (error) {
      return { ok: false, error: readError((error as { code?: unknown } | null)?.code), detail: errorMessage(error) };
    }
  }
  return reader.read(path);
}

/** How long a read may go unanswered before it is abandoned and its worker replaced. */
const READ_ANSWER_MS = 20_000;

/** Where a warning goes that reads run on the event loop because the thread could not start (the host's log). */
let warn: (message: string, detail: unknown) => void = () => {};

export function onFileReadsWarning(fn: (message: string, detail: unknown) => void): void {
  warn = fn;
}

/** Stops the worker thread (the extension is going). */
export function stopFileReads(): void {
  const r = current;
  current = null;
  r?.stop();
}

// The worker: one read at a time, each opened, read and closed back to back.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
parentPort.on('message', ({ id, path }) => {
  try {
    parentPort.postMessage({ id, ok: true, bytes: readFileSync(path) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, code: error && error.code, detail: String((error && error.message) || error) });
  }
});
`;

interface Reply {
  id: number;
  ok: boolean;
  bytes?: Uint8Array;
  code?: unknown;
  detail?: string;
}

class Reader {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, { path: string; done: (r: DiskRead) => void }>();
  private nextId = 0;
  /** The timer for the read the worker is on (the oldest waiting); reads answer in order. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  dead = false;

  constructor() {
    this.worker = new Worker(WORKER_SOURCE, { eval: true });
    this.worker.unref();
    this.worker.on('message', (m: Reply) => {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      this.watch();
      if (!w) return;
      if (m.ok && m.bytes)
        w.done({ ok: true, bytes: new Uint8Array(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength) });
      else w.done({ ok: false, error: readError(m.code), detail: m.detail ?? 'the read failed' });
    });
    const fail = (detail: string) => {
      this.dead = true;
      this.unwatch();
      for (const w of this.waiting.values()) w.done({ ok: false, error: 'failed', detail });
      this.waiting.clear();
    };
    this.worker.on('error', (error) => fail(errorMessage(error)));
    this.worker.on('exit', () => fail('the reading thread stopped'));
  }

  read(path: string): Promise<DiskRead> {
    const id = ++this.nextId;
    return new Promise<DiskRead>((resolve) => {
      this.waiting.set(id, { path, done: resolve });
      this.worker.postMessage({ id, path });
      if (this.timer === null) this.watch();
    });
  }

  stop(): void {
    this.unwatch();
    void this.worker.terminate();
  }

  /** Times the read the worker is on now: the oldest waiting. */
  private watch(): void {
    this.unwatch();
    if (this.waiting.size === 0) return;
    this.timer = setTimeout(() => this.abandon(), READ_ANSWER_MS);
    this.timer.unref?.();
  }

  private unwatch(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The read the worker is on has not answered: it fails, this worker stops, and the reads
   * queued behind it are read again by a new worker.
   */
  private abandon(): void {
    this.timer = null;
    const [first, ...rest] = [...this.waiting.values()];
    this.waiting.clear();
    this.dead = true;
    void this.worker.terminate();
    if (!first) return;
    warn(
      `A read of ${first.path} did not answer in ${READ_ANSWER_MS} ms; it was abandoned and the reading thread restarted`,
      null,
    );
    first.done({ ok: false, error: 'failed', detail: 'the read did not answer' });
    for (const w of rest) void readFileBytes(w.path).then(w.done);
  }
}

let current: Reader | null = null;
let cannotStart = false;

/** The worker, started on first use and again after it stopped; null when one cannot start. */
function startReader(): Reader | null {
  if (current && !current.dead) return current;
  if (cannotStart) return null;
  try {
    current = new Reader();
  } catch (error) {
    cannotStart = true;
    current = null;
    warn('The thread that reads files could not start; reads run on the event loop', error);
  }
  return current;
}

function readError(code: unknown): 'missing' | 'busy' | 'failed' {
  if (code === 'ENOENT') return 'missing';
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'busy';
  return 'failed';
}
