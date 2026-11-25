// Types and ports for the outside-change reconciler. No prose lives here: the reconciler emits
// structured outcomes, and the host renders user-facing messages and conflict files from them.

import type { TextChange } from '../diff';
import type { ApplyOutcome, GateHolder } from '../documentGate';
import type { Prefer } from '../merge3';
import type { LogLevel, Schedule } from '../protocol';

export interface FileStat {
  mtime: number;
  size: number;
}

export type DiskRead =
  { ok: true; bytes: Uint8Array } | { ok: false; error: 'missing' | 'busy' | 'failed'; detail?: string };

/** Why a backup was written. `beforeRemoval` is kept quietly and pruned apart from told backups. */
export type BackupLabel =
  | 'beforeSave'
  | 'conflict'
  | 'unknownBase'
  | 'undecodable'
  | 'notMerged'
  | 'yours'
  | 'beforeRemoval'
  | 'cut'
  | 'fileOnDisk';

export interface DiskPort {
  stat(): Promise<FileStat | null>;
  read(): Promise<DiskRead>;
  backup(bytes: Uint8Array, label: BackupLabel): Promise<string>;
  deleteBackup(path: string): Promise<void>;
  readBackup(path: string): Promise<Uint8Array | null>;
}

/** Where a passage stands in a note's text, by the nearest non-blank line above it. */
export interface Place {
  at: 'start' | 'after' | 'end';
  line: string | null;
}

/** One conflicting stretch where the user's words were kept. */
export interface ClashPassage extends Place {
  yours: string;
  theirs: string;
  lineNumber: number;
}

export type ConflictReason = 'clash' | 'handoff' | 'noBase' | 'truncated' | 'encoding';
export type ConflictChoice = 'use' | 'replace' | 'none';

/** Structured domain events emitted by the core. The host formats every user-visible string. */
export type CoreNotice =
  | {
      kind: 'conflict';
      id: string;
      reason: ConflictReason;
      restMerged: boolean;
      savedOver: boolean;
      backupPath: string | null;
      diskText: string | null;
      baseText: string | null;
      noteText: string | null;
      passages: readonly ClashPassage[];
      choice: ConflictChoice;
    }
  | {
      kind: 'truncatedFollow';
      id: string;
      backupPath: string | null;
      previousText: string;
      diskText: string;
    }
  | {
      kind: 'applied';
      id: string;
      how: 'setting' | 'useChoice' | 'replaceChoice' | 'reloaded';
      backupPath: string | null;
      previousText: string | null;
      diskBackupPath: string | null;
      canUndo: boolean;
    }
  | {
      kind: 'actionRejected';
      id: string;
      action: 'use' | 'replace' | 'undo';
      reason: 'changed' | 'closed' | 'missingBackup' | 'refused';
    }
  | {
      kind: 'closedWithPending';
      id: string;
      backupPath: string | null;
      diskText: string | null;
    }
  | {
      kind: 'readStatus';
      id: string;
      ok: boolean;
      error?: 'busy' | 'failed';
    }
  | {
      kind: 'saveCheckOff';
      id: string;
    }
  | {
      kind: 'typingAtClose';
      id: string;
      backupPath: string | null;
      copy: string;
      closedText: string;
      linesChanged: number;
    };

export type CoreEditReason = 'merge' | 'press';

export interface SaveStepCount {
  counted: number;
  warned: boolean;
}

export interface ReconcilerDeps {
  disk: DiskPort;
  schedule: Schedule;
  documentLf(): string;
  isDirty(): boolean;
  encoding(): string;
  withGate<T>(holder: GateHolder | null, fn: (h: GateHolder) => Promise<T>): Promise<T>;
  applyMerge(h: GateHolder, changes: TextChange[], expected: string, reason: CoreEditReason): Promise<ApplyOutcome>;
  prefer(): Prefer;
  fileName: string;
  key: string;
  notify(notice: CoreNotice): void;
  log(level: LogLevel, message: string, detail?: unknown): void;
  remember(key: string, value: unknown): void;
  recall(key: string): unknown;
  newId(): string;
  debug?: ((message: string) => void) | undefined;
  holdOutside?: (() => boolean) | undefined;
  saveSteps?: SaveStepCount | undefined;
}

export const MERGE_TRIES = 5;
