import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreNotice, DocumentCoordinator } from '../../src/core/coordinator';
import { DISMISS, SEE_DIFF, appliedText } from '../../src/host/model/messageForms';
import { openNote, until } from './helpers';
import { shown } from './hostStandIns';

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));
vi.mock('../../src/host/backupViews', async () => (await import('./hostStandIns')).backupViews);
vi.mock('../../src/host/conflictViews', async () => (await import('./hostStandIns')).conflictViews);
vi.mock('../../src/host/conflictFiles', async () => (await import('./hostStandIns')).conflictFiles);

type Vs = { __state: { warnings: { message: string }[] }; Uri: { file(p: string): unknown } };
const F = 'Field notes.md';
const TEXT = '- buy candles\n- call Sam\n';
const openedIds: string[] = [];

afterEach(async () => {
  const { messages } = await import('../../src/host/messages');
  for (const id of openedIds.splice(0)) messages.answerNotice(id, DISMISS);
  shown.versions.length = 0;
  shown.compared.length = 0;
});

function applied(id: string, backupPath: string | null): Extract<CoreNotice, { kind: 'applied' }> {
  return {
    kind: 'applied',
    id,
    how: 'setting',
    backupPath,
    previousText: backupPath === null ? TEXT : null,
    diskBackupPath: null,
    canUndo: true,
  };
}

describe('applied notices with Undo', () => {
  it('offers Undo, See Diff, and Dismiss, and drops Undo once the core no longer offers it', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    const n = applied('u-1', null);
    openedIds.push(n.id);
    let offered = true;
    const coordinator = {
      offers: () => offered,
      noticeClosed: () => undefined,
      undoUsed: async () => false,
    } as unknown as DocumentCoordinator;
    const document = { ...openNote(vscode.Uri.file(`/notes/${F}`), TEXT), version: 1, isDirty: true, encoding: 'utf8' };
    showCoreNotice(n, { document: document as never, coordinator: () => coordinator });
    await until(() => messages.askedFor(n.id) !== undefined);
    expect(messages.askedFor(n.id)).toEqual({
      text: appliedText(F, n),
      items: ['Undo', SEE_DIFF, DISMISS],
    });
    expect(shown.versions).toEqual([TEXT]);

    offered = false;
    messages.refresh(document.uri as never);
    expect(messages.askedFor(n.id)).toEqual({
      text: appliedText(F, n),
      items: [SEE_DIFF, DISMISS],
    });
  });

  it('runs coordinator.undoUsed when Undo is pressed and settles the message', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    const n = applied('u-2', '/backups/yours.md');
    openedIds.push(n.id);
    let undone = false;
    const coordinator = {
      offers: () => !undone,
      noticeClosed: () => undefined,
      undoUsed: async () => {
        undone = true;
        return true;
      },
    } as unknown as DocumentCoordinator;
    const document = { ...openNote(vscode.Uri.file(`/notes/${F}`), TEXT), version: 1, isDirty: true, encoding: 'utf8' };
    showCoreNotice(n, { document: document as never, coordinator: () => coordinator });
    await until(() => messages.askedFor(n.id) !== undefined);
    expect(messages.answerNotice(n.id, 'Undo')).toBe(true);
    await until(() => undone && messages.askedFor(n.id) === undefined);
  });
});
