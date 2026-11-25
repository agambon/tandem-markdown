import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreNotice, DocumentCoordinator } from '../../src/core/coordinator';
import { DISMISS } from '../../src/host/model/messageForms';
import { openNote, until } from './helpers';
import { shown } from './hostStandIns';

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));
vi.mock('../../src/host/backupViews', async () => (await import('./hostStandIns')).backupViews);
vi.mock('../../src/host/conflictViews', async () => (await import('./hostStandIns')).conflictViews);
vi.mock('../../src/host/conflictFiles', async () => (await import('./hostStandIns')).conflictFiles);

type Vs = { Uri: { file(p: string): unknown } };
const openedIds: string[] = [];

afterEach(async () => {
  const { messages } = await import('../../src/host/messages');
  for (const id of openedIds.splice(0)) messages.answerNotice(id, DISMISS);
  shown.parts.length = 0;
});

const utf16Note = (vscode: Vs, text: string) => ({
  ...openNote(vscode.Uri.file('/notes/Birds.md'), text),
  version: 1,
  isDirty: true,
  encoding: 'utf16le',
});

const coordinator = {
  offers: () => true,
  noticeClosed: () => undefined,
  synced: () => ({ version: 1, text: '' }),
} as unknown as DocumentCoordinator;

describe('conflict file parts carry decoded disk text and encoding for git check', () => {
  it('passes clash passages, backup path, and UTF-16 encoding to conflictFiles.add', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const version = '# Birds\n\nWren\ntheirs\n';
    const notice: CoreNotice = {
      kind: 'conflict',
      id: 'k-1',
      reason: 'clash',
      restMerged: true,
      savedOver: false,
      backupPath: '/backups/theirs.md',
      diskText: version,
      baseText: '# Birds\n\nWren\nbase\n',
      noteText: '# Birds\n\nWren\nmine\n',
      passages: [{ at: 'after', line: 'Wren', yours: 'mine', theirs: 'theirs', lineNumber: 3 }],
      choice: 'use',
    };
    openedIds.push(notice.id);
    showCoreNotice(notice, {
      document: utf16Note(vscode, '# Birds\n\nWren\nmine\n') as never,
      coordinator: () => coordinator,
    });
    await until(() => shown.parts.length > 0);
    expect(shown.parts[0]!.facts).toMatchObject({
      kind: 'clash',
      backupPath: '/backups/theirs.md',
      passages: [{ at: 'after', line: 'Wren', yours: 'mine', theirs: 'theirs', lineNumber: 3 }],
    });
    expect(shown.parts[0]!.written).toMatchObject({ text: version, encoding: 'utf16le' });
  });
});
