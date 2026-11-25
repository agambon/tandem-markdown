/// <reference types="mocha" />
// Shared by the in-VS-Code test files. Each test file is bundled on its own, so nothing here
// holds state between files; the extension's test hook is the shared state.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { name, publisher } from '../../package.json';
import type { CoreNotice } from '../../src/core/coordinator';
import { VIEW_TYPE } from '../../src/host/model/editorIds';
import type { TandemMarkdownTestApi } from '../../src/host/testApi';

export type { TandemMarkdownTestApi };
export { VIEW_TYPE };

const EXTENSION_ID = `${publisher}.${name}`;

let cached: TandemMarkdownTestApi | null = null;

/** The extension's test hook (activating the extension if needed). */
export async function api(): Promise<TandemMarkdownTestApi> {
  if (cached) return cached;
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) throw new Error(`${EXTENSION_ID} is not loaded`);
  const exported = (await ext.activate()) as TandemMarkdownTestApi | undefined;
  if (!exported || typeof exported.panelState !== 'function')
    throw new Error('The extension did not return its test hook');
  cached = exported;
  return exported;
}

export function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('The test copy of VS Code has no workspace open');
  return folder.uri.fsPath;
}

/** Writes a file into the test workspace (as another program would) and returns its uri. */
export function writeFile(name: string, content: string | Uint8Array): vscode.Uri {
  const file = path.join(workspaceDir(), name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeAsAProgram(file, content);
  return vscode.Uri.file(file);
}

/** Writes over the file at `uri` as another program would. */
export function writeFileAt(uri: vscode.Uri, content: string | Uint8Array): void {
  writeAsAProgram(uri.fsPath, content);
}

/**
 * The code a write gets that Windows refuses because another program holds the file, as VS Code's
 * Local History does for a moment after every save (seen in VS Code 1.120).
 */
export const FILE_BUSY = 'EBUSY';
/** How many times a write that Windows refuses because the file is busy is tried. */
const BUSY_TRIES = 20;
/** How long a busy file is let be before the write is tried again: several copies of a small note. */
const BUSY_RETRY_MS = 25;
const BUSY_WAIT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Writes `content` to `file`. VS Code's Local History copies a note as soon as it is saved, and on
 * Windows a copy refuses writers until it is done (FILE_BUSY): the write is tried again then,
 * BUSY_RETRY_MS later, up to BUSY_TRIES times, as a program's own retry does. The wait blocks the
 * thread without spinning, so the helpers that write stay synchronous.
 */
function writeAsAProgram(file: string, content: string | Uint8Array): void {
  for (let tried = 1; ; tried++) {
    try {
      writeFileSync(file, content);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FILE_BUSY || tried >= BUSY_TRIES) throw error;
      Atomics.wait(BUSY_WAIT, 0, 0, BUSY_RETRY_MS);
    }
  }
}

/** Runs git in `cwd` with an identity of its own, so no git setting of the machine is needed or changed; returns its output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Tandem Tests', '-c', 'user.email=tests@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

export function readBytes(uri: vscode.Uri): Buffer {
  return readFileSync(uri.fsPath);
}

export function readText(uri: vscode.Uri): string {
  return readFileSync(uri.fsPath, 'utf8');
}

export function mtime(uri: vscode.Uri): number {
  return statSync(uri.fsPath).mtimeMs;
}

export function lf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function documentFor(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

/** Opens the file in our editor (a new tab) and waits until its panel has been sent its init. */
export async function openRich(
  uri: vscode.Uri,
  column: vscode.ViewColumn = vscode.ViewColumn.Active,
): Promise<vscode.TextDocument> {
  const hook = await api();
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: column, preview: false });
  await hook.whenPanelLive(uri);
  // The panel answers once it has drawn its first state.
  await hook.panelState(uri);
  const doc = documentFor(uri);
  if (!doc) throw new Error(`No document for ${uri.path}`);
  return doc;
}

export async function openText(
  uri: vscode.Uri,
  column: vscode.ViewColumn = vscode.ViewColumn.Active,
): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
}

/** Polls `condition` until it holds. The time limit is a guard against a hang, not a measurement. */
export async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  if (!(await holdsWithin(ms, condition))) throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Polls `condition` until it holds or `ms` have passed, and says which: for what may not happen,
 * whose absence is itself the answer. The time is a limit on waiting, not a measurement.
 */
export async function holdsWithin(ms: number, condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > end) return false;
    await pause(POLL_MS);
  }
}

const POLL_MS = 25;

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reverts every dirty document (so closing never asks to save), then closes every editor and
 * forgets where each note was left, so that the next test opens each note as if new.
 */
export async function closeEverything(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isClosed);
    if (dirty.length === 0) break;
    for (const d of dirty) {
      try {
        await vscode.window.showTextDocument(d, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      } catch {
        // gone meanwhile
      }
    }
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // VS Code tells the extension of each closed tab's panel before the command's own reply, so
  // their places have been kept by now, and go with the rest.
  (await api()).forgetPlaces();
}

/** Records every change event of one document. */
export function recordChanges(uri: vscode.Uri): {
  events: { dirty: boolean; reason: vscode.TextDocumentChangeReason | undefined; changes: number; at: number }[];
  dispose(): void;
} {
  const events: { dirty: boolean; reason: vscode.TextDocumentChangeReason | undefined; changes: number; at: number }[] =
    [];
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== uri.toString()) return;
    events.push({ dirty: e.document.isDirty, reason: e.reason, changes: e.contentChanges.length, at: Date.now() });
  });
  return { events, dispose: () => sub.dispose() };
}

/** The tabs of all groups that show this file. */
export function tabsFor(uri: vscode.Uri): vscode.Tab[] {
  const key = uri.toString();
  return vscode.window.tabGroups.all.flatMap((g) =>
    g.tabs.filter((t) => {
      const input = t.input;
      return (
        (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) && input.uri.toString() === key
      );
    }),
  );
}

export function activeTabIsRich(uri: vscode.Uri): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return (
    input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === uri.toString()
  );
}

export function activeTextEditorShows(uri: vscode.Uri): boolean {
  return vscode.window.activeTextEditor?.document.uri.toString() === uri.toString();
}

/** Updates a workspace setting and returns a function that puts it back. */
export async function setSetting(
  section: string,
  key: string,
  value: unknown,
  languageId?: string,
): Promise<() => Promise<void>> {
  const config = vscode.workspace.getConfiguration(section, languageId ? { languageId } : undefined);
  const before = languageId ? config.inspect(key)?.workspaceLanguageValue : config.inspect(key)?.workspaceValue;
  await config.update(key, value, vscode.ConfigurationTarget.Workspace, languageId ? true : undefined);
  return async () => {
    await vscode.workspace
      .getConfiguration(section, languageId ? { languageId } : undefined)
      .update(key, before, vscode.ConfigurationTarget.Workspace, languageId ? true : undefined);
  };
}

/**
 * A clash in a rich tab: `name` written as "The cat sat on the mat.", opened in the Rich editor,
 * "cat" replaced there by "dog" and left unsaved, then "cow" written in its place by another
 * program. Resolves with the note, its document and the conflict notice, once that is raised.
 */
export async function clashInRichTab(
  name: string,
): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument; notice: Extract<CoreNotice, { kind: 'conflict' }> }> {
  const uri = writeFile(name, 'The cat sat on the mat.\n');
  const doc = await openRich(uri);
  const hook = await api();
  const at = 'The '.length;
  await hook.runInPanel(uri, [{ type: 'replace', from: at, to: at + 3, text: 'dog' }, { type: 'flush' }]);
  await waitFor(() => lf(doc.getText()) === 'The dog sat on the mat.\n', 'the edit to reach the document');
  writeFileSync(uri.fsPath, 'The cow sat on the mat.\n');
  const conflict = () => hook.notices().find((n) => n.uri === uri.toString() && n.notice.kind === 'conflict')?.notice;
  await waitFor(() => conflict() !== undefined, 'the conflict notice');
  return { uri, doc, notice: conflict() as Extract<CoreNotice, { kind: 'conflict' }> };
}

/**
 * Called in a suite: after each of its tests, closes every editor, then deletes each file the test
 * pushed to the list returned (the backups and conflict files it leaves).
 */
export function deletedAfterEach(): string[] {
  const written: string[] = [];
  teardown(async () => {
    await closeEverything();
    for (const file of written.splice(0)) rmSync(file, { force: true });
  });
  return written;
}

/** The diff tab whose title is `title`. */
export function diffTab(title: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputTextDiff && t.label === title);
}

/**
 * Called in a suite: after each of its tests, puts back what the test changed (each function it
 * pushed to the list returned, the last first), then closes every editor.
 */
export function undoAfterEach(): (() => Promise<void>)[] {
  const restore: (() => Promise<void>)[] = [];
  teardown(async () => {
    for (const undo of restore.splice(0).reverse()) await undo();
    await closeEverything();
  });
  return restore;
}

/** A short line for the run's output (the report reads these). */
export function note(message: string): void {
  console.log(`      note: ${message}`);
}
