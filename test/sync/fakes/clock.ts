// A clock the simulation owns. Time moves only when the driver moves it.
import type { Schedule } from '../../../src/core/protocol';

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeClock implements Schedule {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, Timer>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** When the earliest timer is due, or null. */
  nextDue(): number | null {
    let best: Timer | null = null;
    for (const t of this.timers.values())
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    return best ? best.at : null;
  }

  /** Fires the earliest timer, moving time to it. False when there is none. */
  fireNext(): boolean {
    let best: [number, Timer] | null = null;
    for (const e of this.timers)
      if (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[1].seq < best[1].seq)) best = e;
    if (!best) return false;
    this.timers.delete(best[0]);
    if (best[1].at > this.t) this.t = best[1].at;
    best[1].fn();
    return true;
  }

  /** Fires every timer due now (in order), without moving time. Returns how many fired. */
  fireDue(): number {
    let n = 0;
    for (;;) {
      const due = this.nextDue();
      if (due === null || due > this.t) return n;
      this.fireNext();
      n++;
    }
  }

  /**
   * Moves time toward `target`: if a timer is due on the way, time moves to it and that one
   * timer fires (the caller lets promises settle before the next); otherwise time moves to
   * `target`. Real timers never fire two callbacks without the microtasks between them.
   */
  advanceToward(target: number): void {
    const due = this.nextDue();
    if (due !== null && due <= target) {
      this.fireNext();
      return;
    }
    if (target > this.t) this.t = target;
  }
}
