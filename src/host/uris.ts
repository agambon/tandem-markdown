// Small facts about uris, paths and documents that the host's features share.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInsideFolder, partsInside, pathCaseIgnored, sameFilePath } from './model/insideFolder';

export function fileNameOf(uri: vscode.Uri): string {
  return path.posix.basename(uri.path);
}

/** What the host's log lines about a note begin with: its file name and ": ". */
export function logPrefixOf(uri: vscode.Uri): string {
  return `${fileNameOf(uri)}: `;
}

export function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

/** True when both uris name one file: for the `file` scheme, the same path as VS Code compares paths. */
export function sameFile(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.scheme !== b.scheme) return false;
  return a.scheme === 'file' ? sameFilePath(a.fsPath, b.fsPath) : a.fsPath === b.fsPath;
}

/** A key for the file `uri` names: two uris `sameFile` takes for one file have one key. */
export function fileKey(uri: vscode.Uri): string {
  return uri.scheme === 'file' && pathCaseIgnored() ? uri.toString().toLowerCase() : uri.toString();
}

/** A file system path with the platform's separators written as `/`. */
export function toForwardSlashes(fsPath: string): string {
  return fsPath.split(path.sep).join('/');
}

/** The path of `uri` inside `folder`, with forward slashes; null when it is not inside. */
export function workspaceRelative(folder: vscode.Uri, uri: vscode.Uri): string | null {
  const rel = path.relative(folder.fsPath, uri.fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toForwardSlashes(rel);
}

/**
 * Where the file at `uri` is once `from` has been renamed to `to`: `to` itself, or the same
 * place under `to` when `from` is a folder holding it. Undefined when the rename leaves it.
 */
export function movedUri(uri: vscode.Uri, from: vscode.Uri, to: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme !== 'file' || from.scheme !== 'file') return undefined;
  if (sameFile(uri, from)) return to;
  const ignoreCase = pathCaseIgnored();
  if (!isInsideFolder(from.fsPath, uri.fsPath, path, ignoreCase)) return undefined;
  return vscode.Uri.joinPath(to, ...partsInside(from.fsPath, uri.fsPath, path, ignoreCase));
}

/** The new key (`uri.toString()`) of each of `keys` that `renames` moves, by its old key (movedUri). */
export function movedKeys(
  keys: Iterable<string>,
  renames: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[],
): Map<string, string> {
  const moves = new Map<string, string>();
  for (const key of keys) {
    const uri = vscode.Uri.parse(key);
    const to = renames.map((r) => movedUri(uri, r.oldUri, r.newUri)).find((u) => u !== undefined);
    if (to) moves.set(key, to.toString());
  }
  return moves;
}

/** The document's encoding as VS Code reports it, `utf8` when it reports none. */
export function encodingOf(document: vscode.TextDocument): string {
  return document.encoding || 'utf8';
}
