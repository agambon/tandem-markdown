// When git's check takes another program's write to have reached the note: the file's modification
// time while it still holds the write's text, read in the note's encoding. A commit made after
// that, as by an agent that writes a note and then commits it, does not explain the write.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { encodeText } from '../../src/core/encoding';
import { git } from './hostStandIns';

vi.mock('vscode', async () => ({ Disposable: (await import('./vscodeStandIn')).Disposable }));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const NEW = '# Field notes\n\nThe heron waited by the reeds.\n';
/** When the write reached the file. */
const WRITTEN_AT = Date.UTC(2026, 10, 19, 9, 0, 0);

/** A repository whose HEAD holds the note's new text, committed a minute after the write. */
const repository = {
  state: { HEAD: { commit: 'head' } },
  show: async () => NEW,
  getCommit: async () => ({ hash: 'head', commitDate: new Date(WRITTEN_AT + 60_000) }),
};
vi.mock('../../src/host/gitApi', async () => (await import('./hostStandIns')).gitApi);
git.repository = repository;

const folder = mkdtempSync(path.join(tmpdir(), 'tandem-git-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('the git check, for a write committed after it reached the file', () => {
  it("does not explain a UTF-16 note's write by a commit made after the file was written", async () => {
    const { gitExplains, startGitExplains } = await import('../../src/host/gitExplains');
    startGitExplains();
    const notePath = path.join(folder, 'Field notes.md');
    writeFileSync(notePath, encodeText(NEW, 'utf16le')!);
    utimesSync(notePath, WRITTEN_AT / 1000, WRITTEN_AT / 1000);
    const note = { scheme: 'file', fsPath: notePath, path: notePath.replace(/\\/g, '/') };
    const write = { text: NEW, seenAt: WRITTEN_AT + 120_000, encoding: 'utf16le' };
    expect(await gitExplains(note as never, write)).toBe(false);
  });
});
