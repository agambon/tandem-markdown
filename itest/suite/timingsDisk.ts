// A thread that watches one file for the facts file on VS Code's timings and writes to it as
// another program would, off the extension host's own thread, so that a busy host delays neither
// its looks nor its writes. While it watches it stats the file again and again, at most every
// STAT_GAP_MS, keeping each state that differs from the one before (size and modification time),
// and makes each write asked of it once the clock (timingsClock.ts) reaches the write's time.
// Between windows it sleeps.

import type * as fs from 'node:fs';
import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import type * as threads from 'node:worker_threads';
import { FILE_BUSY } from './helpers';
import { CLOCK_ORIGIN } from './timingsClock';

/**
 * The file as one stat saw it: null size and time when there was no file or the stat failed
 * (`error`). `at` is when that stat returned and `since` when the stat before it began (null for a
 * window's first), so the file came to this state between the two. The thread makes no stat while
 * it writes, so a state its own write made is placed after that write.
 */
interface FileState {
  at: number;
  since: number | null;
  size: number | null;
  mtime: number | null;
  error: string | null;
}

/** One write the thread made: when it began and ended, how many tries it took, and why the last failed, if it did. */
interface DiskWrite {
  at: number;
  end: number;
  label: string;
  tries: number;
  error: string | null;
}

/** What the thread saw while it watched, and how many stats it made. */
export interface DiskSeen {
  states: FileState[];
  writes: DiskWrite[];
  stats: number;
}

/**
 * The least time between the starts of two stats. VS Code's write of a note can pass through all its states
 * within a millisecond, so the thread looks far more often than that; it waits on the clock
 * alone between looks, so the disk sees nothing of it but the stats.
 */
export const STAT_GAP_MS = 0.1;
/**
 * How long a write refused because the file is busy (FILE_BUSY in helpers.ts) is tried again, back
 * to back, so that it lands as soon as the file allows. Any other refusal is recorded at once.
 */
const BUSY_FOR_MS = 1000;
/** How long the thread is given to say it is ready, or to answer a stop: a guard against a hang. */
const ANSWER_MS = 5000;
/** A call to a helper of the bundler's own (__name, __spreadValues and the like), which it defines outside a function. */
const BUNDLER_HELPER = /\b(__[A-Za-z]\w*)\(/;

type ToThread =
  { type: 'watch'; path: string } | { type: 'write'; at: number; text: string; label: string } | { type: 'stop' };

type FromThread = { type: 'ready' } | { type: 'written'; write: DiskWrite } | { type: 'stopped'; seen: DiskSeen };

/** The thread's answers that the main thread waits for. */
type Answer = Exclude<FromThread, { type: 'written' }>;

/** What the thread is given as it starts. */
interface ThreadData {
  port: MessagePort;
  wake: Int32Array;
  origin: string;
  statGapMs: number;
  busyForMs: number;
  busyCode: string;
}

/**
 * The thread's own code. It runs in the thread from its text (`watchAndWrite.toString()`), as the
 * product's reading thread does (src/host/model/fileReads.ts), so it reaches nothing outside
 * itself: Node's modules through `require`, everything else through `workerData`. A module of its
 * own would leave no file for a Worker to load, since esbuild.mjs bundles each in-VS-Code test
 * file alone. Messages arrive through receiveMessageOnPort, read between looks, since the loop
 * never returns to its event loop while it watches.
 */
function watchAndWrite(): void {
  const { receiveMessageOnPort, workerData } = require('node:worker_threads') as typeof threads;
  const { statSync, writeFileSync } = require('node:fs') as typeof fs;
  const { port, wake, origin, statGapMs, busyForMs, busyCode } = workerData as ThreadData;
  const zero = BigInt(origin);
  const now = () => Number(process.hrtime.bigint() - zero) / 1e6;
  const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? error);
  let path: string | null = null;
  let seen: DiskSeen = { states: [], writes: [], stats: 0 };
  let due: { at: number; text: string; label: string; made: boolean }[] = [];
  let last: string | null = null;
  let nextStat = 0;
  let lastStart: number | null = null;

  /** Stats the file, keeps what it found when that differs from the state before, and returns when the stat began. */
  const look = (file: string): number => {
    seen.stats++;
    const since = lastStart;
    const start = now();
    lastStart = start;
    let found: Omit<FileState, 'at' | 'since'>;
    try {
      const s = statSync(file, { throwIfNoEntry: false });
      found =
        s === undefined ? { size: null, mtime: null, error: null } : { size: s.size, mtime: s.mtimeMs, error: null };
    } catch (error) {
      found = { size: null, mtime: null, error: codeOf(error) };
    }
    const key = `${found.size} ${found.mtime} ${found.error}`;
    if (key !== last) {
      last = key;
      seen.states.push({ at: now(), since, ...found });
    }
    return start;
  };

  const write = (file: string, w: { text: string; label: string }) => {
    const at = now();
    let tries = 0;
    let error: string | null = null;
    for (;;) {
      tries++;
      try {
        writeFileSync(file, w.text);
        error = null;
        break;
      } catch (e) {
        error = codeOf(e);
        if (error !== busyCode || now() - at > busyForMs) break;
      }
    }
    const made: DiskWrite = { at, end: now(), label: w.label, tries, error };
    seen.writes.push(made);
    port.postMessage({ type: 'written', write: made } satisfies FromThread);
  };

  port.postMessage({ type: 'ready' } satisfies FromThread);
  for (;;) {
    const woken = Atomics.load(wake, 0);
    const received = receiveMessageOnPort(port);
    if (received) {
      const m = received.message as ToThread;
      if (m.type === 'watch') {
        path = m.path;
        seen = { states: [], writes: [], stats: 0 };
        due = [];
        last = null;
        nextStat = 0;
        lastStart = null;
      } else if (m.type === 'write') {
        due.push({ ...m, made: false });
      } else {
        port.postMessage({ type: 'stopped', seen } satisfies FromThread);
        path = null;
        due = [];
      }
      continue;
    }
    if (path === null) {
      Atomics.wait(wake, 0, woken);
      continue;
    }
    for (const w of due) {
      if (!w.made && now() >= w.at) {
        w.made = true;
        write(path, w);
      }
    }
    if (now() >= nextStat) nextStat = look(path) + statGapMs;
  }
}

/** The disk thread: one serves a whole run, and each window watches one file. */
export class DiskThread {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  /** Bumped after each message, so a sleeping thread wakes to read it. */
  private readonly wake = new Int32Array(new SharedArrayBuffer(4));
  private waiting: { type: Answer['type']; resolve(answer: Answer): void; reject(error: Error): void } | null = null;
  private failure: Error | null = null;
  private ended = false;
  /** The writes made since the window began, each as soon as the thread reports it. */
  readonly written: DiskWrite[] = [];

  /** Starts a thread, and resolves once it is ready to watch: a thread takes some milliseconds to start. */
  static async start(): Promise<DiskThread> {
    const thread = new DiskThread();
    await thread.answer('ready');
    return thread;
  }

  private constructor() {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const data: ThreadData = {
      port: port2,
      wake: this.wake,
      origin: CLOCK_ORIGIN.toString(),
      statGapMs: STAT_GAP_MS,
      busyForMs: BUSY_FOR_MS,
      busyCode: FILE_BUSY,
    };
    // The thread runs watchAndWrite's text as the build emits it, which holds only while the build
    // adds nothing to the function: esbuild.mjs's shared options (`common`) leave keepNames off,
    // which would wrap its inner functions in __name, and target es2022, which leaves its object
    // spreads as written (es2017 makes them helper calls). A helper is defined outside the function,
    // where the thread cannot reach it, so a text that calls one is refused here, not in the thread.
    const source = watchAndWrite.toString();
    const helper = BUNDLER_HELPER.exec(source)?.[1];
    if (helper !== undefined)
      throw new Error(
        `The disk thread's code calls ${helper}, which the build added and the thread cannot reach: ` +
          "esbuild.mjs's shared options must keep names off, with a target that leaves it as written (es2022 does)",
      );
    this.worker = new Worker(`(${source})();`, {
      eval: true,
      workerData: data,
      transferList: [port2],
    });
    port1.on('message', (m: FromThread) => {
      if (m.type === 'written') {
        this.written.push(m.write);
        return;
      }
      const waiting = this.waiting;
      if (waiting?.type !== m.type) return;
      this.waiting = null;
      waiting.resolve(m);
    });
    const fail = (error: Error) => {
      if (this.ended) return;
      this.failure = error;
      this.waiting?.reject(error);
      this.waiting = null;
    };
    this.worker.on('error', fail);
    this.worker.on('exit', (code) => fail(new Error(`The disk thread stopped (exit code ${code})`)));
  }

  /** Begins a window on `path`: the thread stats it from now on. */
  watch(path: string): void {
    this.written.length = 0;
    this.send({ type: 'watch', path });
  }

  /** Writes `text` over the watched file when the clock reaches `at`, or at once when that has passed. */
  writeAt(at: number, text: string, label: string): void {
    this.send({ type: 'write', at, text, label });
  }

  /** Ends the window and resolves with what the thread saw in it. */
  async stop(): Promise<DiskSeen> {
    const answered = this.answer('stopped');
    this.send({ type: 'stop' });
    return (await answered).seen;
  }

  async end(): Promise<void> {
    this.ended = true;
    this.port.close();
    await this.worker.terminate();
  }

  /** Resolves with the thread's next answer of `type`, or rejects when the thread fails or ANSWER_MS passes first. */
  private answer<K extends Answer['type']>(type: K): Promise<Extract<Answer, { type: K }>> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error(`The disk thread did not answer within ${ANSWER_MS} ms`));
      }, ANSWER_MS);
      this.waiting = {
        type,
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer as Extract<Answer, { type: K }>);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private send(m: ToThread): void {
    if (this.failure) throw this.failure;
    this.port.postMessage(m);
    Atomics.add(this.wake, 0, 1);
    Atomics.notify(this.wake, 0);
  }
}
