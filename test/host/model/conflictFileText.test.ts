import { describe, expect, it } from 'vitest';
import type { CoreNotice } from '../../../src/core/reconcile/types';
import { type PartFacts, conflictFileText, partForNotice } from '../../../src/host/model/conflictFile';

describe('partForNotice', () => {
  it('builds clash parts and line-numbered Problems spots from clash conflicts', () => {
    const notice: CoreNotice = {
      kind: 'conflict',
      id: 'c1',
      reason: 'clash',
      restMerged: true,
      savedOver: false,
      backupPath: '/backups/theirs.md',
      diskText: 'one\ntwo theirs\nthree added\n',
      baseText: 'one\ntwo\nthree\n',
      noteText: 'one\ntwo mine\nthree added\n',
      passages: [{ at: 'after', line: 'one', yours: 'two mine', theirs: 'two theirs', lineNumber: 1 }],
      choice: 'use',
    };
    const part = partForNotice(notice);
    expect(part).not.toBeNull();
    expect(part!.facts.kind).toBe('clash');
    expect(part!.problems).toEqual([
      { line: 1, text: 'Both you and another program edited here; your text was kept.' },
    ]);
    expect(part!.backup).toBe('/backups/theirs.md');
  });

  it('builds handoff parts for noBase, truncated, encoding, handoff, and closedWithPending', () => {
    const handoff = partForNotice({
      kind: 'conflict',
      id: 'c2',
      reason: 'noBase',
      restMerged: false,
      savedOver: false,
      backupPath: '/backups/disk.md',
      diskText: 'disk text\n',
      baseText: null,
      noteText: 'note text\n',
      passages: [],
      choice: 'replace',
    });
    expect(handoff!.facts).toMatchObject({ kind: 'handoff', reason: 'noBase', diskText: 'disk text\n' });
    expect(handoff!.problems).toHaveLength(1);

    const closed = partForNotice({
      kind: 'closedWithPending',
      id: 'c3',
      backupPath: '/backups/pending.md',
      diskText: 'pending\n',
    });
    expect(closed!.facts).toMatchObject({ kind: 'handoff', reason: 'closedWithPending' });
    expect(closed!.problems).toEqual([]);
  });

  it('builds truncatedFollow parts and returns null for applied/actionRejected/readStatus/typingAtClose', () => {
    const cut = partForNotice({
      kind: 'truncatedFollow',
      id: 't1',
      backupPath: '/backups/prior.md',
      previousText: 'line1\nline2\n',
      diskText: 'line1\nli',
    });
    expect(cut!.facts.kind).toBe('truncatedFollow');
    expect(cut!.problems).toHaveLength(1);

    expect(
      partForNotice({
        kind: 'applied',
        id: 'a1',
        how: 'setting',
        backupPath: null,
        previousText: 'old',
        diskBackupPath: null,
        canUndo: true,
      }),
    ).toBeNull();
  });
});

describe('conflictFileText', () => {
  it('renders open and closed headers, clash passages, backup path, and safe fences', () => {
    const clash: PartFacts = {
      kind: 'clash',
      restMerged: true,
      savedOver: true,
      backupPath: '/backups/theirs.md',
      passages: [
        {
          at: 'after',
          line: '## Section',
          yours: '```ts\nconst a = 1;\n```',
          theirs: '```ts\nconst a = 2;\n```',
          lineNumber: 4,
        },
      ],
    };
    const open = conflictFileText({
      note: 'Field notes.md',
      closedAt: null,
      parts: [{ n: 1, time: '2026-11-17 10:32', facts: clash }],
    });
    expect(open).toContain('# Unsettled changes to "Field notes.md"');
    expect(open).toContain('is open in Tandem Markdown');
    expect(open).toContain('Full disk version backup: `/backups/theirs.md`');
    expect(open).toContain('### Line 5 (after "## Section")');
    // Code block inside passage must be wrapped with a 4-backtick fence so markdown stays valid.
    expect(open).toContain('````\n```ts\nconst a = 1;\n```\n````');

    const shut = conflictFileText({
      note: 'Field notes.md',
      closedAt: '2026-11-17 10:55',
      parts: [{ n: 1, time: '2026-11-17 10:32', facts: clash }],
    });
    expect(shut).toContain('was closed in Tandem Markdown at 2026-11-17 10:55');
  });

  it('trims very long quoted texts while preserving start, end, and backup pointer', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join('\n');
    const text = conflictFileText({
      note: 'Big.md',
      closedAt: null,
      parts: [
        {
          n: 1,
          time: '2026-11-17 10:40',
          facts: { kind: 'handoff', reason: 'handoff', savedOver: false, diskText: many, backupPath: '/b/big.md' },
        },
      ],
    });
    expect(text).toContain('Line 1');
    expect(text).toContain('Line 60');
    expect(text).toContain('lines omitted; see backup for full text');
    expect(text).toContain('/b/big.md');
  });
});
