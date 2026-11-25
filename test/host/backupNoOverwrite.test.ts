// A backup is never written over. A new backup takes the next free name where a file already has
// the one it would take, and a backup renamed for its note's new name passes over a name whose
// stat fails for any other reason than that nothing is there: in both cases VS Code's stat of the
// file at that name fails as it does for a file it may not read. The files are real, in a
// temporary folder; VS Code's rename stands in as Node's, which writes over a file.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { backupFolder, pathTag, renameBackups, writeBackup } from '../../src/host/backups';
import { backupName, backupStamp, kindOfLabel, renamedBackupName } from '../../src/host/model/backupNames';
import { Uri } from './vscodeStandIn';

/** The files whose stat fails as for a file VS Code may not read. */
const unseen = vi.hoisted(() => new Set<string>());

vi.mock('vscode', async () => {
  const { Disposable, EventEmitter, Uri } = await import('./vscodeStandIn');
  const fs = await import('node:fs/promises');
  const FileType = { File: 1, Directory: 2 };
  return {
    Disposable,
    EventEmitter,
    Uri,
    FileType,
    workspace: {
      fs: {
        createDirectory: (uri: { fsPath: string }) => fs.mkdir(uri.fsPath, { recursive: true }),
        rename: (from: { fsPath: string }, to: { fsPath: string }) => fs.rename(from.fsPath, to.fsPath),
        stat: async (uri: { fsPath: string }) => {
          if (unseen.has(uri.fsPath)) throw Object.assign(new Error('no permission'), { code: 'NoPermissions' });
          const s = await fs.stat(uri.fsPath).catch(() => {
            throw Object.assign(new Error('not found'), { code: 'FileNotFound' });
          });
          return { type: s.isDirectory() ? FileType.Directory : FileType.File, mtime: s.mtimeMs };
        },
        readDirectory: async (uri: { fsPath: string }) =>
          (await fs.readdir(uri.fsPath, { withFileTypes: true })).map((d) => [
            d.name,
            d.isDirectory() ? FileType.Directory : FileType.File,
          ]),
      },
    },
  };
});
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const root = mkdtempSync(path.join(tmpdir(), 'tandem-backup-names-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  unseen.clear();
  vi.useRealTimers();
});
const notes = path.join(root, 'notes');
const folder = backupFolder(Uri.file(path.join(root, 'storage')) as never);
const bytes = (text: string) => new TextEncoder().encode(text);

describe('a backup name a file already has', () => {
  it('is passed over by a new backup, which leaves that file as it is', async () => {
    const now = new Date(2026, 10, 19, 9, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const note = Uri.file(path.join(notes, 'Field notes.md'));
    const first = path.join(
      folder.fsPath,
      backupName('Field notes.md', kindOfLabel('yours'), pathTag(note.toString()), backupStamp(now), 1),
    );
    mkdirSync(folder.fsPath, { recursive: true });
    writeFileSync(first, 'Already here.\n');
    unseen.add(first);

    const written = await writeBackup(folder as never, 'Field notes.md', note.toString(), bytes('Mine.\n'), 'yours');
    expect(written).not.toBe(first);
    expect(readFileSync(first, 'utf8')).toBe('Already here.\n');
    expect(readFileSync(written, 'utf8')).toBe('Mine.\n');
  });

  it('is passed over by a backup renamed for its note, which leaves that file as it is', async () => {
    const before = Uri.file(path.join(notes, 'Draft.md'));
    const after = Uri.file(path.join(notes, 'Letter.md'));
    const kept = await writeBackup(folder as never, 'Draft.md', before.toString(), bytes('Kept.\n'), 'yours');
    mkdirSync(notes, { recursive: true });
    writeFileSync(after.fsPath, 'The note, at its new path.\n');
    const taken = path.join(
      folder.fsPath,
      renamedBackupName(path.basename(kept), 'Letter.md', pathTag(after.toString()))!,
    );
    writeFileSync(taken, 'Another backup.\n');
    unseen.add(taken);

    await renameBackups(folder as never, [{ oldUri: before as never, newUri: after as never }]);
    expect(readFileSync(taken, 'utf8')).toBe('Another backup.\n');
    const moved = path.join(
      folder.fsPath,
      renamedBackupName(path.basename(kept), 'Letter.md', pathTag(after.toString()), 2)!,
    );
    expect(readFileSync(moved, 'utf8')).toBe('Kept.\n');
  });
});
