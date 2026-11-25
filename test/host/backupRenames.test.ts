// A note's backups follow it when VS Code renames the note or a folder holding it: Compare with
// Backup lists them for the note at its new path, each named for the note's new name, the old
// path lists none, and what is remembered of each backup (done with, kept with nothing said) goes
// with it. The backups and the notes are real files in a temporary folder.

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { backupFolder, pathTag, QUIET_KEY, writeBackup } from '../../src/host/backups';
import { backupViews } from '../../src/host/backupViews';
import { DONE_ROW } from '../../src/host/model/backupViews';
import { memento } from './helpers';
import { registered } from './hostStandIns';
import { Uri } from './vscodeStandIn';

const world = vi.hoisted(() => ({
  /** VS Code's rename listeners, which a case calls to report a rename. */
  renamed: [] as ((e: { files: { oldUri: unknown; newUri: unknown }[] }) => void)[],
  /** Every VS Code command run, with its arguments. */
  executed: [] as unknown[][],
  /** A write held in progress: backup writes wait for `done`, and a listing of the folder begun meanwhile lets them go. */
  hold: null as { done: Promise<void>; release: () => void } | null,
  /** How the next list is answered: the row chosen, or none. */
  choose: null as ((items: readonly { label: string }[]) => unknown) | null,
}));

// A backup is written through Node; a write held in progress waits there.
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof FsPromises.writeFile>) => {
      await world.hold?.done;
      return fs.writeFile(...args);
    },
  };
});
vi.mock('vscode', async () => {
  const { Disposable, EventEmitter, Uri } = await import('./vscodeStandIn');
  const fs = await import('node:fs/promises');
  const FileType = { File: 1, Directory: 2 };
  const subscription = { dispose: () => undefined };
  return {
    Disposable,
    EventEmitter,
    Uri,
    FileType,
    ThemeIcon: class {},
    QuickPickItemKind: { Separator: -1 },
    workspace: {
      textDocuments: [],
      fs: {
        createDirectory: (uri: { fsPath: string }) => fs.mkdir(uri.fsPath, { recursive: true }),
        delete: (uri: { fsPath: string }) => fs.rm(uri.fsPath),
        rename: (from: { fsPath: string }, to: { fsPath: string }) => fs.rename(from.fsPath, to.fsPath),
        stat: async (uri: { fsPath: string }) => {
          const s = await fs.stat(uri.fsPath);
          return { type: s.isDirectory() ? FileType.Directory : FileType.File, mtime: s.mtimeMs };
        },
        readDirectory: async (uri: { fsPath: string }) => {
          const hold = world.hold;
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          hold?.release();
          return entries.map((d) => [d.name, d.isDirectory() ? FileType.Directory : FileType.File]);
        },
      },
      onDidRenameFiles: (listener: (e: { files: { oldUri: unknown; newUri: unknown }[] }) => void) => {
        world.renamed.push(listener);
        return subscription;
      },
    },
    window: {
      tabGroups: { all: [], onDidChangeTabs: () => subscription },
      onDidChangeWindowState: () => subscription,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        world.executed.push(args);
      },
    },
  };
});
vi.mock('../../src/host/commandRegistration', async () => (await import('./hostStandIns')).commandRegistration);
vi.mock('../../src/host/contextKeys', async () => (await import('./hostStandIns')).contextKeys);
vi.mock('../../src/host/questions', () => ({
  askPick: async (_title: string, items: readonly { label: string }[]) => world.choose?.(items),
}));
vi.mock('../../src/host/tabs', async () => (await import('./hostStandIns')).tabs);
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const root = mkdtempSync(path.join(tmpdir(), 'tandem-backup-renames-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const notes = path.join(root, 'notes');
const storage = Uri.file(path.join(root, 'storage'));
const folder = backupFolder(storage as never);

/** The extension's global state. */
const globalState = memento();

beforeAll(() => {
  backupViews.start({ globalStorageUri: storage, globalState } as never);
});

interface Listed {
  message?: string;
  rows: { path: string }[];
}

/** What Compare with Backup lists for the note at `notePath`. */
async function listed(notePath: string): Promise<Listed> {
  return (await registered.get('compareWithBackup')!(Uri.file(notePath))) as Listed;
}

/** Chooses "Done with these backups" in Compare with Backup's list for the note at `notePath`. */
async function chooseDone(notePath: string): Promise<void> {
  world.choose = (items) => items.find((item) => item.label === DONE_ROW.label);
  try {
    await listed(notePath);
  } finally {
    world.choose = null;
  }
}

/** Writes the note at `notePath` in the workspace, with a backup of each kind `labels` names. */
async function noteWithBackups(notePath: string, labels: ('yours' | 'beforeRemoval')[]): Promise<string[]> {
  mkdirSync(path.dirname(notePath), { recursive: true });
  writeFileSync(notePath, 'Measure the north wall.\n');
  const key = Uri.file(notePath).toString();
  const paths: string[] = [];
  for (const label of labels)
    paths.push(await writeBackup(folder as never, path.basename(notePath), key, new TextEncoder().encode('x'), label));
  return paths;
}

/** Renames `from` to `to` on disk, as VS Code does, then reports it as VS Code does. */
function rename(from: string, to: string): void {
  renameSync(from, to);
  for (const listener of [...world.renamed]) listener({ files: [{ oldUri: Uri.file(from), newUri: Uri.file(to) }] });
}

const keyOf = (p: string) => Uri.file(p).toString();
const tagOf = (p: string) => pathTag(keyOf(p));

describe('a renamed note', () => {
  it('lists its backups at its new path, named for it, and nothing at the old', async () => {
    const before = path.join(notes, 'Field notes.md');
    const after = path.join(notes, 'Site visit.md');
    await noteWithBackups(before, ['yours', 'yours']);
    expect((await listed(before)).rows).toHaveLength(2);

    rename(before, after);
    await vi.waitFor(async () => expect((await listed(after)).rows).toHaveLength(2), { timeout: 5000 });
    for (const row of (await listed(after)).rows) {
      expect(path.basename(row.path).startsWith('Site visit.md (copy of your text) ')).toBe(true);
      expect(path.basename(row.path)).toContain(` ${tagOf(after)}`);
    }
    expect((await listed(before)).message).toBe('Field notes.md has no backups.');
  });

  it('keeps which of its backups the person was done with and which were kept with nothing said', async () => {
    const before = path.join(notes, 'Ledger.md');
    const after = path.join(notes, 'Accounts.md');
    const [doneWith, quiet] = await noteWithBackups(before, ['yours', 'beforeRemoval']);
    await chooseDone(before);

    rename(before, after);
    await vi.waitFor(async () => expect((await listed(after)).rows).toHaveLength(2), { timeout: 5000 });
    const rows = (await listed(after)).rows.map((r) => r.path);
    const quietNow = rows.find((p) => (globalState.get(QUIET_KEY) as string[]).includes(keyOf(p)));
    expect(quietNow).toBeDefined();
    expect(globalState.get(QUIET_KEY)).not.toContain(keyOf(quiet!));
    const doneNow = rows.find((p) => p !== quietNow)!;
    expect(globalState.get('tandemMarkdown.doneBackups')).toContain(keyOf(doneNow));
    expect(globalState.get('tandemMarkdown.doneBackups')).not.toContain(keyOf(doneWith!));
  });

  it('opens the backup of a message shown before the rename beside the note at its new path', async () => {
    const before = path.join(notes, 'Draft.md');
    const after = path.join(notes, 'Letter.md');
    const [kept] = await noteWithBackups(before, ['yours']);
    rename(before, after);
    await vi.waitFor(async () => expect((await listed(after)).rows).toHaveLength(1), { timeout: 5000 });

    world.executed.length = 0;
    await backupViews.compareBackup(kept!, { uri: Uri.file(before), isClosed: true } as never);
    const [command, left, right, title] = world.executed[0] as [string, { fsPath: string }, { fsPath: string }, string];
    expect(command).toBe('vscode.diff');
    expect(left.fsPath).toBe((await listed(after)).rows[0]!.path);
    expect(right.fsPath).toBe(after);
    expect(title.startsWith('Letter.md: ')).toBe(true);
  });

  it('renames a backup still being written when the rename lands', async () => {
    const before = path.join(notes, 'Inbox.md');
    const after = path.join(notes, 'Filed.md');
    await noteWithBackups(before, []);
    // The write waits, its file not yet in the folder, until the folder is next listed.
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    world.hold = { done, release };
    const writing = writeBackup(folder as never, 'Inbox.md', keyOf(before), new TextEncoder().encode('x'), 'yours');
    rename(before, after);
    await vi.waitFor(async () => expect((await listed(after)).rows).toHaveLength(1), { timeout: 5000 });
    world.hold = null;
    await writing;
    expect((await listed(before)).rows).toEqual([]);
  });
});

describe('a renamed folder', () => {
  it("lists the backups of each note in it at the note's new path", async () => {
    const before = path.join(notes, 'Trips', 'Spring');
    const after = path.join(notes, 'Trips', 'Spring walks');
    await noteWithBackups(path.join(before, 'Day one.md'), ['yours']);
    await noteWithBackups(path.join(before, 'Maps', 'Ridge.md'), ['yours']);

    rename(before, after);
    await vi.waitFor(
      async () => {
        expect((await listed(path.join(after, 'Day one.md'))).rows).toHaveLength(1);
        expect((await listed(path.join(after, 'Maps', 'Ridge.md'))).rows).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    expect((await listed(path.join(before, 'Day one.md'))).rows).toEqual([]);
  });
});
