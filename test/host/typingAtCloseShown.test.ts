import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreNotice, DocumentCoordinator, PutBackResult } from '../../src/core/coordinator';
import {
  DISMISS,
  PUT_TYPING_BACK,
  SEE_DIFF,
  typingAtCloseText,
  typingNotBackText,
} from '../../src/host/model/messageForms';
import { openNote, until } from './helpers';
import { shown } from './hostStandIns';

const again = vi.hoisted(() => ({
  note: null as
    null | 'unreadable' | { uri: unknown; isClosed: boolean; isDirty: boolean; version: number; getText(): string },
  commands: [] as unknown[][],
}));

vi.mock('vscode', async () => {
  const standIn = await import('./vscodeStandIn');
  return {
    ...standIn,
    workspace: {
      ...standIn.workspace,
      openTextDocument: async () => {
        if (again.note === 'unreadable') throw new Error('EACCES: permission denied');
        return again.note;
      },
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        again.commands.push(args);
      },
    },
  };
});
vi.mock('../../src/host/log', () => ({ log: () => undefined }));
vi.mock('../../src/host/backupViews', async () => (await import('./hostStandIns')).backupViews);
vi.mock('../../src/host/conflictViews', async () => (await import('./hostStandIns')).conflictViews);
vi.mock('../../src/host/conflictFiles', async () => (await import('./hostStandIns')).conflictFiles);

type Vs = { __state: { warnings: { message: string }[] }; Uri: { file(p: string): unknown } };
const F = 'Field notes.md';
const CLOSED = '- buy candles\n';
const COPY = '- buy candles\n- call Sam\n';

let made = 0;
const openedIds: string[] = [];

function lost(backupPath: string | null): Extract<CoreNotice, { kind: 'typingAtClose' }> {
  return {
    kind: 'typingAtClose',
    id: `t${++made}`,
    backupPath,
    copy: COPY,
    closedText: CLOSED,
    linesChanged: 1,
  };
}

async function showClosed(n: Extract<CoreNotice, { kind: 'typingAtClose' }>, put: PutBackResult = 'done') {
  const vscode = (await import('vscode')) as unknown as Vs;
  const notices = await import('../../src/host/notices');
  const { messages } = await import('../../src/host/messages');
  const { backupViews } = await import('../../src/host/backupViews');
  const told = vi.spyOn(backupViews, 'told');
  openedIds.push(n.id);
  vscode.__state.warnings.length = 0;
  const putBack: [string, string][] = [];
  const reopened = {
    putBack: async (closedText: string, copy: string) => {
      putBack.push([closedText, copy]);
      return put;
    },
  } as unknown as DocumentCoordinator;
  const document = { ...openNote(vscode.Uri.file(`/notes/${F}`), CLOSED), isClosed: true, isDirty: false };
  notices.showCoreNotice(n, {
    document: document as never,
    coordinator: () => ({}) as DocumentCoordinator,
    reopened: () => reopened,
  });
  await until(() => messages.askedFor(n.id) !== undefined);
  const replies = () =>
    vscode.__state.warnings
      .map((w) => w.message)
      .filter((m) => m.startsWith('Nothing') || m.startsWith("VS Code couldn't"));
  return { messages, first: messages.askedFor(n.id)!, putBack, told, replies };
}

beforeEach(() => {
  again.note = null;
  again.commands.length = 0;
  shown.versions.length = 0;
  shown.compared.length = 0;
});

afterEach(async () => {
  const { messages } = await import('../../src/host/messages');
  for (const id of openedIds.splice(0)) messages.answerNotice(id, DISMISS);
});

describe('typingAtClose messages', () => {
  it('offers Put My Typing Back, See Diff, and Dismiss, and tells backupViews about the backup', async () => {
    const n = lost('/backups/yours.md');
    const { first, messages, told } = await showClosed(n);
    expect(first).toEqual({ text: typingAtCloseText(F, 1, true), items: [PUT_TYPING_BACK, SEE_DIFF, DISMISS] });
    expect(told).toHaveBeenCalledWith('/backups/yours.md');
    expect(messages.answerNotice(n.id, SEE_DIFF)).toBe(true);
    expect(messages.askedFor(n.id)).toEqual(first);
  });

  it('opens an unsaved tab immediately when no backup could be written', async () => {
    const n = lost(null);
    const { messages } = await showClosed(n);
    expect(shown.versions).toEqual([COPY]);
    expect(messages.answerNotice(n.id, SEE_DIFF)).toBe(true);
    await until(() => shown.compared.length > 0);
    expect(shown.compared).toEqual([COPY]);
  });

  it('reopens in the rich editor and restores typing when note matches closedText', async () => {
    again.note = { ...openNote('/notes/Field notes.md', CLOSED), isDirty: false, version: 1 };
    const n = lost('/backups/yours.md');
    const { messages, putBack } = await showClosed(n);
    expect(messages.answerNotice(n.id, PUT_TYPING_BACK)).toBe(true);
    await until(() => messages.askedFor(n.id) === undefined);
    expect(again.commands.map((c) => c.slice(0, 1).concat(c.slice(2, 3)))).toEqual([
      ['vscode.openWith', 'tandemMarkdown.editor'],
    ]);
    expect(putBack).toEqual([[CLOSED, COPY]]);
  });

  it('removes Put My Typing Back when the note changed after close', async () => {
    again.note = { ...openNote('/notes/Field notes.md', 'another program wrote this\n'), isDirty: false, version: 1 };
    const n = lost(null);
    const { messages, putBack, replies } = await showClosed(n);
    expect(messages.answerNotice(n.id, PUT_TYPING_BACK)).toBe(true);
    await until(() => replies().length > 0);
    expect(replies()).toEqual([typingNotBackText(F, 'changed')]);
    expect(messages.askedFor(n.id)?.items).toEqual([SEE_DIFF, DISMISS]);
    expect(again.commands).toEqual([]);
    expect(putBack).toEqual([]);
  });

  it('keeps Put My Typing Back for retry when VS Code cannot open or apply', async () => {
    again.note = 'unreadable';
    const n = lost('/backups/yours.md');
    const { first, messages, replies } = await showClosed(n);
    expect(messages.answerNotice(n.id, PUT_TYPING_BACK)).toBe(true);
    await until(() => replies().length > 0);
    expect(replies()).toEqual([typingNotBackText(F, 'refused')]);
    expect(messages.askedFor(n.id)).toEqual(first);
  });
});
