// A map that keeps at most a given number of entries: reading or writing an entry makes it the
// newest, and a write past the limit drops the oldest. The caches of drawings, sizes and readings
// in render/ and tables/ use it.

export class LruCache<K, V> {
  private readonly entriesByAge = new Map<K, V>();

  constructor(private readonly limit: number) {}

  get(key: K): V | undefined {
    if (!this.entriesByAge.has(key)) return undefined;
    const value = this.entriesByAge.get(key)!;
    this.entriesByAge.delete(key);
    this.entriesByAge.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entriesByAge.delete(key);
    this.entriesByAge.set(key, value);
    while (this.entriesByAge.size > this.limit) this.entriesByAge.delete(this.entriesByAge.keys().next().value!);
  }

  /** Every entry, oldest first. */
  entries(): IterableIterator<[K, V]> {
    return this.entriesByAge.entries();
  }
}
