// Backups live in `<globalStorage>/outside-versions/`, each named for the note, what it holds
// and when it was written (model/backupNames.ts). At activation, backups older than
// BACKUP_MAX_AGE_DAYS or beyond the newest BACKUP_MAX_COUNT are deleted, and the copies kept with
// nothing said are counted apart, beyond the newest QUIET_MAX_COUNT (model/backupPrune.ts). Which
// those are is kept in the extension's global state (QUIET_KEY; backupViews.ts keeps the list).
// Writing, deleting and pruning say so through `onDidChangeBackups`, which names a backup kept
// quietly (isQuietLabel) as it is written. A backup is found for its note by a tag of the note's
// address in its name, so a note VS Code renames has its backups renamed with it.

import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BackupLabel } from '../core/reconcile/types';
import { isMissing, mayBeThere } from './localFiles';
import { log } from './log';
import {
  backupName,
  backupStamp,
  isQuietLabel,
  kindOfLabel,
  NAMES_TRIED,
  readBackupName,
  renamedBackupName,
  TAG_LENGTH,
  type BackupKind,
} from './model/backupNames';
import { backupsToDelete } from './model/backupPrune';
import { fileNameOf, movedUri } from './uris';

const BACKUP_FOLDER = 'outside-versions';
/** The backups kept with nothing said, by `vscode.Uri.file(path).toString()`, in the extension's global state. */
export const QUIET_KEY = 'tandemMarkdown.quietBackups';

/**
 * The backups that open conflict file parts name, in every workspace, by the same key, in the
 * extension's global state (conflictFiles.ts keeps each workspace's list): never pruned.
 */
export const NAMED_KEY = 'tandemMarkdown.namedBackups';

export function namedBackups(state: vscode.Memento): Set<string> {
  const byWorkspace = state.get<Record<string, string[]>>(NAMED_KEY) ?? {};
  return new Set(Object.values(byWorkspace).flat());
}

/** The backups kept with nothing said, as the global state holds them. */
export function quietBackups(state: vscode.Memento): Set<string> {
  return new Set(state.get<string[]>(QUIET_KEY) ?? []);
}

/** A backup renamed for its note's new name: where it is now, and where its note is. */
export interface MovedBackup {
  path: string;
  note: vscode.Uri;
}

/**
 * A change to the backup folder. `quiet`: the path of a backup just written with nothing said of
 * it. `moved`: backups renamed for their note's new name, by each one's old path.
 */
export interface BackupsChange {
  quiet?: string;
  moved?: ReadonlyMap<string, MovedBackup>;
}

const changed = new vscode.EventEmitter<BackupsChange>();
/** A backup was written or deleted. */
export const onDidChangeBackups = changed.event;

export function backupFolder(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, BACKUP_FOLDER);
}

/** A short hash of the document's uri (TAG_LENGTH hex characters), so two files of one name do not collide. */
export function pathTag(documentKey: string): string {
  return createHash('sha256').update(documentKey).digest('hex').slice(0, TAG_LENGTH);
}

/** Names reserved in this session, so two backups started together never pick the same name. */
const reserved = new Set<string>();
/** The backups being written, which renameBackups waits for. */
const writing = new Set<Promise<string>>();

/**
 * Writes the bytes as a new backup and returns its path. Never overwrites a file. `label` is
 * the core's reason for the backup, which says whether it holds the user's text.
 */
export async function writeBackup(
  folder: vscode.Uri,
  fileName: string,
  documentKey: string,
  bytes: Uint8Array,
  label?: BackupLabel,
): Promise<string> {
  const write = writeNewBackup(folder, fileName, documentKey, bytes, label);
  writing.add(write);
  try {
    return await write;
  } finally {
    writing.delete(write);
  }
}

async function writeNewBackup(
  folder: vscode.Uri,
  fileName: string,
  documentKey: string,
  bytes: Uint8Array,
  label: BackupLabel | undefined,
): Promise<string> {
  await vscode.workspace.fs.createDirectory(folder);
  const tag = pathTag(documentKey);
  const stamp = backupStamp(new Date());
  const kind = kindOfLabel(label);
  for (let n = 1; n < NAMES_TRIED; n++) {
    const target = vscode.Uri.joinPath(folder, backupName(fileName, kind, tag, stamp, n));
    if (reserved.has(target.toString())) continue;
    reserved.add(target.toString());
    try {
      // `wx`: created only where no file has the name, even one another window wrote a moment ago.
      await writeFile(target.fsPath, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'EEXIST') continue;
      throw error;
    } finally {
      reserved.delete(target.toString());
    }
    changed.fire(isQuietLabel(label) ? { quiet: target.fsPath } : {});
    return target.fsPath;
  }
  throw new Error(`Could not find a free backup name for ${fileName}`);
}

export async function deleteBackup(path: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: false });
  changed.fire({});
}

/**
 * Deletes the old backups (model/backupPrune.ts), counting those in `quiet`, the copies kept with
 * nothing said, apart from the rest, and never one in `named`, which an open part names. Logs
 * what it did.
 */
export async function pruneBackups(
  folder: vscode.Uri,
  quiet: ReadonlySet<string>,
  named: ReadonlySet<string> = new Set(),
  now = Date.now(),
): Promise<void> {
  const files = await backupFiles(folder);
  const key = (f: BackupFile) => vscode.Uri.file(f.path).toString();
  const doomed = backupsToDelete(
    files,
    (f) => quiet.has(key(f)),
    now,
    (f) => named.has(key(f)),
  );
  let deleted = 0;
  for (const f of doomed) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(f.path), { useTrash: false });
      deleted++;
    } catch (error) {
      log('warn', `Could not delete the old backup ${f.path}`, error);
    }
  }
  if (deleted > 0) {
    log('info', `Deleted ${deleted} old backup${deleted === 1 ? '' : 's'}`);
    changed.fire({});
  }
}

/** A backup file, as the folder holds it. */
export interface BackupFile {
  path: string;
  name: string;
  mtime: number;
  /** The tag of the note it was written for (model/backupNames.ts); null for a file not named as a backup. */
  tag: string | null;
  /** What it holds; null for a file not named as a backup. */
  kind: BackupKind | null;
}

/** Every `.md` file in the backup folder, newest first. */
export async function backupFiles(folder: vscode.Uri): Promise<BackupFile[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(folder);
  } catch (error) {
    // No folder yet, until the first backup is written.
    if (!isMissing(error)) log('warn', 'Could not read the backup folder', error);
    return [];
  }
  const files: BackupFile[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.md')) continue;
    const uri = vscode.Uri.joinPath(folder, name);
    let mtime: number;
    try {
      mtime = (await vscode.workspace.fs.stat(uri)).mtime;
    } catch (error) {
      // A file gone since the folder was read is left out with nothing said.
      if (!isMissing(error)) log('warn', `Could not read the backup ${uri.fsPath}`, error);
      continue;
    }
    const parts = readBackupName(name);
    files.push({ path: uri.fsPath, name, mtime, tag: parts?.tag ?? null, kind: parts?.kind ?? null });
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** The backups written for the document whose uri is `documentKey`, newest first. */
export async function noteBackups(folder: vscode.Uri, documentKey: string): Promise<BackupFile[]> {
  const tag = pathTag(documentKey);
  return (await backupFiles(folder)).filter((f) => f.tag === tag);
}

/**
 * Notes, or folders of notes, renamed in VS Code: each backup of a note under a renamed path is
 * renamed for the note's new name and address, keeping its kind and time, so that it is listed
 * with the note again and a note made later at the old path does not take it. Says so through
 * `onDidChangeBackups`, with each backup's old and new path and its note's new place. Waits first
 * for the backups being written, so that one still being written as the rename lands, not yet in
 * the folder, is renamed with the rest.
 */
export async function renameBackups(
  folder: vscode.Uri,
  renames: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[],
): Promise<void> {
  await Promise.allSettled(writing);
  const files = await backupFiles(folder);
  if (files.length === 0) return;
  const tags = new Set(files.map((f) => f.tag));
  /** The new place of each renamed note that has backups, by the tag of its old place. */
  const notes = new Map<string, vscode.Uri>();
  for (const { oldUri, newUri } of renames) {
    if (newUri.scheme !== 'file') continue;
    for (const note of await filesAt(newUri)) {
      const was = movedUri(note, newUri, oldUri);
      const tag = was && pathTag(was.toString());
      if (tag && tags.has(tag)) notes.set(tag, note);
    }
  }
  const moved = new Map<string, MovedBackup>();
  for (const file of files) {
    const note = file.tag === null ? undefined : notes.get(file.tag);
    if (!note) continue;
    const to = await renameBackup(folder, file, note);
    if (to) moved.set(file.path, { path: to, note });
  }
  if (moved.size > 0) changed.fire({ moved });
}

/**
 * The files at a renamed path: every one under it for a folder, read in one call through Node,
 * since a large folder would take a call per folder through VS Code's file system; the path itself
 * for a file, or where nothing is there now; none for a folder that cannot be read.
 */
async function filesAt(uri: vscode.Uri): Promise<vscode.Uri[]> {
  try {
    const inside = await readdir(uri.fsPath, { recursive: true });
    return inside.map((p) => vscode.Uri.joinPath(uri, ...p.split(path.sep)));
  } catch (error) {
    if (isMissing(error) || (error as { code?: unknown }).code === 'ENOTDIR') return [uri];
    log('warn', `Could not read the renamed folder ${uri.fsPath}, so its notes' backups keep their old names`, error);
    return [];
  }
}

/**
 * Renames a backup for its note's new place, `note`: under its own number where that name is
 * free, else the first free number from 2. The new path, or null when it was left as it is.
 */
async function renameBackup(folder: vscode.Uri, file: BackupFile, note: vscode.Uri): Promise<string | null> {
  const tag = pathTag(note.toString());
  for (let n = 1; n < NAMES_TRIED; n++) {
    const name = renamedBackupName(file.name, fileNameOf(note), tag, n === 1 ? undefined : n);
    if (name === null) return null;
    const target = vscode.Uri.joinPath(folder, name);
    if (reserved.has(target.toString()) || (await mayBeThere(target))) continue;
    reserved.add(target.toString());
    try {
      await vscode.workspace.fs.rename(vscode.Uri.file(file.path), target, { overwrite: false });
      return target.fsPath;
    } catch (error) {
      log('warn', `Could not rename the backup ${file.path} for its note's new name`, error);
      return null;
    } finally {
      reserved.delete(target.toString());
    }
  }
  return null;
}
