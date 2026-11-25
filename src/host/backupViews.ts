// What the user does with a backup, and with a version kept in memory when no backup could be
// written (docs/ARCHITECTURE.md, "Backups on the host"): every comparison opens one way, VS
// Code's diff with the backup on the left and the user's text on the right
// (model/backupViews.ts); Compare with Backup lists the note's backups with "Copy path"; the
// backups button shows while the note has a backup a message named, until the user is done with
// the note's backups (DONE_ROW); a version with no backup opens at once in a new unsaved tab. Which
// backups the user is done with, which were kept quietly and what a message named each are kept in
// the extension's global state, which every window shares (see "What the global state keeps"). A
// note renamed in VS Code has its backups renamed with it (backups.ts), and what is remembered of
// each goes with it: a message shown before the rename compares the backup and the note where they are.

import * as vscode from 'vscode';
import { plainNotice } from '../core/noticeText';
import {
  type BackupFile,
  type MovedBackup,
  QUIET_KEY,
  backupFiles,
  backupFolder,
  noteBackups,
  onDidChangeBackups,
  pathTag,
  renameBackups,
} from './backups';
import { registerCommand } from './commandRegistration';
import { setContextKey } from './contextKeys';
import { mayBeThere } from './localFiles';
import { log } from './log';
import { type BackupKind, readBackupName } from './model/backupNames';
import {
  BACKUP_BUTTON,
  DONE_ROW,
  type VersionName,
  backupRow,
  comparisonTitle,
  isVersionName,
} from './model/backupViews';
import { askPick } from './questions';
import { currentTab, tabUri } from './tabs';
import { fileNameOf, sameUri } from './uris';

/** The backups the user is done with (DONE_ROW), by `vscode.Uri.file(path).toString()`. */
const DONE_KEY = 'tandemMarkdown.doneBackups';
/** What a message named each backup it named otherwise than its kind (conflictVersionName), by the same key. */
const VERSION_NAMES_KEY = 'tandemMarkdown.backupVersionNames';
/** The files (`uri.toString()`) of open tabs whose note has a backup that shows the button: its condition. */
const BUTTON_KEY = 'tandemMarkdown.backupButtonFiles';
const COPY_PATH = 'Copy path';

/** What a failed write of each kept list is logged as. */
const DONE_LOGGED = 'which backups the person was done with';
const QUIET_LOGGED = 'which backups were kept with nothing said';
const NAMES_LOGGED = 'what the messages called the backups';

/** A row of the list: what it shows, and the path its "Copy path" button copies. */
interface ListedBackup {
  label: string;
  description: string;
  path: string;
}

/** What Compare with Backup resolves with (docs/ARCHITECTURE.md, "The test hook"). */
export interface CompareWithBackupResult {
  /** The message shown in place of the list, for a note with no backups. */
  message?: string;
  rows: ListedBackup[];
  /** The backup whose comparison was opened. */
  opened?: string;
  /** The user chose DONE_ROW. */
  done?: true;
  /** How many of the note's backups show the button, after the command (`buttonless`): it shows while this is not 0. */
  shown: number;
}

interface RowItem extends vscode.QuickPickItem {
  file: BackupFile;
}

/** The list's last row, while the note's backups show the button: the user is done with them. */
interface DoneItem extends vscode.QuickPickItem {
  done: true;
}

type ListItem = RowItem | DoneItem | vscode.QuickPickItem;

/** A backup's key in the lists the global state keeps. */
function keyOf(path: string): string {
  return vscode.Uri.file(path).toString();
}

class BackupViews {
  private context: vscode.ExtensionContext | null = null;
  private files: BackupFile[] = [];
  private scan = 0;
  /**
   * Where each backup renamed in this session is now, and its note, by its old path: a message
   * shown before the rename names the backup's old path and holds the note's closed document.
   */
  private readonly movedTo = new Map<string, MovedBackup>();
  /** The unsaved tab each version kept in memory was opened in, by its text. */
  private readonly heldTabs = new Map<string, vscode.TextDocument>();

  start(context: vscode.ExtensionContext): vscode.Disposable {
    this.context = context;
    void this.rescan();
    return vscode.Disposable.from(
      onDidChangeBackups((change) => {
        if (change.quiet !== undefined) {
          const key = keyOf(change.quiet);
          this.editList(QUIET_KEY, QUIET_LOGGED, (keys) => keys.add(key));
          this.setKey();
        }
        if (change.moved) this.moved(change.moved);
        void this.rescan();
      }),
      vscode.workspace.onDidRenameFiles(
        (e) =>
          void renameBackups(backupFolder(context.globalStorageUri), e.files).catch((error: unknown) =>
            log('warn', 'Could not rename the backups of renamed notes', error),
          ),
      ),
      vscode.window.tabGroups.onDidChangeTabs(() => this.setKey()),
      // Another window's change to the lists reaches this one's state with no event of its own.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.setKey();
      }),
      registerCommand('compareWithBackup', (uri) => this.compareWithBackup(uri)),
      { dispose: () => this.heldTabs.clear() },
    );
  }

  // ---------------------------------------------------------------------------
  // Comparing

  /**
   * Opens the comparison of the backup `named` with the user's text in `document`, or, where the
   * backup was renamed with its note since, of the two where they are now. Its kind is read from
   * its name. Says so, naming the backup's place, when VS Code could not open it.
   */
  async compareBackup(named: string, document: vscode.TextDocument): Promise<void> {
    const moved = this.movedTo.get(named);
    const path = moved?.path ?? named;
    const kind = readBackupName(fileNameOf(vscode.Uri.file(path)))?.kind ?? null;
    try {
      await this.openDiff(vscode.Uri.file(path), moved?.note ?? document.uri, kind, this.versionNameOf(path));
    } catch (error) {
      log('error', 'Could not open the comparison', error);
      void vscode.window.showErrorMessage(plainNotice(`Could not open the comparison. The backup is at ${path}.`));
    }
  }

  /**
   * Whether the backup `named` (or where it was moved with its note since) may still be there to
   * compare: false only where VS Code says nothing is there (mayBeThere).
   */
  stillThere(named: string): Promise<boolean> {
    return mayBeThere(vscode.Uri.file(this.movedTo.get(named)?.path ?? named));
  }

  /** Where a backup (renamed or not) or an unsaved held tab lives now, for diff title-bar matching. */
  versionUri(backupPath: string | null, text: string | null): vscode.Uri | null {
    if (backupPath !== null) return vscode.Uri.file(this.movedTo.get(backupPath)?.path ?? backupPath);
    if (text === null) return null;
    const shown = this.heldTabs.get(text);
    return shown && !shown.isClosed ? shown.uri : null;
  }

  /**
   * A version kept in memory because no backup could be written: opened at once in a new unsaved
   * tab beside the note, the focus left where it is. Opening it again reuses that tab while it
   * still holds the text.
   */
  async showVersion(text: string): Promise<vscode.TextDocument | null> {
    const shown = this.heldTabs.get(text);
    if (shown && !shown.isClosed && shown.getText() === text) return shown;
    try {
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: false,
      });
      this.heldTabs.set(text, doc);
      return doc;
    } catch (error) {
      log('error', 'Could not open a version kept in memory in a new tab', error);
      return null;
    }
  }

  /**
   * Compare for a version kept in memory: its unsaved tab (opened again if it was closed) against the
   * note, the version named as its message names it (`versionName`) where that is otherwise than its kind.
   */
  async compareVersion(
    text: string,
    kind: BackupKind,
    document: vscode.TextDocument,
    versionName: VersionName | null,
  ): Promise<void> {
    const held = await this.showVersion(text);
    if (!held) return;
    try {
      await this.openDiff(held.uri, document.uri, kind, versionName);
    } catch (error) {
      log('error', 'Could not open the comparison', error);
    }
  }

  /**
   * VS Code's diff: the version at `version` (read-only in the diff editor, on the left) against the
   * note at `note`, the title naming both; the right side is the user's text while a document of
   * the note is open.
   */
  private async openDiff(
    version: vscode.Uri,
    note: vscode.Uri,
    kind: BackupKind | null,
    versionName: VersionName | null,
  ): Promise<void> {
    const open = vscode.workspace.textDocuments.some((d) => !d.isClosed && sameUri(d.uri, note));
    const title = comparisonTitle(fileNameOf(note), kind, !open, versionName);
    await vscode.commands.executeCommand('vscode.diff', version, note, title, { preview: true });
  }

  // ---------------------------------------------------------------------------
  // Compare with Backup

  /**
   * Compare with Backup, for the note `arg` names (the title bar's button passes it) or the note
   * in the tab the user is in. While the note's backups show the button, the list ends with
   * DONE_ROW, which takes the button away until a message names another backup.
   */
  private async compareWithBackup(arg: unknown): Promise<CompareWithBackupResult> {
    const uri = arg instanceof vscode.Uri ? arg : tabUri(currentTab());
    if (!uri || !this.context) return { rows: [], shown: 0 };
    const name = fileNameOf(uri);
    const files = await noteBackups(backupFolder(this.context.globalStorageUri), uri.toString());
    const showing = () => {
      const hidden = this.buttonless();
      return files.filter((f) => !hidden.has(keyOf(f.path)));
    };
    if (files.length === 0) {
      const message = `${name} has no backups.`;
      void vscode.window.showInformationMessage(plainNotice(message));
      return { message, rows: [], shown: 0 };
    }
    const names = this.versionNames();
    const rowItems: RowItem[] = files.map((file) => ({
      ...backupRow(file.kind, file.mtime, names.get(keyOf(file.path)) ?? null),
      file,
      buttons: [{ iconPath: new vscode.ThemeIcon('copy'), tooltip: COPY_PATH }],
    }));
    const rows = rowItems.map((i) => ({ label: i.label, description: i.description ?? '', path: i.file.path }));
    const doneItem: DoneItem = { ...DONE_ROW, iconPath: new vscode.ThemeIcon('check'), done: true };
    const items: ListItem[] =
      showing().length > 0
        ? [...rowItems, { label: '', kind: vscode.QuickPickItemKind.Separator }, doneItem]
        : rowItems;
    const chosen = await askPick(BACKUP_BUTTON, items, () => pickRow(items));
    if (chosen === doneItem) {
      this.markDone(showing().map((f) => f.path));
      return { rows, done: true, shown: showing().length };
    }
    if (!chosen || !('file' in chosen)) return { rows, shown: showing().length };
    const document =
      vscode.workspace.textDocuments.find((d) => !d.isClosed && sameUri(d.uri, uri)) ??
      (await vscode.workspace.openTextDocument(uri));
    await this.compareBackup(chosen.file.path, document);
    return { rows, opened: chosen.file.path, shown: showing().length };
  }

  // ---------------------------------------------------------------------------
  // The button

  /**
   * Backups renamed for their note's new name: whether the user was done with each or it was kept
   * quietly goes with it, and what a message named it.
   */
  private moved(moves: ReadonlyMap<string, MovedBackup>): void {
    for (const [from, to] of moves) {
      for (const [old, now] of this.movedTo) if (now.path === from) this.movedTo.set(old, to);
      this.movedTo.set(from, to);
      this.movedTo.delete(to.path);
    }
    this.editVersionNames((names) => {
      for (const [from, to] of moves) {
        const name = names.get(keyOf(from));
        if (name === undefined) continue;
        names.delete(keyOf(from));
        names.set(keyOf(to.path), name);
      }
    });
    this.editList(DONE_KEY, DONE_LOGGED, (keys) => rekey(keys, moves));
    this.editList(QUIET_KEY, QUIET_LOGGED, (keys) => rekey(keys, moves));
  }

  /**
   * The backup a message names at `path` (or where it was moved with its note since), as the message
   * names it where that is otherwise than its kind (conflictVersionName): its comparison's title and
   * its row in the list say the same, in every window and after a restart.
   */
  nameAs(path: string, versionName: VersionName): void {
    const key = keyOf(this.movedTo.get(path)?.path ?? path);
    this.editVersionNames((names) => names.set(key, versionName));
  }

  /** What a message named the backup at `path`, where it named it otherwise than its kind. */
  private versionNameOf(path: string): VersionName | null {
    return this.versionNames().get(keyOf(path)) ?? null;
  }

  /**
   * A backup that a message or warning has now named to the user, kept quietly or done with before:
   * it shows the backups button, as any backup a message named does.
   */
  told(path: string): void {
    const key = keyOf(path);
    const quiet = this.editList(QUIET_KEY, QUIET_LOGGED, (keys) => keys.delete(key));
    const done = this.editList(DONE_KEY, DONE_LOGGED, (keys) => keys.delete(key));
    if (quiet || done) this.setKey();
  }

  /**
   * The backups that do not show the backups button: those kept quietly, since no message told the
   * user of them, and those the user is done with.
   */
  private buttonless(): Set<string> {
    return new Set([...this.listed(QUIET_KEY), ...this.listed(DONE_KEY)]);
  }

  /** The user is done with the backups at `paths` (DONE_ROW): they no longer show the button. */
  private markDone(paths: readonly string[]): void {
    this.editList(DONE_KEY, DONE_LOGGED, (keys) => {
      for (const path of paths) keys.add(keyOf(path));
    });
    this.setKey();
  }

  /** Reads the folder again, and lets go of what the global state keeps of backups no longer in it. */
  private async rescan(): Promise<void> {
    if (!this.context) return;
    const seq = ++this.scan;
    // Taken before the read: a backup another window lists after it is one written after it,
    // which the read may not find.
    const done = this.listed(DONE_KEY);
    const quiet = this.listed(QUIET_KEY);
    const named = [...this.versionNames().keys()];
    const files = await backupFiles(backupFolder(this.context.globalStorageUri));
    if (seq !== this.scan) return;
    this.files = files;
    const present = new Set(files.map((f) => keyOf(f.path)));
    const letGo = (listed: Iterable<string>, from: Set<string> | Map<string, VersionName>) => {
      for (const key of listed) if (!present.has(key)) from.delete(key);
    };
    this.editList(DONE_KEY, DONE_LOGGED, (keys) => letGo(done, keys));
    this.editList(QUIET_KEY, QUIET_LOGGED, (keys) => letGo(quiet, keys));
    this.editVersionNames((names) => letGo(named, names));
    this.setKey();
  }

  /** Sets the button's condition: the open tabs whose note has a backup that shows it (`buttonless`). */
  private setKey(): void {
    const hidden = this.buttonless();
    const tags = new Set(this.files.filter((f) => f.tag !== null && !hidden.has(keyOf(f.path))).map((f) => f.tag));
    const shown = new Set<string>();
    if (tags.size > 0)
      for (const group of vscode.window.tabGroups.all)
        for (const tab of group.tabs) {
          const uri = tabUri(tab);
          if (uri && tags.has(pathTag(uri.toString()))) shown.add(uri.toString());
        }
    setContextKey(BUTTON_KEY, [...shown].sort());
  }

  // ---------------------------------------------------------------------------
  // What the global state keeps

  // Every window of VS Code shares the extension's global state: VS Code (1.120 and 1.146) passes one
  // window's write on to the others' (its MainThreadStorage's `$acceptValue`). So no list is kept here: each
  // is read where it is used, and changed by this window's own additions and removals, made to what
  // the state holds at that moment, so that another window's stay.

  /** The backups listed under `key` (DONE_KEY, QUIET_KEY), as the global state holds them now. */
  private listed(key: string): Set<string> {
    const value = this.context?.globalState.get<unknown>(key);
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  }

  /** Changes the list under `key` by `edit`, made to what the state holds now; true when it changed. */
  private editList(key: string, logged: string, edit: (keys: Set<string>) => unknown): boolean {
    const keys = this.listed(key);
    const before = [...keys].join('\u0000');
    edit(keys);
    if ([...keys].join('\u0000') === before) return false;
    this.store(key, [...keys], logged);
    return true;
  }

  /** What a message named each backup it named otherwise than its kind, as the global state holds it now. */
  private versionNames(): Map<string, VersionName> {
    const value = this.context?.globalState.get<unknown>(VERSION_NAMES_KEY);
    const names = new Map<string, VersionName>();
    if (typeof value === 'object' && value !== null)
      for (const [key, name] of Object.entries(value)) if (isVersionName(name)) names.set(key, name);
    return names;
  }

  /** Changes the version names by `edit`, made to what the state holds now. */
  private editVersionNames(edit: (names: Map<string, VersionName>) => unknown): void {
    const names = this.versionNames();
    const before = JSON.stringify([...names]);
    edit(names);
    if (JSON.stringify([...names]) !== before) this.store(VERSION_NAMES_KEY, Object.fromEntries(names), NAMES_LOGGED);
  }

  private store(key: string, value: unknown, logged: string): void {
    void Promise.resolve(this.context?.globalState.update(key, value)).catch((error: unknown) =>
      log('warn', `Could not remember ${logged}`, error),
    );
  }
}

/** Moves each key in `keys` (`vscode.Uri.file(path).toString()`) that `moves` renames to its new path. */
function rekey(keys: Set<string>, moves: ReadonlyMap<string, MovedBackup>): void {
  for (const [from, to] of moves) if (keys.delete(keyOf(from))) keys.add(keyOf(to.path));
}

/** Shows the list and resolves with the row chosen; "Copy path" copies a row's path and leaves the list open. */
function pickRow(items: ListItem[]): Promise<ListItem | undefined> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<ListItem>();
    pick.title = BACKUP_BUTTON;
    pick.items = items;
    pick.matchOnDescription = true;
    let chosen: ListItem | undefined;
    pick.onDidTriggerItemButton((e) => {
      if (!('file' in e.item)) return;
      void Promise.resolve(vscode.env.clipboard.writeText(e.item.file.path)).catch((error: unknown) =>
        log('warn', 'Could not copy the path of a backup', error),
      );
    });
    pick.onDidAccept(() => {
      chosen = pick.selectedItems[0];
      pick.hide();
    });
    pick.onDidHide(() => {
      pick.dispose();
      resolve(chosen);
    });
    pick.show();
  });
}

/** The one instance. It does nothing until `start`. */
export const backupViews = new BackupViews();
