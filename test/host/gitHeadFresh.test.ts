// Git explains a write when the file's new text is the file at HEAD and HEAD's commit was made
// before the write: a checkout, a pull, a reset. The git extension's own view of the repository
// (`state.HEAD`) is refreshed only after its watcher has seen the change and its status has run,
// which comes after a checkout's files have already changed on disk; the note's notice comes
// first. The check must ask git for HEAD as it is, not as the extension last saw it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { git } from './hostStandIns';

vi.mock('vscode', async () => ({ Disposable: (await import('./vscodeStandIn')).Disposable }));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const OLD = '# Field notes\n\nThe heron waited by the reeds.\n';
const NEW = '# Field notes\n\nThe heron waited by the reeds.\n\nThe branch adds this line.\n';
const DAY = 24 * 60 * 60 * 1000;

/** A repository just checked out from `old` to `new`, whose extension view still says `old`. */
const repository = {
  state: { HEAD: { commit: 'old' } },
  show: async (ref: string) => (ref === 'old' ? OLD : NEW),
  getCommit: async (ref: string) => ({
    hash: ref === 'HEAD' ? 'new' : ref,
    commitDate: new Date(Date.now() - (ref === 'old' ? 2 : 1) * DAY),
  }),
};
vi.mock('../../src/host/gitApi', async () => (await import('./hostStandIns')).gitApi);
git.repository = repository;

const folder = mkdtempSync(path.join(tmpdir(), 'tandem-git-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('the git check, just after a checkout', () => {
  it('explains the write by the commit now at HEAD', async () => {
    const { gitExplains, startGitExplains } = await import('../../src/host/gitExplains');
    startGitExplains();
    const notePath = path.join(folder, 'Field notes.md');
    writeFileSync(notePath, NEW);
    const note = { scheme: 'file', fsPath: notePath, path: notePath.replace(/\\/g, '/') };
    expect(await gitExplains(note as never, { text: NEW, seenAt: Date.now(), encoding: 'utf8' })).toBe(true);
  });
});
