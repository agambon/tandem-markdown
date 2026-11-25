import { describe, expect, it } from 'vitest';
import { diffChanges } from '../../../src/core/diff';
import { type ReconcileInput, decideReconcile, takesUnsaved } from '../../../src/core/reconcile/decide';

function input(overrides: Partial<ReconcileInput>): ReconcileInput {
  return {
    doc: 'one\ntwo\nthree\n',
    encoding: 'utf8',
    base: 'one\ntwo\nthree\n',
    possibleBases: [],
    disk: 'one\ntwo\nthree\n',
    truncated: false,
    prefer: 'ours',
    exactBase: true,
    ...overrides,
  };
}

describe('decideReconcile', () => {
  it('returns noop when disk still matches base outside a post-save check', () => {
    const d = decideReconcile(input({ doc: 'one edited\ntwo\nthree\n' }));
    expect(d).toEqual({ action: 'noop' });
  });

  it('advances base when disk matches current document or an in-flight save candidate', () => {
    const saved = decideReconcile(input({ doc: 'new\n', base: 'old\n', disk: 'new\n' }));
    expect(saved).toEqual({ action: 'advanceBase', nextBase: 'new\n' });

    const candidate = decideReconcile(
      input({ doc: 'typed later\n', base: 'old\n', possibleBases: ['saved\n'], disk: 'saved\n' }),
    );
    expect(candidate).toEqual({ action: 'advanceBase', nextBase: 'saved\n' });
  });

  it('follows disk cleanly when document content matches base, writing a quiet backup', () => {
    const d = decideReconcile(input({ disk: 'one\ntwo changed\nthree\n' }));
    expect(d).toEqual({
      action: 'follow',
      nextText: 'one\ntwo changed\nthree\n',
      nextBase: 'one\ntwo changed\nthree\n',
      quietBackupOf: 'one\ntwo\nthree\n',
      truncated: false,
    });
  });

  it('follows a truncated disk file on a clean note with truncated flag set', () => {
    const d = decideReconcile(input({ disk: 'one\ntw', truncated: true }));
    expect(d).toEqual({
      action: 'follow',
      nextText: 'one\ntw',
      nextBase: 'one\ntw',
      quietBackupOf: 'one\ntwo\nthree\n',
      truncated: true,
    });
  });

  it('hands off a dirty note when base is unknown or disk stayed truncated', () => {
    const noBase = decideReconcile(input({ base: null, doc: 'mine\n', disk: 'theirs\n' }));
    expect(noBase).toEqual({ action: 'handoff', reason: 'noBase', nextBase: 'theirs\n' });

    const cut = decideReconcile(input({ doc: 'one mine\ntwo\nthree\n', disk: 'one\ntw', truncated: true }));
    expect(cut).toEqual({ action: 'handoff', reason: 'truncated', nextBase: 'one\ntw' });
  });

  it('merges disjoint edits cleanly and writes a quiet backup only when disk removes lines', () => {
    const additive = decideReconcile(
      input({
        doc: 'one mine\ntwo\nthree\n',
        disk: 'one\ntwo\nthree theirs\n',
      }),
    );
    expect(additive).toEqual({
      action: 'merge',
      nextText: 'one mine\ntwo\nthree theirs\n',
      nextBase: 'one\ntwo\nthree theirs\n',
    });

    const deleting = decideReconcile(
      input({
        doc: 'one mine\ntwo\nthree\n',
        disk: 'one\ntwo\n',
      }),
    );
    expect(deleting).toEqual({
      action: 'merge',
      nextText: 'one mine\ntwo\n',
      nextBase: 'one\ntwo\n',
      quietBackupOf: 'one mine\ntwo\nthree\n',
    });
  });

  it('keeps user words at overlapping clash under keepMine and merges disjoint parts', () => {
    const d = decideReconcile(
      input({
        doc: 'one mine\ntwo\nthree\n',
        disk: 'one theirs\ntwo\nthree added\n',
        prefer: 'ours',
      }),
    );
    expect(d.action).toBe('conflictKeepOurs');
    if (d.action !== 'conflictKeepOurs') return;
    expect(d.nextText).toBe('one mine\ntwo\nthree added\n');
    expect(d.restMerged).toBe(true);
    expect(d.passages).toHaveLength(1);
    expect(d.passages[0]).toMatchObject({ yours: 'one mine', theirs: 'one theirs', lineNumber: 0 });
  });

  it('does not misclassify a genuine 1-line clash as a whole-file repetition refusal', () => {
    const d = decideReconcile(
      input({
        base: 'alpha',
        doc: 'beta',
        disk: 'gamma',
        prefer: 'ours',
      }),
    );
    expect(d.action).toBe('conflictKeepOurs');
    if (d.action !== 'conflictKeepOurs') return;
    expect(d.passages).toHaveLength(1);
    expect(d.passages[0]).toMatchObject({ yours: 'beta', theirs: 'gamma', lineNumber: 0 });
  });

  it('applies disk words under keepTheirs and computes an Undo target preserving disjoint edits', () => {
    const d = decideReconcile(
      input({
        doc: 'one mine\ntwo\nthree\n',
        disk: 'one theirs\ntwo\nthree added\n',
        prefer: 'theirs',
      }),
    );
    expect(d).toEqual({
      action: 'conflictKeepTheirs',
      nextText: 'one theirs\ntwo\nthree added\n',
      nextBase: 'one theirs\ntwo\nthree added\n',
      undoTarget: 'one mine\ntwo\nthree added\n',
    });
  });

  it('enforces the uncertain-origin rule when multiple candidate bases disagree', () => {
    // Disjoint edit that agrees under both base A and saved text B -> merges cleanly.
    const agrees = decideReconcile(
      input({
        base: 'one\ntwo\nthree\n',
        possibleBases: ['one saved\ntwo\nthree\n'],
        doc: 'one saved\ntwo\nthree\n',
        disk: 'one saved\ntwo\nthree by claude\n',
      }),
    );
    expect(agrees).toEqual({
      action: 'merge',
      nextText: 'one saved\ntwo\nthree by claude\n',
      nextBase: 'one saved\ntwo\nthree by claude\n',
    });

    // User typed during save window; disk lacks that typing -> candidates disagree -> handoff.
    const disagrees = decideReconcile(
      input({
        base: 'one\ntwo\nthree\n',
        possibleBases: ['one typed\ntwo\nthree\n'],
        doc: 'one typed\ntwo\nthree\n',
        disk: 'one\ntwo\nthree by claude\n',
      }),
    );
    expect(disagrees).toEqual({
      action: 'handoff',
      reason: 'handoff',
      nextBase: 'one\ntwo\nthree by claude\n',
    });
  });

  it('catches an external revert back to pre-save base right after didSave', () => {
    const cleanRevert = decideReconcile(
      input({
        base: 'old\n',
        possibleBases: ['saved\n'],
        doc: 'saved\n',
        disk: 'old\n',
        afterSave: true,
      }),
    );
    expect(cleanRevert).toEqual({
      action: 'follow',
      nextText: 'old\n',
      nextBase: 'old\n',
      quietBackupOf: 'saved\n',
      truncated: false,
    });
  });

  it('routes safeMerge repetition refusals to handoff under both keepMine and keepTheirs', () => {
    const base = 'one\ntwo\nthree\nfour\n';
    const doc = 'the same added line\none\ntwo\nthree\nfour\n';
    const disk = 'one\ntwo\nthree\nfour\nthe same added line\n';

    for (const prefer of ['ours', 'theirs'] as const) {
      const d = decideReconcile(input({ base, doc, disk, prefer, exactBase: false }));
      expect(d.action).toBe('handoff');
      if (d.action === 'handoff') expect(d.reason).toBe('handoff');
    }
  });
});

describe('takesUnsaved', () => {
  it('blocks deleting, replacing, or splitting inside an unsaved user word', () => {
    const file = 'hello world\n';
    const ours = 'hello brave world\n';

    expect(takesUnsaved(file, ours, diffChanges(ours, 'hello world\n'))).toBe(true);
    expect(takesUnsaved(file, ours, diffChanges(ours, 'hello brXave world\n'))).toBe(true);
  });

  it('permits disjoint edits and edits inside explicitly allowed clash regions', () => {
    const file = 'first\nsecond\n';
    const ours = 'first mine\nsecond\n';
    const disjoint = diffChanges(ours, 'first mine\nsecond theirs\n');
    expect(takesUnsaved(file, ours, disjoint)).toBe(false);

    const replaceMine = diffChanges(ours, 'first theirs\nsecond\n');
    expect(takesUnsaved(file, ours, replaceMine, [[0, 'first mine'.length]])).toBe(false);
  });
});
