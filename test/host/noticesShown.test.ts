import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreNotice, DocumentCoordinator } from '../../src/core/coordinator';
import { DISMISS, SEE_DIFF, conflictText } from '../../src/host/model/messageForms';
import { openNote, until } from './helpers';
import { shown } from './hostStandIns';

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));
vi.mock('../../src/host/backupViews', async () => (await import('./hostStandIns')).backupViews);
vi.mock('../../src/host/conflictViews', async () => (await import('./hostStandIns')).conflictViews);
vi.mock('../../src/host/conflictFiles', async () => (await import('./hostStandIns')).conflictFiles);

type Vs = { __state: { warnings: { message: string; items: string[] }[] }; Uri: { file(p: string): unknown } };

const openedIds: string[] = [];

afterEach(async () => {
  const { messages } = await import('../../src/host/messages');
  for (const id of openedIds.splice(0)) messages.answerNotice(id, DISMISS);
  shown.versions.length = 0;
  shown.compared.length = 0;
  shown.parts.length = 0;
});

const note = (vscode: Vs) => ({
  ...openNote(vscode.Uri.file('/notes/Field notes.md'), '- buy candles\n- call Sam on Friday\n'),
  version: 1,
  isDirty: true,
  encoding: 'utf8',
});

describe('showCoreNotice', () => {
  it('opens a conflict message with See Diff and Dismiss, and offers the diff choice', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    shown.added = 'written';

    let used = false;
    const coordinator = {
      offers: () => !used,
      noticeClosed: () => undefined,
      useFileVersion: async () => {
        used = true;
        return true;
      },
    } as unknown as DocumentCoordinator;

    const notice: Extract<CoreNotice, { kind: 'conflict' }> = {
      kind: 'conflict',
      id: 'c-clash-1',
      reason: 'clash',
      restMerged: true,
      savedOver: false,
      backupPath: '/backups/theirs.md',
      diskText: '- buy candles\n- call Sam on Saturday\n',
      baseText: '- buy candles\n- call Sam\n',
      noteText: '- buy candles\n- call Sam on Friday\n',
      passages: [
        {
          at: 'after',
          line: '- buy candles',
          yours: '- call Sam on Friday',
          theirs: '- call Sam on Saturday',
          lineNumber: 1,
        },
      ],
      choice: 'use',
    };
    openedIds.push(notice.id);
    showCoreNotice(notice, { document: note(vscode) as never, coordinator: () => coordinator });
    await until(() => messages.askedFor(notice.id) !== undefined);
    expect(messages.askedFor(notice.id)).toEqual({
      text: conflictText('Field notes.md', notice),
      items: [SEE_DIFF, DISMISS],
    });
    expect(await messages.answerChoice(notice.id)).toBe(true);
    expect(used).toBe(true);
  });

  it('opens an unsaved tab immediately when a conflict could not write a backup, and compares it', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    shown.added = 'none';

    const version = '- buy candles\n- call Sam on Saturday\n';
    const coordinator = {
      offers: () => true,
      noticeClosed: () => undefined,
      replaceNote: async () => false,
    } as unknown as DocumentCoordinator;

    const notice: Extract<CoreNotice, { kind: 'conflict' }> = {
      kind: 'conflict',
      id: 'c-nobackup-1',
      reason: 'noBase',
      restMerged: false,
      savedOver: false,
      backupPath: null,
      diskText: version,
      baseText: null,
      noteText: '- buy candles\n',
      passages: [],
      choice: 'replace',
    };
    openedIds.push(notice.id);
    showCoreNotice(notice, { document: note(vscode) as never, coordinator: () => coordinator });
    await until(() => messages.askedFor(notice.id) !== undefined);
    expect(shown.versions).toEqual([version]);
    expect(messages.answerNotice(notice.id, SEE_DIFF)).toBe(true);
    await until(() => shown.compared.length > 0);
    expect(shown.compared).toEqual([version]);
  });

  it('writes a quiet conflict part for truncatedFollow without popping up a user message', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    shown.added = 'written';

    const notice: CoreNotice = {
      kind: 'truncatedFollow',
      id: 'tf-1',
      backupPath: '/backups/beforeRemoval.md',
      previousText: 'line1\nline2\n',
      diskText: 'line1\nli',
    };
    showCoreNotice(notice, {
      document: note(vscode) as never,
      coordinator: () => ({ synced: () => ({ version: 1, text: '' }) }) as unknown as DocumentCoordinator,
    });
    await until(() => shown.parts.length > 0);
    expect(messages.askedFor(notice.id)).toBeUndefined();
    expect(shown.parts[0]!.facts).toMatchObject({ kind: 'truncatedFollow', backupPath: '/backups/beforeRemoval.md' });
  });
});
