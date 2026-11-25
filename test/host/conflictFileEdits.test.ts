// What happens to a conflict file's parts as the user works on: a part stands while they type
// in the note (its warning moves with the lines above it), a note renamed in VS Code takes its
// parts and its conflict file with it, whatever the letter case of the new name, and a conflict
// file deleted by the user clears its parts even when VS Code's watcher reports no deletion.

import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PartFacts } from '../../src/host/model/conflictFile';
import { emptyContext, openNote, until } from './helpers';

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/agentInstructions', async () => (await import('./hostStandIns')).agentInstructions);
vi.mock('../../src/host/gitExplains', async () => (await import('./hostStandIns')).gitExplains);
/** Every message logged. */
const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../src/host/log', () => ({
  log: (_level: string, message: string) => {
    logged.push(message);
  },
}));

const folder = mkdtempSync(path.join(tmpdir(), 'tandem-edits-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

interface Vs {
  __state: {
    documents: unknown[];
    folder: unknown;
    edited: ((e: unknown) => void) | null;
    renamed: ((e: { files: { oldUri: unknown; newUri: unknown }[] }) => void) | null;
    watcherDeleted: ((uri: unknown) => void) | null;
  };
  Uri: { file(p: string): { fsPath: string; path: string; toString(): string } };
}

const NOTE_TEXT = ['## Thursday', '', 'Measure the north wall.', ''].join(String.fromCharCode(10));

const leftOut = (text: string): PartFacts => ({
  kind: 'handoff',
  reason: 'handoff',
  savedOver: false,
  diskText: text,
  backupPath: null,
});

function documentAt(vscode: Vs, notePath: string) {
  return openNote(vscode.Uri.file(notePath), NOTE_TEXT);
}

/** The note at `notePath`, written and open in VS Code. */
function noteOpenAt(vscode: Vs, notePath: string) {
  writeFileSync(notePath, NOTE_TEXT);
  const document = documentAt(vscode, notePath);
  vscode.__state.documents = [document];
  return document;
}

/** Renames the note `oldDocument` to `newPath` and reports it as VS Code does; the uri it has after. */
function renameInVsCode(vscode: Vs, oldDocument: ReturnType<typeof documentAt>, newPath: string) {
  renameSync(oldDocument.uri.fsPath, newPath);
  const newUri = vscode.Uri.file(newPath);
  vscode.__state.documents = [documentAt(vscode, newPath)];
  vscode.__state.renamed!({ files: [{ oldUri: oldDocument.uri, newUri }] });
  return newUri;
}

/**
 * Gives the note `document` a part, settles it so that its conflict file is deleted, and writes the
 * file again with a second part, before VS Code's watcher reports the deletion.
 */
async function writtenAgain(document: ReturnType<typeof documentAt>): Promise<void> {
  const { conflictFiles } = await import('../../src/host/conflictFiles');
  await conflictFiles.add(document as never, 'first', leftOut('Measure the north wall.'), [], null);
  conflictFiles.settle('first');
  await until(() => !existsSync(`${document.uri.fsPath}.conflict`));
  await conflictFiles.add(document as never, 'second', leftOut('Paint the gate.'), [], null);
}

/**
 * Resolves once the write a rename in place queues last, under the note's new name `notePath`, is
 * done, and fails unless it was written: its conflict file names the note in that letter case.
 * Each look reads the file, which on Windows refuses that write for a moment; the write waits it out.
 */
async function renameWritten(notePath: string): Promise<void> {
  const conflictFile = `${notePath}.conflict`;
  const failed = () => logged.includes(`Could not write ${conflictFile}`);
  const named = () => {
    try {
      return readFileSync(conflictFile, 'utf8').includes(`"${path.basename(notePath)}"`);
    } catch {
      return false;
    }
  };
  await until(() => failed() || named());
  expect(failed()).toBe(false);
}

/** Whether the folder's file system tells names apart by letter case. */
function caseSensitive(): boolean {
  const probe = path.join(folder, 'case-probe');
  writeFileSync(probe, '');
  const sensitive = !existsSync(path.join(folder, 'CASE-PROBE'));
  rmSync(probe);
  return sensitive;
}

beforeAll(async () => {
  const vscode = (await import('vscode')) as unknown as Vs;
  vscode.__state.folder = { uri: vscode.Uri.file(folder), name: 'notes', index: 0 };
  const { conflictFiles } = await import('../../src/host/conflictFiles');
  conflictFiles.start(emptyContext());
});

describe('a part the user types beside', () => {
  it('still gets the offer of agent instructions a moment later', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const { offerInstructions } = await import('../../src/host/agentInstructions');
    const offered = vi.mocked(offerInstructions);
    const notePath = path.join(folder, 'Typing.md');
    const document = noteOpenAt(vscode, notePath);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      offered.mockClear();
      await conflictFiles.add(
        document as never,
        'typed',
        leftOut('Measure the north wall.'),
        [{ line: 2, text: 'Both edited here.' }],
        null,
      );
      // The user goes on typing on the first line, as they were when the part came.
      vscode.__state.edited!({
        document,
        contentChanges: [{ range: { start: { line: 0 }, end: { line: 0 } }, text: 'x' }],
      });
      vi.advanceTimersByTime(2500);
      expect(conflictFiles.partsOf(document.uri as never).map((p) => p.noticeId)).toEqual(['typed']);
      expect(offered).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a note renamed in VS Code to the same name in another letter case', () => {
  it.skipIf(caseSensitive())('keeps its conflict file and its parts', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const oldPath = path.join(folder, 'field notes.md');
    const newPath = path.join(folder, 'Field notes.md');
    const oldDocument = noteOpenAt(vscode, oldPath);
    await conflictFiles.add(oldDocument as never, 'cased', leftOut('Measure the north wall.'), [], null);
    expect(readdirSync(folder)).toContain('field notes.md.conflict');
    // VS Code renames the note, then reports it.
    const newUri = renameInVsCode(vscode, oldDocument, newPath);
    // Whatever the rename's own writes did, one file stands once they are done.
    await renameWritten(newPath);
    expect(readdirSync(folder).filter((n) => n.toLowerCase() === 'field notes.md.conflict')).toHaveLength(1);
    expect(conflictFiles.partsOf(newUri as never).map((p) => p.noticeId)).toEqual(['cased']);
  });

  it.skipIf(caseSensitive())(
    'takes a deletion of the file under its new name, just after, for the user clearing it',
    async () => {
      const vscode = (await import('vscode')) as unknown as Vs;
      const { conflictFiles } = await import('../../src/host/conflictFiles');
      const oldPath = path.join(folder, 'second note.md');
      const newPath = path.join(folder, 'Second note.md');
      const oldDocument = noteOpenAt(vscode, oldPath);
      await conflictFiles.add(oldDocument as never, 'cleared', leftOut('Measure the north wall.'), [], null);
      const newUri = renameInVsCode(vscode, oldDocument, newPath);
      await renameWritten(newPath);
      expect(conflictFiles.partsOf(newUri as never).map((p) => p.noticeId)).toEqual(['cleared']);
      // No event has come for the rename in place (the watcher may report none for a change of
      // letter case). The user deletes the file under its new name a moment later: that clears
      // its parts.
      rmSync(`${newPath}.conflict`);
      vscode.__state.watcherDeleted!(vscode.Uri.file(`${newPath}.conflict`));
      expect(conflictFiles.partsOf(newUri as never)).toEqual([]);
    },
  );
});

describe('a conflict file deleted by the user', () => {
  it('clears its parts when deleted just after it was written, with no event from the watcher', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Swallowed.md');
    const document = noteOpenAt(vscode, notePath);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await conflictFiles.add(document as never, 'swallowed', leftOut('Measure the north wall.'), [], null);
      // VS Code's watcher drops a creation and a deletion of one file in the same batch.
      rmSync(`${notePath}.conflict`);
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    await until(() => conflictFiles.partsOf(document.uri as never).length === 0);
    expect(existsSync(`${notePath}.conflict`)).toBe(false);
  });

  it('clears its parts when deleted after a write that followed a deletion of its own', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Written again.md');
    const document = noteOpenAt(vscode, notePath);
    // Its last part settles, so the file is deleted; a new part writes it again before the
    // watcher reports that deletion, and the watcher drops the two events as one batch.
    await writtenAgain(document);
    expect(existsSync(`${notePath}.conflict`)).toBe(true);
    // The user deletes it: the deletion this extension was waiting for is this one.
    rmSync(`${notePath}.conflict`);
    vscode.__state.watcherDeleted!(vscode.Uri.file(`${notePath}.conflict`));
    await until(() => conflictFiles.partsOf(document.uri as never).length === 0);
  });

  it('keeps its parts when the deletion of its own is reported after the file was written again', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { conflictFiles } = await import('../../src/host/conflictFiles');
    const notePath = path.join(folder, 'Late event.md');
    const document = noteOpenAt(vscode, notePath);
    await writtenAgain(document);
    // The watcher reports the deletion of its own only now, with the file there again.
    vscode.__state.watcherDeleted!(vscode.Uri.file(`${notePath}.conflict`));
    // A third part's write comes after that report's look in the note's queue of writes.
    await conflictFiles.add(document as never, 'third', leftOut('Order the gravel.'), [], null);
    expect(conflictFiles.partsOf(document.uri as never).map((p) => p.noticeId)).toEqual(['second', 'third']);
    expect(existsSync(`${notePath}.conflict`)).toBe(true);
  });
});
