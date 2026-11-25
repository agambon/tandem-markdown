// Where a note is, and which files a path in it can mean.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { extensionOf, isMarkdownPath } from '../../core/fileKinds';
import { isInsideFolder, pathCaseIgnored } from '../model/insideFolder';
import type { Address } from '../model/linkAddress';
import { MAX_MESSAGE_TEXT } from '../panelMessages';
import { workspaceRelative } from '../uris';

export interface NoteLocation {
  folder: vscode.WorkspaceFolder;
  /** The note's path inside the folder, forward slashes. */
  path: string;
}

/** The workspace folder holding the document, and its path there; undefined outside every folder. */
export function noteLocation(uri: vscode.Uri): NoteLocation | undefined {
  if (uri.scheme === 'untitled') return undefined;
  const fileUri = uri.scheme === 'file' ? uri : vscode.Uri.file(uri.fsPath);
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (!folder) return undefined;
  const rel = workspaceRelative(folder.uri, fileUri);
  return rel === null ? undefined : { folder, path: rel };
}

/**
 * The note a panel's request is about: the panel's own, at `own`, or the embedded note the
 * request names (`note`, a path in the workspace folder of the panel's note). Undefined when
 * `note` is not a markdown file inside that folder.
 */
export function requestNote(own: vscode.Uri, note: unknown): vscode.Uri | undefined {
  if (note === undefined) return own;
  if (typeof note !== 'string' || note.length > MAX_MESSAGE_TEXT || !isMarkdownPath(note)) return undefined;
  const folder = noteLocation(own)?.folder.uri;
  if (!folder) return undefined;
  const uri = vscode.Uri.joinPath(folder, note);
  return isInsideFolder(folder.fsPath, uri.fsPath, path, pathCaseIgnored()) ? uri : undefined;
}

/** The folder the note is in, on disk; undefined for a note that is not a file (untitled). */
export function noteFolder(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === 'untitled') return undefined;
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

/** The folder a `/`-rooted path starts from: the note's workspace folder, else the first one. */
export function rootFolder(uri: vscode.Uri): vscode.Uri | undefined {
  return noteLocation(uri)?.folder.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** The files a path address could mean, most likely first (see `readAddress`). */
export function candidateUris(address: Extract<Address, { kind: 'path' }>, note: vscode.Uri): vscode.Uri[] {
  const base = address.from === 'note' ? noteFolder(note) : address.from === 'root' ? rootFolder(note) : undefined;
  if (address.from !== 'absolute' && !base) return [];
  return address.candidates.map((c) => (base ? vscode.Uri.joinPath(base, c) : vscode.Uri.file(c)));
}

/**
 * `candidateUris`, then for a relative link written without its extension (`[x](Other Note)`)
 * each candidate again as a markdown file.
 */
export function noteCandidateUris(address: Extract<Address, { kind: 'path' }>, note: vscode.Uri): vscode.Uri[] {
  const tries = candidateUris(address, note);
  if (address.from === 'absolute') return tries;
  return [...tries, ...tries.filter((u) => !extensionOf(u.path)).map((u) => u.with({ path: `${u.path}.md` }))];
}
