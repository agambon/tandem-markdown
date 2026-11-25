// The one clock of the facts file on VS Code's timings (factsTimings.test.ts): milliseconds from
// process.hrtime, which is monotonic and the same in every thread of the extension host, so the
// disk thread (timingsDisk.ts) stamps its stats and writes on it too.

/** The clock's zero: process.hrtime.bigint() when this module loaded. */
export const CLOCK_ORIGIN = process.hrtime.bigint();

/** Milliseconds since CLOCK_ORIGIN. */
export function now(): number {
  return Number(process.hrtime.bigint() - CLOCK_ORIGIN) / 1e6;
}

/** `ms` to the microsecond, as the records keep times. */
export function toMicro(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
