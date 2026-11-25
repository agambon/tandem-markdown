// A conflict file's part names the backup its notice kept, which is never pruned while the part
// is open. When that backup is renamed for its note's new name, the part names it under its new
// path, in memory, in the workspace's state and in the list of backups never pruned.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackupsChange } from '../../src/host/backups';
import type { PartFacts } from '../../src/host/model/conflictFile';
import { memento, openNote } from './helpers';

const world = vi.hoisted(() => ({
  /** The listeners given to `onDidChangeBackups`, which a case calls as backups.ts would. */
  backupChanges: [] as ((change: BackupsChange) => void)[],
}));

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/backups', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onDidChangeBackups: (listener: (change: BackupsChange) => void) => {
    world.backupChanges.push(listener);
    return { dispose: () => undefined };
  },
}));
vi.mock('../../src/host/agentInstructions', async () => (await import('./hostStandIns')).agentInstructions);
vi.mock('../../src/host/gitExplains', async () => (await import('./hostStandIns')).gitExplains);
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

interface Vs {
  __state: { documents: unknown[]; folder: unknown };
  Uri: { file(p: string): { fsPath: string; path: string; toString(): string } };
}

const folder = mkdtempSync(path.join(tmpdir(), 'tandem-part-backups-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const NAMED_KEY = 'tandemMarkdown.namedBackups';
const PARTS_KEY = 'tandemMarkdown.conflictParts';

const workspaceState = memento();
const globalState = memento();

const facts: PartFacts = {
  kind: 'handoff',
  reason: 'handoff',
  savedOver: false,
  diskText: 'Measure the north wall.',
  backupPath: null,
};

let vscode: Vs;

beforeAll(async () => {
  vscode = (await import('vscode')) as unknown as Vs;
  vscode.__state.folder = { uri: vscode.Uri.file(folder), name: 'notes', index: 0 };
  const { conflictFiles } = await import('../../src/host/conflictFiles');
  conflictFiles.start({ workspaceState, globalState } as never);
});

describe("a backup a part names, renamed for its note's new name", () => {
  it('is named under its new path by the part and by the list never pruned', async () => {
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Site visit.md');
    writeFileSync(notePath, '## Thursday\n\nMeasure the north wall.\n');
    const note = openNote(vscode.Uri.file(notePath), '## Thursday\n\nMeasure the north wall.\n');
    vscode.__state.documents = [note];
    const before = path.join(
      folder,
      'backups',
      "Field notes.md (other program's version) 2026-11-18 09.00.00 a1b2c3.md",
    );
    const after = path.join(folder, 'backups', "Site visit.md (other program's version) 2026-11-18 09.00.00 d4e5f6.md");
    await conflictFiles.add(note as never, 'kept', facts, [], null, before);
    const named = () => Object.values((globalState.get(NAMED_KEY) ?? {}) as Record<string, string[]>).flat();
    expect(named()).toEqual([vscode.Uri.file(before).toString()]);

    const moved = { path: after, note: vscode.Uri.file(notePath) as never };
    for (const listener of world.backupChanges) listener({ moved: new Map([[before, moved]]) });

    expect(conflictFiles.partsOf(note.uri as never).map((p) => p.backup)).toEqual([after]);
    expect(named()).toEqual([vscode.Uri.file(after).toString()]);
    const keptParts = (workspaceState.get(PARTS_KEY) as { parts: { backup?: string }[] }[]).flatMap((f) => f.parts);
    expect(keptParts.map((p) => p.backup)).toEqual([after]);
  });
});
