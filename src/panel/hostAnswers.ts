// Answers the host gives about names the panel draws (an image's source, a wikilink's
// target): asked for a batch at a time as they are drawn, kept for as long as the panel
// lives, and asked for again when something on the host changes them.

interface HostAnswersOptions<T> {
  /** Asks the host about `keys`; resolves with its answers by key. */
  ask(keys: string[]): Promise<unknown>;
  /** The most keys in one request. */
  batch: number;
  /** One key's answer from the host's reply, or null when it holds none that can be read. */
  read(value: unknown): T | null;
  same(a: T, b: T): boolean;
  /** Called when answers arrive, with the keys whose answer is new or changed. */
  changed(keys: readonly string[]): void;
  /** Called when the host did not answer a request. */
  failed(error: unknown): void;
}

export class HostAnswers<T> {
  private readonly answers = new Map<string, T>();
  private readonly pending = new Set<string>();
  /** Keys the host gave no answer for: not asked again until `refresh`. */
  private readonly unanswered = new Set<string>();
  private readonly wanted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: HostAnswersOptions<T>) {}

  get(key: string): T | undefined {
    return this.answers.get(key);
  }

  /** Notes a drawn key; it is asked for on the next `flushSoon` unless it is known or being asked. */
  want(key: string): void {
    if (!key || this.answers.has(key) || this.pending.has(key) || this.unanswered.has(key)) return;
    this.wanted.add(key);
  }

  /** Asks, once the current task is done, about every key wanted since the last ask. */
  flushSoon(): void {
    if (this.wanted.size === 0 || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const keys = [...this.wanted];
      this.wanted.clear();
      this.askAll(keys);
    }, 0);
  }

  /** Every key answered, unanswered or being asked about. */
  keys(): string[] {
    return [...new Set([...this.answers.keys(), ...this.unanswered, ...this.pending])];
  }

  forget(key: string): void {
    this.answers.delete(key);
  }

  /** Asks again about `keys`, whatever is known of them. */
  refresh(keys: readonly string[]): void {
    this.unanswered.clear();
    this.askAll(keys);
  }

  /** Stores the answers in `result` to the keys `asked`. */
  private take(result: Record<string, unknown>, asked: readonly string[]): void {
    const changed: string[] = [];
    for (const key of asked) {
      this.pending.delete(key);
      const answer = this.options.read(result[key]);
      if (answer === null) continue;
      const before = this.answers.get(key);
      this.answers.set(key, answer);
      if (before === undefined || !this.options.same(before, answer)) changed.push(key);
    }
    if (changed.length) this.options.changed(changed);
  }

  private askAll(keys: readonly string[]): void {
    for (let i = 0; i < keys.length; i += this.options.batch) void this.ask(keys.slice(i, i + this.options.batch));
  }

  private async ask(keys: string[]): Promise<void> {
    for (const key of keys) this.pending.add(key);
    let result: unknown;
    try {
      result = await this.options.ask(keys);
    } catch (error) {
      this.options.failed(error);
      this.take({}, keys);
      for (const key of keys) if (!this.answers.has(key)) this.unanswered.add(key);
      return;
    }
    this.take(result && typeof result === 'object' ? (result as Record<string, unknown>) : {}, keys);
  }
}
