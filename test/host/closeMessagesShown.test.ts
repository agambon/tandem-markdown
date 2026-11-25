import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreNotice, DocumentCoordinator } from '../../src/core/coordinator';
import { DISMISS, SEE_DIFF, closedWithPendingText } from '../../src/host/model/messageForms';
import { openNote, until } from './helpers';
import { shown } from './hostStandIns';

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));
vi.mock('../../src/host/backupViews', async () => (await import('./hostStandIns')).backupViews);
vi.mock('../../src/host/conflictViews', async () => (await import('./hostStandIns')).conflictViews);
vi.mock('../../src/host/conflictFiles', async () => (await import('./hostStandIns')).conflictFiles);

type Vs = { Uri: { file(p: string): unknown } };
const F = 'Field notes.md';
const BEFORE = '- buy candles\n';
const VERSION = '- buy candles\n- call Sam\n';

let made = 0;
const openedIds: string[] = [];

function closedNotice(backupPath: string | null): Extract<CoreNotice, { kind: 'closedWithPending' }> {
  return {
    kind: 'closedWithPending',
    id: `cl-${++made}`,
    backupPath,
    diskText: VERSION,
  };
}

beforeEach(() => {
  shown.added = 'none';
  shown.versions.length = 0;
  shown.compared.length = 0;
});

afterEach(async () => {
  const { messages } = await import('../../src/host/messages');
  for (const id of openedIds.splice(0)) messages.answerNotice(id, DISMISS);
});

describe('closedWithPending notices', () => {
  it('opens an unsaved tab when backup failed and offers See Diff and Dismiss', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    const n = closedNotice(null);
    openedIds.push(n.id);
    const document = {
      ...openNote(vscode.Uri.file(`/notes/${F}`), BEFORE),
      isClosed: true,
      isDirty: false,
      version: 1,
    };
    showCoreNotice(n, { document: document as never, coordinator: () => ({}) as DocumentCoordinator });
    await until(() => messages.askedFor(n.id) !== undefined);
    expect(shown.versions).toEqual([VERSION]);
    expect(messages.askedFor(n.id)).toEqual({
      text: closedWithPendingText(F, false),
      items: [SEE_DIFF, DISMISS],
    });
    expect(messages.answerNotice(n.id, SEE_DIFF)).toBe(true);
    await until(() => shown.compared.length > 0);
    expect(shown.compared).toEqual([VERSION]);
  });

  it('does not open an unsaved tab when a backup was saved', async () => {
    const vscode = (await import('vscode')) as unknown as Vs;
    const { showCoreNotice } = await import('../../src/host/notices');
    const { messages } = await import('../../src/host/messages');
    const n = closedNotice('/backups/theirs.md');
    openedIds.push(n.id);
    const document = {
      ...openNote(vscode.Uri.file(`/notes/${F}`), BEFORE),
      isClosed: true,
      isDirty: false,
      version: 1,
    };
    showCoreNotice(n, { document: document as never, coordinator: () => ({}) as DocumentCoordinator });
    await until(() => messages.askedFor(n.id) !== undefined);
    expect(shown.versions).toEqual([]);
    expect(messages.askedFor(n.id)).toEqual({
      text: closedWithPendingText(F, true),
      items: [SEE_DIFF, DISMISS],
    });
  });
});
