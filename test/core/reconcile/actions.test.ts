import { describe, expect, it } from 'vitest';
import type { TextChange } from '../../../src/core/diff';
import type { GateHolder } from '../../../src/core/documentGate';
import { NoticeActions } from '../../../src/core/reconcile/actions';
import type { CoreNotice, ReconcilerDeps } from '../../../src/core/reconcile/types';

const enc = new TextEncoder();

function applyTextChanges(doc: string, changes: readonly TextChange[]): string {
  let out = doc;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i]!;
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}

function harness(initial: string) {
  let doc = initial;
  let disposed = false;
  let nextId = 0;
  const backups = new Map<string, Uint8Array>();
  const notices: CoreNotice[] = [];

  const holder: GateHolder = {
    apply: async () => ({ kind: 'failed' }),
  };

  const deps: ReconcilerDeps = {
    disk: {
      stat: async () => null,
      read: async () => ({ ok: false, error: 'missing' }),
      backup: async (bytes, label) => {
        const path = `/backups/${label}-${++nextId}.md`;
        backups.set(path, bytes);
        return path;
      },
      deleteBackup: async (path) => {
        backups.delete(path);
      },
      readBackup: async (path) => backups.get(path) ?? null,
    },
    schedule: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
    documentLf: () => doc,
    isDirty: () => true,
    encoding: () => 'utf8',
    withGate: async (_h, fn) => fn(holder),
    applyMerge: async (_h, changes, expected) => {
      doc = applyTextChanges(doc, changes);
      return doc === expected ? { kind: 'applied', landedText: doc } : { kind: 'failed' };
    },
    prefer: () => 'ours',
    fileName: 'note.md',
    key: 'file:///note.md',
    notify: (n) => notices.push(n),
    log: () => undefined,
    remember: () => undefined,
    recall: () => undefined,
    newId: () => `n-${++nextId}`,
  };

  const actions = new NoticeActions(deps, () => disposed);
  return {
    actions,
    backups,
    notices,
    getDoc: () => doc,
    setDoc: (t: string) => {
      doc = t;
    },
    dispose: () => {
      disposed = true;
    },
  };
}

describe('NoticeActions', () => {
  it('applies disk clash via useFileVersion while keeping newer disjoint user edits, and supports Undo', async () => {
    const h = harness('line1 mine\nline2\nline3\n');
    const diskPath = await h.actions.backupBytes(enc.encode('line1 theirs\nline2\nline3\n'), 'conflict');
    h.actions.recordChoice('c1', 'use', 'line1\nline2\nline3\n', diskPath, null);

    // User makes another disjoint edit before pressing "Use Change from Disk".
    h.setDoc('line1 mine\nline2\nline3 user-extra\n');

    expect(await h.actions.useFileVersion('c1')).toBe(true);
    expect(h.getDoc()).toBe('line1 theirs\nline2\nline3 user-extra\n');
    expect(h.actions.offers('c1')).toBe(false);

    const applied = h.notices.at(-1);
    expect(applied?.kind).toBe('applied');
    if (applied?.kind !== 'applied') return;
    expect(applied.how).toBe('useChoice');
    expect(applied.canUndo).toBe(true);

    // User adds another disjoint line, then presses Undo: reverts line1 while keeping the new line.
    h.setDoc('line1 theirs\nline2\nline3 user-extra\nline4 later\n');
    expect(await h.actions.undoUsed(applied.id)).toBe(true);
    expect(h.getDoc()).toBe('line1 mine\nline2\nline3 user-extra\nline4 later\n');
  });

  it('rejects Undo with reason changed when the user edited the applied clash itself', async () => {
    const h = harness('line1 theirs\nline2\n');
    h.actions.recordUndo('u1', 'line1 theirs\nline2\n', 'line1 mine\nline2\n', null);

    h.setDoc('line1 rewritten by user\nline2\n');
    expect(await h.actions.undoUsed('u1')).toBe(false);
    expect(h.getDoc()).toBe('line1 rewritten by user\nline2\n');
    expect(h.actions.offers('u1')).toBe(false);
    expect(h.notices.at(-1)).toEqual({ kind: 'actionRejected', id: 'u1', action: 'undo', reason: 'changed' });
  });

  it('replaces whole note on replaceNote and reports missingBackup when backup was deleted', async () => {
    const h = harness('my whole note\n');
    const p1 = await h.actions.backupBytes(enc.encode('disk whole note\n'), 'unknownBase');
    h.actions.recordChoice('r1', 'replace', null, p1, null);
    expect(await h.actions.replaceNote('r1')).toBe(true);
    expect(h.getDoc()).toBe('disk whole note\n');

    h.actions.recordChoice('r2', 'replace', null, '/backups/gone.md', null);
    expect(await h.actions.replaceNote('r2')).toBe(false);
    expect(h.actions.unreadableVersion('r2')).toBe(true);
    expect(h.notices.at(-1)).toEqual({ kind: 'actionRejected', id: 'r2', action: 'replace', reason: 'missingBackup' });
  });

  it('caps stored open actions at 20 and rejects once disposed', async () => {
    const h = harness('a\n');
    for (let i = 0; i < 25; i++) {
      h.actions.recordChoice(`c-${i}`, 'replace', null, null, `v-${i}\n`);
    }
    expect(h.actions.offers('c-0')).toBe(false);
    expect(h.actions.offers('c-4')).toBe(false);
    expect(h.actions.offers('c-5')).toBe(true);
    expect(h.actions.offers('c-24')).toBe(true);

    h.dispose();
    expect(h.actions.offers('c-24')).toBe(false);
    expect(await h.actions.replaceNote('c-24')).toBe(false);
    expect(h.notices.at(-1)).toEqual({ kind: 'actionRejected', id: 'c-24', action: 'replace', reason: 'closed' });
  });
});
