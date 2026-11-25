// The host's own writes of files on the local disk, and whether a file is there. The host's own
// files, backups among them, are written through Node, so that an error carries the system's
// code; a file a note points to, or a file in the backup folder, is looked up through VS Code's
// file system (`statOf`, `mayBeThere`), which reads wherever the workspace is.

import { randomBytes } from 'node:crypto';
import { access, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * How many times, and how far apart, a rename onto a file that another program has open is tried.
 * Windows refuses to replace an open file, and a program that reads one, as VS Code does an open
 * file that changed, or merely looks it up, has it open for a few milliseconds.
 */
const RENAME_TRIES = 40;
const RENAME_PAUSE_MS = 25;

/**
 * Writes `text` to `fsPath` through a temporary name beside it and a rename, so the file is never
 * read half written. A rename Windows refuses while another program has the file open is tried
 * again (RENAME_TRIES); when the write still fails the temporary file goes and the error is thrown.
 */
export async function writeWhole(fsPath: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(fsPath), `.${path.basename(fsPath)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temp, text, 'utf8');
    await renameOnceFree(temp, fsPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Renames `from` over `to`, trying again while Windows refuses it for `to` being open elsewhere. */
async function renameOnceFree(from: string, to: string): Promise<void> {
  for (let tried = 1; ; tried++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!heldOpen(error) || tried >= RENAME_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_PAUSE_MS));
    }
  }
}

/** True for Windows's refusal of a rename onto a file another program has open: EPERM, EACCES or EBUSY. */
function heldOpen(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
}

/** What VS Code's file system says is at `uri`; undefined when nothing is, or it cannot be seen. */
export async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/**
 * True unless VS Code's stat of `uri` says nothing is there: a file or folder is there, or the
 * stat failed for another reason (a permission, a drive gone for a moment), so one may be. A name
 * that may be there is never written to, and a backup that may be there is not taken for gone.
 */
export async function mayBeThere(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

/** True when a failed read says nothing is there: Node's ENOENT, or VS Code's FileNotFound. */
export function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'FileNotFound';
}

/** True when a file or folder is at `fsPath`; false also when it cannot be seen. */
export function exists(fsPath: string): Promise<boolean> {
  return access(fsPath).then(
    () => true,
    () => false,
  );
}
