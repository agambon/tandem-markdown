// The copy of typing a closed note never had: each push applied to the note's last text, moved
// over whatever the note took in after the version it was made on, the way the panel itself would
// have moved it, and pushes that cannot be placed left out rather than guessed. And the count of
// lines the message gives: in each run of changed lines, the larger side, as a comparison marks it.
import { ChangeSet } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { stampOf } from '../../src/core/hash';
import { textOf } from '../../src/core/positions';
import { SyncSession } from '../../src/core/session';
import {
  copyAtClose,
  linesChanged,
  receivedPush,
  UnappliedPushes,
  type ReceivedPush,
} from '../../src/core/typingAtClose';

const NOTE = 'line one\nline two\n';

/** A push of panel `clientId`, made on `version` of a text `before`, inserting `insert` at `at`. */
function push(clientId: string, version: number, before: string, at: number, insert: string): ReceivedPush {
  const changes = ChangeSet.of({ from: at, insert }, before.length);
  return {
    clientId,
    baseVersion: version,
    updates: [changes.toJSON()],
    expect: stampOf(changes.apply(textOf(before))),
  };
}

/** The log of a session that took in `edits`, each an insert at an offset of the text as it then was. */
function logAfter(edits: readonly [number, string][]) {
  const s = new SyncSession(NOTE);
  for (const [at, insert] of edits) s.logOwn([{ from: at, to: at, insert }], 'merge');
  return { session: s, log: { doc: s.doc, since: (v: number) => s.updatesSince(v) } };
}

describe('the copy at a close', () => {
  it('is the note with a push made on its last version', () => {
    const { log } = logAfter([]);
    expect(copyAtClose([push('a', 0, NOTE, 4, ' first')], log, NOTE)).toBe('line first one\nline two\n');
  });

  it('moves a push made on an older version over what the note took in since', () => {
    const { session, log } = logAfter([[0, 'top\n']]);
    expect(session.version).toBe(1);
    expect(copyAtClose([push('a', 0, NOTE, NOTE.length, 'end\n')], log, session.text)).toBe(
      'top\nline one\nline two\nend\n',
    );
  });

  it('moves a push over the changes VS Code made that the log had not taken in', () => {
    const { log } = logAfter([]);
    expect(copyAtClose([push('a', 0, NOTE, NOTE.length, 'end\n')], log, `top\n${NOTE}`)).toBe(
      'top\nline one\nline two\nend\n',
    );
  });

  it("keeps two tabs' typing, the later moved over the earlier", () => {
    const { log } = logAfter([]);
    const copy = copyAtClose([push('a', 0, NOTE, 0, 'A '), push('b', 0, NOTE, NOTE.length, 'B\n')], log, NOTE);
    expect(copy).toBe('A line one\nline two\nB\n');
  });

  it('leaves out a push it cannot place: the log no longer reaches back, or the updates do not fit', () => {
    const { log } = logAfter([]);
    const tooOld = { ...log, since: () => null };
    expect(copyAtClose([push('a', 0, NOTE, 0, 'x')], tooOld, NOTE)).toBeNull();
    const wrongLength = push('a', 0, `${NOTE}more`, 0, 'x');
    expect(copyAtClose([wrongLength], log, NOTE)).toBeNull();
  });

  it("leaves out a push on the last version that does not give its panel's own text", () => {
    const { log } = logAfter([]);
    const p = push('a', 0, NOTE, 0, 'x');
    expect(copyAtClose([{ ...p, expect: stampOf('something else') }], log, NOTE)).toBeNull();
  });

  it('is null when the typing changes nothing', () => {
    const { log } = logAfter([]);
    const none = { ...push('a', 0, NOTE, 0, ''), updates: [ChangeSet.empty(NOTE.length).toJSON()] };
    expect(copyAtClose([{ ...none, expect: stampOf(NOTE) }], log, NOTE)).toBeNull();
  });
});

describe('the pushes not yet in the document', () => {
  it("keep each panel's last push, in the order they came; settling an older one leaves the newer", () => {
    const pushes = new UnappliedPushes();
    const a1 = push('a', 0, NOTE, 0, '1');
    const b = push('b', 0, NOTE, 0, 'b');
    const a2 = push('a', 0, NOTE, 0, '12');
    pushes.add('pa', a1);
    pushes.add('pb', b);
    pushes.add('pa', a2);
    expect(pushes.all()).toEqual([b, a2]);
    pushes.settle('pa', a1);
    expect(pushes.all()).toEqual([b, a2]);
    pushes.settle('pa');
    expect(pushes.all()).toEqual([b]);
  });

  it('take only a message with the fields of a push', () => {
    const p = push('a', 0, NOTE, 0, 'x');
    expect(receivedPush(p)).toEqual(p);
    expect(receivedPush({ ...p, updates: 'x' })).toBeNull();
    expect(receivedPush({ ...p, baseVersion: 1.5 })).toBeNull();
    expect(receivedPush({ ...p, expect: null })).toBeNull();
  });
});

describe('the lines the typing changed', () => {
  it('counts each changed run of lines by its larger side', () => {
    expect(linesChanged(NOTE, NOTE)).toBe(0);
    expect(linesChanged(NOTE, 'line one more\nline two\n')).toBe(1);
    expect(linesChanged(NOTE, `${NOTE}line three\n`)).toBe(1);
    expect(linesChanged(NOTE, 'line two\n')).toBe(1);
    expect(linesChanged(NOTE, 'line a\nb\nc one\nline two\n')).toBe(3);
    expect(linesChanged(NOTE, 'line 1\nline 2\n')).toBe(2);
    expect(linesChanged('one line', 'one line typed on')).toBe(1);
  });
});
