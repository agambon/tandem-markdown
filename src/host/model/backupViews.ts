// The words of a comparison and of the list of a note's backups (backupViews.ts shows them).

import type { ConflictReason } from '../../core/reconcile/types';
import { type BackupKind, KIND_WORDS } from './backupNames';

export const BACKUP_BUTTON = 'Compare with Backup';
const BEFORE_SAVE = "file as it was before VS Code's save";
const UNKNOWN_KIND = 'backup';

export type VersionName = 'theirs' | 'older' | 'cut' | 'disk' | 'beforeSave';

const VERSION_WORDS: Record<VersionName, string> = {
  theirs: KIND_WORDS.theirs,
  older: KIND_WORDS.older,
  cut: KIND_WORDS.cut,
  disk: KIND_WORDS.disk,
  beforeSave: BEFORE_SAVE,
};

export function kindWords(kind: BackupKind | null): string {
  return kind ? KIND_WORDS[kind] : UNKNOWN_KIND;
}

export function isVersionName(value: unknown): value is VersionName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VERSION_WORDS, value);
}

export function conflictVersionName(kind: BackupKind, reason: ConflictReason, savedOver: boolean): VersionName | null {
  const kept: VersionName = savedOver
    ? 'beforeSave'
    : reason === 'noBase'
      ? 'disk'
      : reason === 'truncated'
        ? 'cut'
        : 'theirs';
  return kept === kind ? null : kept;
}

export function comparisonTitle(
  name: string,
  kind: BackupKind | null,
  noteClosed: boolean,
  versionName: VersionName | null,
): string {
  const right = noteClosed ? 'file on disk' : kind === 'yours' ? 'your text now' : 'your text';
  return `${name}: ${versionName === null ? kindWords(kind) : VERSION_WORDS[versionName]} ↔ ${right}`;
}

export const DONE_ROW = {
  label: 'Done with these backups',
  detail: `The ${BACKUP_BUTTON} button leaves this note's tab bar until a message tells you of another backup. These backups stay in this list, which the command "Tandem Markdown: ${BACKUP_BUTTON}" still opens.`,
};

export function backupRow(
  kind: BackupKind | null,
  mtime: number,
  versionName: VersionName | null,
): { label: string; description: string } {
  const when = new Date(mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  return { label: versionName === null ? kindWords(kind) : VERSION_WORDS[versionName], description: when };
}
