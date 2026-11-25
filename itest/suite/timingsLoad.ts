// How loaded the extension host and the machine were while a window of the facts file on VS
// Code's timings ran (factsTimings.test.ts), and the loop that keeps the extension host busy for
// the trials run under load.

import * as os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { toMicro } from './timingsClock';

export interface Load {
  /** The share of the window the extension host's thread was at work, 0 to 1 (Node's event loop utilization). */
  hostBusy: number;
  /**
   * How late a timer on that thread ran past its due time, in milliseconds; null when it never ran.
   * Node's monitorEventLoopDelay records the time between its timer's runs, of which SAMPLE_MS is
   * the timer's own interval, taken off here. On Windows a timer runs only on the system's timer
   * tick, so an idle thread shows some lateness too.
   */
  timerLateMs: { mean: number; p99: number; max: number } | null;
  /**
   * The share of the window every processor of the machine was at work, 0 to 1. The disk thread
   * (timingsDisk.ts) keeps one processor at work throughout a window, so `diskThreadShare` of it is
   * the measuring itself.
   */
  machineBusy: number;
  /** One processor's share of the machine: the part of `machineBusy` that is the disk thread. */
  diskThreadShare: number;
}

/** How often the timer whose lateness is measured is due. */
const SAMPLE_MS = 10;

/** A share (0 to 1) to the thousandth, as the records keep shares. */
function roundShare(share: number): number {
  return Math.round(share * 1000) / 1000;
}

/** The processors' working and total times, summed over all of them. */
function processorTimes(): { work: number; total: number } {
  let work = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    work += times.user + times.nice + times.sys + times.irq;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { work, total };
}

/** Starts measuring; the function returned stops and says what was measured. */
export function measureLoad(): () => Load {
  const delay = monitorEventLoopDelay({ resolution: SAMPLE_MS });
  delay.enable();
  const utilization = performance.eventLoopUtilization();
  const before = processorTimes();
  return () => {
    delay.disable();
    const after = processorTimes();
    const late = (ns: number) => toMicro(ns / 1e6 - SAMPLE_MS);
    return {
      hostBusy: roundShare(performance.eventLoopUtilization(utilization).utilization),
      timerLateMs:
        delay.count === 0 ? null : { mean: late(delay.mean), p99: late(delay.percentile(99)), max: late(delay.max) },
      machineBusy:
        after.total === before.total ? 0 : roundShare((after.work - before.work) / (after.total - before.total)),
      diskThreadShare: roundShare(1 / os.cpus().length),
    };
  };
}

/**
 * Keeps the extension host's thread at work in turns of `turnMs`, letting what waits (events,
 * timers, replies) run between turns, until the function returned is called.
 */
export function keepBusy(turnMs: number): () => void {
  let running = true;
  const turn = () => {
    if (!running) return;
    const end = performance.now() + turnMs;
    while (performance.now() < end) {
      // The turn's work is this wait: the thread runs nothing else until it ends.
    }
    setImmediate(turn);
  };
  setImmediate(turn);
  return () => {
    running = false;
  };
}
