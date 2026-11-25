// Parts that arrive together, a write that fails at a settle, and a note moved or renamed while
// it has a conflict file: each part is written once, with its own number, beside the note. Two
// parts for one note can be raised close together: one merge gives savedWordsKept for one save
// and, a backup write later, savedWordsLeftOutAgain for another; two quick writes by an agent give
// one each. Each part is added while the file of the other may still be on its way to disk, and
// both must end up in the conflict file and in the open parts, each with its own number; the
// message of each already names the file.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartFacts } from '../../src/host/model/conflictFile';
import { emptyContext, openNote, until } from './helpers';

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/agentInstructions', async () => (await import('./hostStandIns')).agentInstructions);
vi.mock('../../src/host/gitExplains', async () => (await import('./hostStandIns')).gitExplains);
/** Each line conflictFiles logs goes to the listeners a case adds, so a case can wait on one. */
const logs = vi.hoisted(() => ({ listeners: [] as ((message: string) => void)[] }));
vi.mock('../../src/host/log', () => ({
  log: (_level: string, message: string) => {
    for (const listener of logs.listeners) listener(message);
  },
}));

const folder = mkdtempSync(path.join(tmpdir(), 'tandem-conflict-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/**
 * conflictFiles as each case starts it, disposed after the case. Disposing clears the offers it was
 * still waiting to make: an offer is a timer of OFFER_AFTER_MS (conflictFiles.ts) started at each
 * part, and one left from an earlier case (started with real timers) would otherwise fire in the
 * middle of a later case that counts offers, whenever the run is slow enough to reach it.
 */
let started: { dispose(): void } | null = null;

beforeEach(async () => {
  const vscode = (await import('vscode')) as unknown as {
    __state: { folder: unknown };
    Uri: { file(p: string): unknown };
  };
  const { conflictFiles } = await import('../../src/host/conflictFiles');
  vscode.__state.folder = { uri: vscode.Uri.file(folder), name: 'notes', index: 0 };
  started = conflictFiles.start(emptyContext());
});

afterEach(() => {
  logs.listeners.length = 0;
  vi.useRealTimers();
  started?.dispose();
  started = null;
});

const leftOut = (text: string): PartFacts => ({
  kind: 'handoff',
  reason: 'handoff',
  savedOver: false,
  diskText: text,
  backupPath: null,
});

describe('two parts for one note, added at once', () => {
  it('are both written, each with its own number', async () => {
    const vscode = (await import('vscode')) as unknown as {
      __state: { documents: unknown[]; folder: unknown };
      Uri: { file(p: string): { fsPath: string; toString(): string } };
    };
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Field notes.md');
    writeFileSync(notePath, '## Thursday\n');
    const uri = vscode.Uri.file(notePath);
    const document = openNote(uri, '## Thursday\n');
    vscode.__state.documents = [document];

    const added = await Promise.all([
      conflictFiles.add(document as never, 'kept-1', leftOut('Measure the north wall.'), [], null),
      conflictFiles.add(document as never, 'again-2', leftOut('Budget: 4,200.'), [], null),
    ]);
    expect(added).toEqual(['written', 'written']);

    expect(conflictFiles.partsOf(uri as never).map((p) => [p.part.n, p.noticeId])).toEqual([
      [1, 'kept-1'],
      [2, 'again-2'],
    ]);
    const text = readFileSync(`${notePath}.conflict`, 'utf8');
    expect(text).toContain('Measure the north wall.');
    expect(text).toContain('Budget: 4,200.');
  });

  it('writes the file again at the next window focus after a write at a settle failed', async () => {
    const vscode = (await import('vscode')) as unknown as {
      __state: { documents: unknown[]; folder: unknown; focus: ((s: { focused: boolean }) => void) | null };
      Uri: { file(p: string): { fsPath: string; toString(): string } };
    };
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Retry.md');
    const conflictFile = `${notePath}.conflict`;
    writeFileSync(notePath, '## Thursday\n');
    const uri = vscode.Uri.file(notePath);
    const document = openNote(uri, '## Thursday\n');
    vscode.__state.documents = [document];
    await conflictFiles.add(document as never, 'a', leftOut('Measure the north wall.'), [], null);
    await conflictFiles.add(document as never, 'b', leftOut('Budget: 4,200.'), [], null);
    // Something holds the file's name, so the rewrite at the settle cannot replace it.
    rmSync(conflictFile);
    mkdirSync(conflictFile);
    const failed = new Promise<void>((resolve) =>
      logs.listeners.push((message) => {
        if (message.startsWith('Could not write') && message.endsWith('Retry.md.conflict')) resolve();
      }),
    );
    conflictFiles.settle('a');
    expect(conflictFiles.partsOf(uri as never).map((p) => p.noticeId)).toEqual(['b']);
    await failed;
    rmSync(conflictFile, { recursive: true });
    // A focus once the failed write has marked the note writes the file again.
    await until(() => {
      vscode.__state.focus!({ focused: true });
      return existsSync(conflictFile);
    });
    const text = readFileSync(conflictFile, 'utf8');
    expect(text).toContain('Budget: 4,200.');
    expect(text).not.toContain('Measure the north wall.');
  });

  it("moves a note's conflict file and parts with the note when it is renamed", async () => {
    const vscode = (await import('vscode')) as unknown as {
      __state: {
        documents: unknown[];
        renamed: ((e: { files: { oldUri: unknown; newUri: unknown }[] }) => void) | null;
      };
      Uri: { file(p: string): { fsPath: string; toString(): string } };
    };
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const oldPath = path.join(folder, 'Old name.md');
    const newPath = path.join(folder, 'New name.md');
    writeFileSync(oldPath, '## Thursday\n');
    const oldUri = vscode.Uri.file(oldPath);
    const newUri = vscode.Uri.file(newPath);
    const document = openNote(oldUri);
    vscode.__state.documents = [document];
    await conflictFiles.add(document as never, 'r', leftOut('Measure the north wall.'), [], null);
    expect(existsSync(`${oldPath}.conflict`)).toBe(true);
    vscode.__state.renamed!({ files: [{ oldUri, newUri }] });
    expect(conflictFiles.partsOf(oldUri as never)).toEqual([]);
    expect(conflictFiles.partsOf(newUri as never).map((p) => p.noticeId)).toEqual(['r']);
    await until(() => !existsSync(`${oldPath}.conflict`));
    expect(readFileSync(`${newPath}.conflict`, 'utf8')).toContain('"New name.md"');
  });

  it('leaves the conflict file of a deleted note, and stops counting its parts', async () => {
    const vscode = (await import('vscode')) as unknown as {
      __state: { documents: unknown[]; deleted: ((e: { files: unknown[] }) => void) | null };
      Uri: { file(p: string): { fsPath: string; toString(): string } };
    };
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Gone.md');
    writeFileSync(notePath, '## Thursday\n');
    const uri = vscode.Uri.file(notePath);
    const document = openNote(uri);
    vscode.__state.documents = [document];
    await conflictFiles.add(document as never, 'g', leftOut('Measure the north wall.'), [], null);
    rmSync(notePath);
    vscode.__state.deleted!({ files: [uri] });
    expect(conflictFiles.partsOf(uri as never)).toEqual([]);
    expect(existsSync(`${notePath}.conflict`)).toBe(true);
  });

  it('makes the offer of agent instructions only for a part that still stands a moment later', async () => {
    const vscode = (await import('vscode')) as unknown as {
      __state: { documents: unknown[] };
      Uri: { file(p: string): { fsPath: string; toString(): string } };
    };
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const { offerInstructions } = await import('../../src/host/agentInstructions');
    const offered = vi.mocked(offerInstructions);
    const notePath = path.join(folder, 'Offer.md');
    writeFileSync(notePath, '## Thursday\n');
    const uri = vscode.Uri.file(notePath);
    const document = openNote(uri);
    vscode.__state.documents = [document];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      offered.mockClear();
      await conflictFiles.add(document as never, 'soon', leftOut('Measure the north wall.'), [], null);
      conflictFiles.settle('soon');
      vi.advanceTimersByTime(2500);
      expect(offered).not.toHaveBeenCalled();
      await conflictFiles.add(document as never, 'stays', leftOut('Budget: 4,200.'), [], null);
      vi.advanceTimersByTime(1000);
      expect(offered).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      expect(offered).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
