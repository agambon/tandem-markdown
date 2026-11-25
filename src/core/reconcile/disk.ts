// Settled disk reads, encoding/byte helpers, and single-retry truncation detection.

import { decodeBytes, fromCodeUnits, keepsUnpairedSurrogates, readsText } from '../encoding';
import { toLf } from '../eol';
import { stampOf, textHash } from '../hash';
import type { Schedule } from '../protocol';
import type { DiskPort, FileStat } from './types';

/** Pause between two stats outside a save step to confirm a writer has finished. */
export const SETTLE_MS = 200;
/** Pause before retrying a transient unstable/missing/busy read. */
const RETRY_READ_MS = 120;
const SAVE_RETRY_READ_MS = 40;
/** Single wait before re-reading a file that looks truncated or cut mid-character. */
export const TRUNCATED_RETRY_MS = 750;
const SAVE_TRUNCATED_RETRY_MS = 100;
const CUT_SHORT_TAIL = 40;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function sameStat(a: FileStat, b: FileStat): boolean {
  return a.mtime === b.mtime && a.size === b.size;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The text as VS Code writes it in `encoding` (UTF-8 turns unpaired surrogates into U+FFFD). */
export function asWritten(text: string, encoding: string): string {
  return keepsUnpairedSurrogates(encoding) ? text : text.replace(LONE_SURROGATE, '\ufffd');
}

export function stampKey(text: string, encoding: string): string {
  const s = stampOf(asWritten(text, encoding));
  return `${s.length}:${s.hash}`;
}

export function bytesKey(bytes: Uint8Array): string {
  return `${bytes.length}:${textHash(fromCodeUnits(bytes))}`;
}

/** True when `bytes` decode cleanly once 1-3 trailing bytes are dropped (a write cut mid-character). */
export function cutInsideCharacter(bytes: Uint8Array, encoding: string): boolean {
  for (let cut = 1; cut <= 3 && cut < bytes.length; cut++) {
    if (decodeBytes(bytes.subarray(0, bytes.length - cut), encoding) !== null) return true;
  }
  return false;
}

/** Broad trigger for a single re-read: empty file, cut mid-character, or missing the base's tail. */
export function mayBeMidWrite(
  base: string | null,
  theirs: string | null,
  bytes: Uint8Array,
  encoding: string,
): boolean {
  if (theirs === null) return cutInsideCharacter(bytes, encoding);
  if (base === null || base.trim() === '') return false;
  if (theirs.length === 0) return true;
  if (theirs.length < base.length && base.startsWith(theirs)) return true;
  const tail = base.trimEnd().slice(-CUT_SHORT_TAIL);
  return tail.length > 0 && !theirs.includes(tail);
}

/**
 * Strict check AFTER the retry settles: true only for unmistakable truncation (an emptied
 * non-empty file, or a strict prefix of `base` stopping mid-line rather than at a line break).
 */
export function isTruncatedAfterRetry(base: string | null, theirs: string): boolean {
  if (base === null || base.trim() === '') return false;
  if (theirs.length === 0) return true;
  if (theirs.length >= base.length || !base.startsWith(theirs)) return false;
  // Stopped cleanly at a line break: treat as a normal edit (quiet backup still guards clean notes).
  const endedOnBreak = theirs.endsWith('\n') || base[theirs.length] === '\n';
  return !endedOnBreak;
}

export type SettledRead =
  | { kind: 'text'; text: string; bytes: Uint8Array; stat: FileStat; truncated: boolean }
  | { kind: 'bytesOnly'; bytes: Uint8Array; stat: FileStat }
  | { kind: 'undecodable'; bytes: Uint8Array; stat: FileStat; cutMidChar: boolean }
  | { kind: 'missing' }
  | { kind: 'failed'; error: 'busy' | 'failed' }
  | { kind: 'unstable'; bytes: Uint8Array | null }
  | { kind: 'aborted' };

export interface ReadOptions {
  encoding: string;
  base: string | null;
  inSave: boolean;
  /** Skip the 200ms post-read settle wait when the text is already a known synced version. */
  isKnown?: (text: string) => boolean;
  sleep(ms: number): Promise<boolean>;
  stopped(): boolean;
}

/**
 * Reads the file until its before/after stats agree (and, outside a save step, still agree after
 * `SETTLE_MS` for unknown texts). Performs one extra wait + re-read when the file looks mid-write.
 */
export async function readSettled(disk: DiskPort, _schedule: Schedule, opts: ReadOptions): Promise<SettledRead> {
  const first = await readOnceSettled(disk, opts);
  if (first.kind === 'aborted' || first.kind === 'missing' || first.kind === 'failed' || first.kind === 'bytesOnly') {
    return first;
  }
  if (first.kind === 'unstable') return first;

  const needsRetry =
    first.kind === 'undecodable'
      ? first.cutMidChar
      : !(opts.isKnown?.(first.text) ?? false) && mayBeMidWrite(opts.base, first.text, first.bytes, opts.encoding);

  if (!needsRetry) return first;

  const ok = await opts.sleep(opts.inSave ? SAVE_TRUNCATED_RETRY_MS : TRUNCATED_RETRY_MS);
  if (!ok || opts.stopped()) return { kind: 'aborted' };

  const again = await readOnceSettled(disk, opts);
  if (again.kind === 'aborted' || again.kind === 'missing' || again.kind === 'failed' || again.kind === 'bytesOnly') {
    return again;
  }
  if (again.kind === 'unstable') {
    return { kind: 'unstable', bytes: again.bytes ?? first.bytes };
  }
  if (again.kind === 'undecodable') return again;
  return {
    ...again,
    truncated: isTruncatedAfterRetry(opts.base, again.text),
  };
}

async function readOnceSettled(disk: DiskPort, opts: ReadOptions): Promise<SettledRead> {
  const attempts = opts.inSave ? 3 : 2;
  const pauseMs = opts.inSave ? SAVE_RETRY_READ_MS : RETRY_READ_MS;
  const textMode = readsText(opts.encoding);
  let lastBytes: Uint8Array | null = null;
  let lastError: 'missing' | 'busy' | 'failed' | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.stopped()) return { kind: 'aborted' };
    const before = await disk.stat();
    if (opts.stopped()) return { kind: 'aborted' };
    if (before === null) {
      lastError = 'missing';
      if (attempt + 1 < attempts && !(await opts.sleep(pauseMs))) return { kind: 'aborted' };
      continue;
    }

    const res = await disk.read();
    if (opts.stopped()) return { kind: 'aborted' };
    if (!res.ok) {
      lastError = res.error;
      if (attempt + 1 < attempts && !(await opts.sleep(pauseMs))) return { kind: 'aborted' };
      continue;
    }
    lastBytes = res.bytes;

    const after = await disk.stat();
    if (opts.stopped()) return { kind: 'aborted' };
    if (after === null || !sameStat(before, after)) {
      if (attempt + 1 < attempts && !(await opts.sleep(pauseMs))) return { kind: 'aborted' };
      continue;
    }

    if (!textMode) {
      if (!opts.inSave) {
        if (!(await opts.sleep(SETTLE_MS)) || opts.stopped()) return { kind: 'aborted' };
        const settled = await disk.stat();
        if (opts.stopped()) return { kind: 'aborted' };
        if (settled === null || !sameStat(after, settled)) {
          if (attempt + 1 < attempts) continue;
          return { kind: 'unstable', bytes: res.bytes };
        }
      }
      return { kind: 'bytesOnly', bytes: res.bytes, stat: after };
    }

    const decoded = decodeBytes(res.bytes, opts.encoding);
    const lf = decoded === null ? null : toLf(decoded);

    if (!opts.inSave && (lf === null || !(opts.isKnown?.(lf) ?? false))) {
      if (!(await opts.sleep(SETTLE_MS)) || opts.stopped()) return { kind: 'aborted' };
      const settled = await disk.stat();
      if (opts.stopped()) return { kind: 'aborted' };
      if (settled === null || !sameStat(after, settled)) {
        if (attempt + 1 < attempts) continue;
        return { kind: 'unstable', bytes: res.bytes };
      }
    }

    if (lf === null) {
      return {
        kind: 'undecodable',
        bytes: res.bytes,
        stat: after,
        cutMidChar: cutInsideCharacter(res.bytes, opts.encoding),
      };
    }
    return { kind: 'text', text: lf, bytes: res.bytes, stat: after, truncated: false };
  }

  if (lastError === 'missing') return { kind: 'missing' };
  if (lastError === 'busy' || lastError === 'failed') return { kind: 'failed', error: lastError };
  return { kind: 'unstable', bytes: lastBytes };
}
