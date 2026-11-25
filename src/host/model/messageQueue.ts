// The order of the messages that ask the user something (messages.ts): which pops up, which waits,
// and which a note's strip and the status bar show. One pop-up is up at a time: a message pops up as
// it comes only while no pop-up is up, and the others wait; a reply to a press pops up at once. A
// pop-up is up until it is gone from the screen (pressed, closed by its X, or hidden by VS Code),
// even when its message settled elsewhere, since VS Code cannot close one; then the oldest waiting
// message pops up. A message with a strip waits in its note's strip and the status bar; one with
// none is only its pop-up. A `last` message pops up only while no other message is open, as soon
// as none is, and comes after all others.

/** A message as the queue knows it. */
interface Queued {
  id: string;
  /** The note it is about, as `uri.toString()`; null for a message about no note. */
  note: string | null;
  /** It waits in its note's strip; else it is only its pop-up. */
  strip: boolean;
  last: boolean;
}

export class MessageQueue {
  /** The open messages, as they came. */
  private readonly open: Queued[] = [];
  /** The message whose pop-up is up, open or settled since. */
  private up: string | null = null;
  private readonly popped = new Set<string>();

  /** Adds `m`; true when it pops up now: at once for a reply (`now`), else as the next waiting one would. */
  add(m: Queued, now = false): boolean {
    this.open.push(m);
    if (!now && !this.mayPop(m)) return false;
    this.pop(m.id);
    return true;
  }

  /**
   * The pop-up of `id` is gone from the screen: the message that pops up next, if any. A pop-up
   * other than the one up changes nothing.
   */
  popupGone(id: string): string | null {
    if (this.up !== id) return null;
    this.up = null;
    return this.popNext();
  }

  /** `id`, open, pops up again at the user's asking, whatever pop-up is up: it is the one up now. */
  popAgain(id: string): void {
    if (this.isOpen(id)) this.pop(id);
  }

  /**
   * `id` settled: it leaves the queue, and a pop-up of it that is up stays up until it is gone.
   * Returns the message that pops up now, if any: a `last` one, while no pop-up is up, once it is
   * the only one left.
   */
  settle(id: string): string | null {
    const at = this.open.findIndex((m) => m.id === id);
    if (at >= 0) this.open.splice(at, 1);
    this.popped.delete(id);
    return this.up === null ? this.popNext() : null;
  }

  /** `id`'s note was renamed: it is `note` now. */
  renote(id: string, note: string): void {
    const m = this.open.find((o) => o.id === id);
    if (m) m.note = note;
  }

  isOpen(id: string): boolean {
    return this.open.some((m) => m.id === id);
  }

  /** Whether `id`'s pop-up has been shown. */
  hasPopped(id: string): boolean {
    return this.popped.has(id);
  }

  /** The message whose pop-up is up, open or settled since. */
  upNow(): string | null {
    return this.up;
  }

  /** The message a note's strip shows, its oldest open one with a strip, and how many more wait behind it there. */
  shownFor(note: string): { id: string; more: number } | null {
    const strips = this.ordered().filter((m) => m.strip && m.note === note);
    return strips.length === 0 ? null : { id: strips[0]!.id, more: strips.length - 1 };
  }

  /** The message the status bar names: the oldest open one in a strip. */
  firstWithNote(): { id: string; note: string } | null {
    const m = this.ordered().find((o) => o.strip && o.note !== null);
    return m && m.note !== null ? { id: m.id, note: m.note } : null;
  }

  /** How many open messages currently wait in a note's strip. */
  waitingCount(): number {
    return this.open.filter((o) => o.strip && o.note !== null).length;
  }

  /** Whether an open message is about `note`. */
  hasNote(note: string): boolean {
    return this.open.some((m) => m.note === note);
  }

  private ordered(): Queued[] {
    return [...this.open.filter((m) => !m.last), ...this.open.filter((m) => m.last)];
  }

  /** The oldest waiting message that may pop up, popped up; null for none. */
  private popNext(): string | null {
    const next = this.ordered().find((m) => !this.popped.has(m.id) && this.mayPop(m));
    if (!next) return null;
    this.pop(next.id);
    return next.id;
  }

  private mayPop(m: Queued): boolean {
    if (this.up !== null) return false;
    return !m.last || this.open.every((o) => o === m || o.last);
  }

  private pop(id: string): void {
    this.up = id;
    this.popped.add(id);
  }
}
