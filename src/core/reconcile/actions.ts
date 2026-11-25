// Bounded store for open notice actions (Use Change from Disk, Replace My View, Undo).
// Never replays stored positions: every action recomputes against the current document under the gate.

import { alignedDiff } from '../alignDiff';
import { decodeBytes, textCopyBytes } from '../encoding';
import { toLf } from '../eol';
import { safeMerge } from '../safeMerge';
import { type BackupLabel, type ConflictChoice, MERGE_TRIES, type ReconcilerDeps } from './types';

const MAX_OPEN_ACTIONS = 20;

interface ChoiceEntry {
  base: string | null;
  /** Document text right after `conflictKeepOurs` landed (so `use` swaps only the clash span). */
  afterOurs: string | null;
  choice: Exclude<ConflictChoice, 'none'>;
  backupPath: string | null;
  /** Kept in memory only when writing the backup failed. */
  diskFallback: string | null;
}

interface UndoEntry {
  /** Text left in the note when the disk words were applied. */
  after: string;
  /** Text to restore (re-merged against any edits typed since). */
  target: string;
  /** Backup of the disk version removed by Undo (kept so nothing is lost). */
  diskBackupPath: string | null;
}

export class NoticeActions {
  private readonly choices = new Map<string, ChoiceEntry>();
  private readonly undos = new Map<string, UndoEntry>();
  private readonly unreadableBackups = new Set<string>();

  constructor(
    private readonly d: ReconcilerDeps,
    private readonly disposed: () => boolean,
  ) {}

  /** Writes a backup and returns its path, or null on failure (never throws). */
  async backupBytes(bytes: Uint8Array, label: BackupLabel): Promise<string | null> {
    try {
      return await this.d.disk.backup(bytes, label);
    } catch (error) {
      this.d.log('warn', `Could not write a backup for ${this.d.fileName}`, error);
      return null;
    }
  }

  /** Writes a backup of LF text; never throws. */
  async backupText(text: string, label: BackupLabel): Promise<string | null> {
    return this.backupBytes(textCopyBytes(text), label);
  }

  /** Deletes an obsolete backup, ignoring errors. */
  async deleteBackup(path: string | null): Promise<void> {
    if (path === null) return;
    try {
      await this.d.disk.deleteBackup(path);
    } catch {
      // Best-effort cleanup only.
    }
  }

  recordChoice(
    id: string,
    choice: ConflictChoice,
    base: string | null,
    backupPath: string | null,
    diskText: string | null,
    afterOurs: string | null = null,
  ): void {
    if (choice === 'none') return;
    this.choices.set(id, {
      base,
      afterOurs,
      choice,
      backupPath,
      diskFallback: backupPath === null ? diskText : null,
    });
    trimMap(this.choices, MAX_OPEN_ACTIONS);
  }

  recordUndo(id: string, after: string, target: string, diskBackupPath: string | null): void {
    this.undos.set(id, { after, target, diskBackupPath });
    trimMap(this.undos, MAX_OPEN_ACTIONS);
  }

  offers(id: string): boolean {
    return !this.disposed() && (this.choices.has(id) || this.undos.has(id));
  }

  unreadableVersion(id: string): boolean {
    return this.unreadableBackups.has(id);
  }

  noticeClosed(id: string): void {
    this.choices.delete(id);
    this.undos.delete(id);
  }

  clear(): void {
    this.choices.clear();
    this.undos.clear();
  }

  /** Applies the disk side of a clash while preserving the user's non-conflicting edits. */
  useFileVersion(noticeId: string): Promise<boolean> {
    return this.runChoice(noticeId, 'use');
  }

  /** Replaces the note with the backed-up disk version, backing up the current note first. */
  replaceNote(noticeId: string): Promise<boolean> {
    return this.runChoice(noticeId, 'replace');
  }

  private async runChoice(noticeId: string, mode: 'use' | 'replace'): Promise<boolean> {
    const entry = this.choices.get(noticeId);
    if (!entry || entry.choice !== mode) {
      this.reject(noticeId, mode, this.disposed() ? 'closed' : 'changed');
      return false;
    }
    const diskText = await this.loadDiskText(noticeId, entry);
    return diskText === null ? false : this.applyChoice(noticeId, entry, diskText, mode);
  }

  /** Restores the user's pre-change text while keeping edits typed elsewhere since. */
  async undoUsed(noticeId: string): Promise<boolean> {
    const entry = this.undos.get(noticeId);
    if (!entry || this.disposed()) {
      this.reject(noticeId, 'undo', this.disposed() ? 'closed' : 'changed');
      return false;
    }

    for (let attempt = 0; attempt < MERGE_TRIES; attempt++) {
      if (this.disposed()) {
        this.reject(noticeId, 'undo', 'closed');
        return false;
      }
      const outcome = await this.d.withGate(null, async (h): Promise<'done' | 'changed' | 'again' | 'refused'> => {
        if (this.disposed()) return 'refused';
        const current = this.d.documentLf();
        if (current === entry.target) return 'done';
        const merged = safeMerge(entry.after, current, entry.target, 'theirs', this.d);
        if (merged.conflicts.length > 0) return 'changed';
        const edit = alignedDiff(current, merged.text);
        if (edit.length === 0) return 'done';
        const applied = await this.d.applyMerge(h, edit, merged.text, 'press');
        return applied.kind === 'applied' ? 'done' : applied.kind === 'stale' ? 'again' : 'refused';
      });
      if (outcome === 'done') {
        this.undos.delete(noticeId);
        return true;
      }
      if (outcome === 'again') continue;
      if (outcome === 'changed') this.undos.delete(noticeId);
      this.reject(noticeId, 'undo', outcome === 'changed' ? 'changed' : 'refused');
      return false;
    }
    this.reject(noticeId, 'undo', 'refused');
    return false;
  }

  private async loadDiskText(noticeId: string, entry: ChoiceEntry): Promise<string | null> {
    if (entry.backupPath !== null) {
      const bytes = await this.d.disk.readBackup(entry.backupPath);
      if (bytes !== null) {
        const decoded = decodeBytes(bytes, this.d.encoding());
        if (decoded !== null) return toLf(decoded);
      }
      this.unreadableBackups.add(noticeId);
      this.choices.delete(noticeId);
      this.reject(noticeId, entry.choice, 'missingBackup');
      return null;
    }
    if (entry.diskFallback !== null) return entry.diskFallback;
    this.choices.delete(noticeId);
    this.reject(noticeId, entry.choice, 'missingBackup');
    return null;
  }

  private async applyChoice(
    noticeId: string,
    entry: ChoiceEntry,
    diskText: string,
    mode: 'use' | 'replace',
  ): Promise<boolean> {
    let previous: string | null = null;
    let appliedText: string | null = null;

    for (let attempt = 0; attempt < MERGE_TRIES; attempt++) {
      if (this.disposed()) {
        this.reject(noticeId, mode, 'closed');
        return false;
      }
      const res = await this.d.withGate(null, async (h): Promise<'done' | 'again' | 'refused'> => {
        if (this.disposed()) return 'refused';
        const current = this.d.documentLf();
        let nextText = diskText;
        if (mode === 'use' && entry.base !== null) {
          if (entry.afterOurs !== null) {
            const theirsAtClash = safeMerge(entry.base, entry.afterOurs, diskText, 'theirs', this.d).text;
            nextText = safeMerge(entry.afterOurs, current, theirsAtClash, 'theirs', this.d).text;
          } else {
            nextText = safeMerge(entry.base, current, diskText, 'theirs', this.d).text;
          }
        }
        if (nextText === current) {
          previous = current;
          appliedText = current;
          return 'done';
        }
        const edit = alignedDiff(current, nextText);
        const applied = await this.d.applyMerge(h, edit, nextText, 'press');
        if (applied.kind === 'applied') {
          previous = current;
          appliedText = nextText;
          return 'done';
        }
        return applied.kind === 'stale' ? 'again' : 'refused';
      });
      if (res === 'done') break;
      if (res === 'again') continue;
      this.reject(noticeId, mode, 'refused');
      return false;
    }

    if (previous === null || appliedText === null) {
      this.reject(noticeId, mode, 'refused');
      return false;
    }
    this.choices.delete(noticeId);
    if (previous === appliedText) return true;

    const undoBackup = await this.backupText(previous, 'yours');
    const id = this.d.newId();
    this.recordUndo(id, appliedText, previous, entry.backupPath);
    this.d.notify({
      kind: 'applied',
      id,
      how: mode === 'use' ? 'useChoice' : 'replaceChoice',
      backupPath: undoBackup,
      previousText: undoBackup === null ? previous : null,
      diskBackupPath: entry.backupPath,
      canUndo: true,
    });
    return true;
  }

  private reject(
    noticeId: string,
    action: 'use' | 'replace' | 'undo',
    reason: 'changed' | 'closed' | 'missingBackup' | 'refused',
  ): void {
    this.d.notify({ kind: 'actionRejected', id: noticeId, action, reason });
  }
}

function trimMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
