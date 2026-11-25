import { describe, expect, it } from 'vitest';
import {
  SETTLE_MS,
  TRUNCATED_RETRY_MS,
  asWritten,
  cutInsideCharacter,
  isTruncatedAfterRetry,
  readSettled,
} from '../../../src/core/reconcile/disk';
import type { DiskPort, DiskRead, FileStat } from '../../../src/core/reconcile/types';

const enc = new TextEncoder();

function makeSchedule() {
  let now = 0;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      now += ms;
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
  };
}

function makeDisk(stats: Array<FileStat | null>, reads: DiskRead[]): DiskPort {
  let statIdx = 0;
  let readIdx = 0;
  return {
    async stat() {
      return stats[Math.min(statIdx++, stats.length - 1)]!;
    },
    async read() {
      return reads[Math.min(readIdx++, reads.length - 1)]!;
    },
    async backup() {
      return '/backups/b1.md';
    },
    async deleteBackup() {
      return undefined;
    },
    async readBackup() {
      return null;
    },
  };
}

describe('disk helpers', () => {
  it('distinguishes mid-line truncation from a clean line-break deletion after retry', () => {
    const base = 'first line\nsecond line\nthird line\n';
    expect(isTruncatedAfterRetry(base, '')).toBe(true);
    expect(isTruncatedAfterRetry(base, 'first line\nsec')).toBe(true);
    expect(isTruncatedAfterRetry(base, 'first line\n')).toBe(false);
    expect(isTruncatedAfterRetry(base, 'first line')).toBe(false);
    expect(isTruncatedAfterRetry(base, 'first line\nrewritten')).toBe(false);
  });

  it('detects trailing bytes cut inside a multi-byte UTF-8 character', () => {
    const full = enc.encode('hello 😀');
    expect(cutInsideCharacter(full.subarray(0, full.length - 1), 'utf8')).toBe(true);
    expect(cutInsideCharacter(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80]), 'utf8')).toBe(false);
  });

  it('normalizes unpaired surrogates for UTF-8 but preserves them for UTF-16LE', () => {
    const lone = 'a\ud800b';
    expect(asWritten(lone, 'utf8')).toBe('a\ufffdb');
    expect(asWritten(lone, 'utf16le')).toBe(lone);
  });
});

describe('readSettled', () => {
  it('retries once when a file looks truncated and clears truncated when the write finishes', async () => {
    const base = 'alpha line\nbeta line\ngamma line\n';
    const partial = enc.encode('alpha line\nbe');
    const finished = enc.encode('alpha line\nbeta line\ngamma line\ndelta\n');
    const sleeps: number[] = [];

    const s1 = { mtime: 10, size: partial.length };
    const s2 = { mtime: 20, size: finished.length };
    const disk = makeDisk(
      [s1, s1, s1, s2, s2, s2],
      [
        { ok: true, bytes: partial },
        { ok: true, bytes: finished },
      ],
    );

    const res = await readSettled(disk, makeSchedule(), {
      encoding: 'utf8',
      base,
      inSave: false,
      sleep: async (ms) => {
        sleeps.push(ms);
        return true;
      },
      stopped: () => false,
    });

    expect(sleeps).toEqual([SETTLE_MS, TRUNCATED_RETRY_MS, SETTLE_MS]);
    expect(res).toMatchObject({ kind: 'text', text: 'alpha line\nbeta line\ngamma line\ndelta\n', truncated: false });
  });

  it('marks truncated true when the file remains cut mid-line after the retry', async () => {
    const base = 'alpha line\nbeta line\ngamma line\n';
    const partial = enc.encode('alpha line\nbe');
    const disk = makeDisk([{ mtime: 10, size: partial.length }], [{ ok: true, bytes: partial }]);

    const res = await readSettled(disk, makeSchedule(), {
      encoding: 'utf8',
      base,
      inSave: false,
      sleep: async () => true,
      stopped: () => false,
    });

    expect(res).toMatchObject({ kind: 'text', text: 'alpha line\nbe', truncated: true });
  });

  it('skips the 200 ms settle wait for already-known text', async () => {
    const bytes = enc.encode('known\n');
    const sleeps: number[] = [];
    const disk = makeDisk([{ mtime: 1, size: bytes.length }], [{ ok: true, bytes }]);

    const res = await readSettled(disk, makeSchedule(), {
      encoding: 'utf8',
      base: 'known\n',
      inSave: false,
      isKnown: (t) => t === 'known\n',
      sleep: async (ms) => {
        sleeps.push(ms);
        return true;
      },
      stopped: () => false,
    });

    expect(sleeps).toEqual([]);
    expect(res).toMatchObject({ kind: 'text', text: 'known\n', truncated: false });
  });

  it('returns bytesOnly for non-UTF encodings and failed for persistent busy reads', async () => {
    const bytes = new Uint8Array([0x61, 0xe9, 0x0a]);
    const nonUtf = await readSettled(makeDisk([{ mtime: 1, size: 3 }], [{ ok: true, bytes }]), makeSchedule(), {
      encoding: 'windows1252',
      base: null,
      inSave: true,
      sleep: async () => true,
      stopped: () => false,
    });
    expect(nonUtf).toMatchObject({ kind: 'bytesOnly', bytes });

    const busy = await readSettled(makeDisk([{ mtime: 1, size: 3 }], [{ ok: false, error: 'busy' }]), makeSchedule(), {
      encoding: 'utf8',
      base: null,
      inSave: false,
      sleep: async () => true,
      stopped: () => false,
    });
    expect(busy).toEqual({ kind: 'failed', error: 'busy' });
  });
});
