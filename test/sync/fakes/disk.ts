// The file on disk, and the backup folder. Every operation the core asks for stays pending
// until the driver resolves it, and its result is taken at that moment, so a read can see a
// file half written, missing, or changed since the stat before it.
import { toLf } from '../../../src/core/eol';
import type { BackupLabel, DiskPort, DiskRead, FileStat } from '../../../src/core/reconcile/types';
import { isQuietLabel } from '../../../src/host/model/backupNames';
import type { FakeClock } from './clock';

export interface PendingDiskOp {
  kind: 'stat' | 'read' | 'backup' | 'deleteBackup' | 'readBackup' | 'vsRead' | 'saveStart' | 'savePiece' | 'saveWrite';
  run(): void;
  /** Fake time when it was asked for. */
  at: number;
  /** It cannot finish before `at + delay` (a slow disk, FakeDisk.delayFor); 0 for most. */
  delay: number;
}

/**
 * 'savePart': VS Code's write of a save under way (the file emptied, then its first pieces); 'save':
 * its last piece.
 */
export type WriteOrigin = 'outside' | 'savePart' | 'save';

export class FakeDisk implements DiskPort {
  file: { bytes: Uint8Array; mtime: number } | null;
  /** Every backup written, by path: its bytes, label, whether deleted since, and the time it was asked for. */
  readonly backups = new Map<string, { bytes: Uint8Array; label: BackupLabel; deleted: boolean; at: number }>();
  readonly ops: PendingDiskOp[] = [];
  /** Every LF text the file has ever held whole and decodable (property 5). */
  readonly history = new Set<string>();
  /** Called after every change to the file. */
  onChange: (origin: WriteOrigin) => void = () => {};
  /** Count of core reads resolved, and the fake time of the last one. */
  coreReads = 0;
  lastCoreReadAt = -1;
  /** Fault: the next N reads report the file busy. */
  busyReads = 0;
  /** Fault: the next N backups fail (a full disk, a folder that cannot be written); Infinity for all of them. */
  failBackups = 0;
  /** How many backups failed. */
  backupFailures = 0;
  /** What each failed backup was to hold, with its label and the time it was asked for. */
  readonly failedBackups: { bytes: Uint8Array; label: BackupLabel; at: number }[] = [];
  /** VS Code's write of a save empties the file first, as a step of its own (saveWrite). */
  savesEmptyFirst = false;
  /** Between that first step and the last: the file holds part of VS Code's write. */
  midSave = false;
  /** The least time, in fake ms, an operation of this kind takes (a network share, a scanner). */
  delayFor: (kind: PendingDiskOp['kind']) => number = () => 0;
  private writes = 0;
  private backupSeq = 0;

  constructor(
    private readonly clock: FakeClock,
    initial: Uint8Array | null,
  ) {
    this.file = null;
    if (initial) this.write(initial, 'outside', false);
  }

  // ---------------------------------------------------------------------------
  // DiskPort

  stat(): Promise<FileStat | null> {
    return this.op('stat', () => (this.file ? { mtime: this.file.mtime, size: this.file.bytes.length } : null));
  }

  /**
   * A slow read answers with the file as it was when the read began (a read whose bytes came back
   * late), not as it is when it answers (the default).
   */
  readsAtStart = false;

  read(): Promise<DiskRead> {
    const atStart = this.readsAtStart && this.file ? this.file.bytes.slice() : null;
    return this.op('read', (): DiskRead => {
      this.coreReads++;
      this.lastCoreReadAt = this.clock.now();
      if (this.busyReads > 0) {
        this.busyReads--;
        return { ok: false, error: 'busy', detail: 'locked (simulated)' };
      }
      if (atStart !== null) return { ok: true, bytes: atStart };
      return this.file ? { ok: true, bytes: this.file.bytes.slice() } : { ok: false, error: 'missing' };
    });
  }

  backup(bytes: Uint8Array, label: BackupLabel): Promise<string> {
    const copy = bytes.slice();
    const at = this.clock.now();
    return this.op('backup', () => {
      if (this.failBackups > 0) {
        this.failBackups--;
        this.backupFailures++;
        this.failedBackups.push({ bytes: copy, label, at });
        throw new Error('ENOSPC: no space left on device (simulated)');
      }
      const path = `outside-versions/file.${++this.backupSeq}.${label}.md`;
      this.backups.set(path, { bytes: copy, label, deleted: false, at });
      return path;
    });
  }

  deleteBackup(path: string): Promise<void> {
    return this.op('deleteBackup', () => {
      const b = this.backups.get(path);
      if (b) b.deleted = true;
    });
  }

  readBackup(path: string): Promise<Uint8Array | null> {
    return this.op('readBackup', () => {
      const b = this.backups.get(path);
      return b && !b.deleted ? b.bytes.slice() : null;
    });
  }

  // ---------------------------------------------------------------------------
  // For VS Code's side of the fake

  /** Called as each of VS Code's reads takes the file's bytes. */
  onVsRead: (() => void) | null = null;

  /** VS Code reading the file to reload a clean document. */
  vsRead(): Promise<Uint8Array | null> {
    return this.op('vsRead', () => {
      this.onVsRead?.();
      return this.file ? this.file.bytes.slice() : null;
    });
  }

  /**
   * VS Code writing a save; resolves once the bytes are on disk. With savesEmptyFirst, opening
   * the file to write empties it first, and the text goes in two pieces (VS Code writes a
   * document a piece of its text buffer at a time), each a step of its own.
   */
  saveWrite(bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    const last = () =>
      this.op('saveWrite', () => {
        this.midSave = false;
        this.write(copy, 'save');
      });
    if (!this.savesEmptyFirst) return last();
    const half = copy.slice(0, Math.floor(copy.length / 2));
    return this.op('saveStart', () => {
      this.midSave = true;
      this.write(new Uint8Array(0), 'savePart');
    })
      .then(() => (half.length > 0 ? this.op('savePiece', () => this.write(half, 'savePart')) : undefined))
      .then(last);
  }

  // ---------------------------------------------------------------------------
  // For the driver

  /** The indices of the pending operations that may finish at fake time `now`, in order. */
  ready(now: number): number[] {
    const out: number[] = [];
    this.ops.forEach((op, i) => {
      if (op.at + op.delay <= now) out.push(i);
    });
    return out;
  }

  /** Resolves pending operation `index`. */
  resolve(index: number): void {
    const [op] = this.ops.splice(index, 1);
    this.onResolve(op!.kind);
    op!.run();
  }

  /** For traces. */
  onResolve: (kind: PendingDiskOp['kind']) => void = () => {};

  /** An immediate change to the file (an outside program, or a step of VS Code's write of a save). */
  write(bytes: Uint8Array, origin: WriteOrigin, notify = true): void {
    this.writes++;
    // Strictly increasing, as NTFS times are at the resolution these tests need.
    this.file = { bytes: bytes.slice(), mtime: this.clock.now() + this.writes / 1000 };
    const text = decodeStrict(bytes);
    if (text !== null) this.history.add(toLf(text));
    // As VS Code reads it (a reload or an opening decodes leniently): also a version of the file.
    this.history.add(toLf(decodeLenient(bytes)));
    if (notify) this.onChange(origin);
  }

  remove(): void {
    this.writes++;
    this.file = null;
    this.onChange('outside');
  }

  /** The file's LF text, read the way VS Code would (lenient). Null when there is no file. */
  textLenient(): string | null {
    return this.file ? toLf(decodeLenient(this.file.bytes)) : null;
  }

  /**
   * The quiet copies of the user's text the core asked for (isQuietLabel), read leniently: each one
   * written, deleted since or not, and each one that could not be written (`written` false), with
   * the time it was asked for.
   */
  quietCopies(): { text: string; written: boolean; at: number }[] {
    const copies = (list: readonly { bytes: Uint8Array; label: BackupLabel; at: number }[], written: boolean) =>
      list.filter((b) => isQuietLabel(b.label)).map((b) => ({ text: decodeLenient(b.bytes), written, at: b.at }));
    return [...copies([...this.backups.values()], true), ...copies(this.failedBackups, false)];
  }

  liveBackups(): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const [path, b] of this.backups) if (!b.deleted) out.push({ path, text: decodeLenient(b.bytes) });
    return out;
  }

  /** An operation that stays pending until the driver resolves it; one whose `fn` throws rejects. */
  private op<T>(kind: PendingDiskOp['kind'], fn: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.ops.push({
        kind,
        at: this.clock.now(),
        delay: this.delayFor(kind),
        run: () => {
          try {
            resolve(fn());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Encodings

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf16leBomBytes(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

/** The bytes a save writes in the document's encoding: UTF-16 LE with its mark, else UTF-8. */
export function encodeAs(text: string, encoding: string): Uint8Array {
  return encoding === 'utf16le' ? utf16leBomBytes(text) : utf8Bytes(text);
}

/** UTF-16 LE code units as they are, an unpaired surrogate included, as VS Code reads and writes them. */
function utf16leUnits(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  return s;
}

/** As VS Code reads a file: a byte-order mark decides, else UTF-8, bad bytes become U+FFFD. */
export function decodeLenient(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16leUnits(bytes.subarray(2));
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      if (bytes.length % 2 !== 0) return null;
      return utf16leUnits(bytes.subarray(2));
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The line ending a file mostly uses, as VS Code picks it when it loads; null when it has none. */
export function dominantEol(raw: string): '\n' | '\r\n' | null {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) {
      if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? '\r\n' : '\n';
}
