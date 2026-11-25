import { describe, expect, it } from 'vitest';
import type { PartFacts } from '../../../src/host/model/conflictFile';
import { conflictNameOf, isConflictName } from '../../../src/host/model/conflictName';
import {
  type NoteFile,
  closed,
  notWritten,
  reopened,
  settled,
  withPart,
  withPartAgain,
} from '../../../src/host/model/conflictStore';
import { richOffered } from '../../../src/host/model/richOffered';

const NOTE = 'file:///w/Field%20notes.md';
const facts: PartFacts = {
  kind: 'handoff',
  reason: 'handoff',
  savedOver: false,
  diskText: 'disk\n',
  backupPath: null,
};
const part = (noticeId: string | null) => ({ noticeId, facts, problems: [{ line: 0, text: 'handoff' }] });

function file(...ids: (string | null)[]): NoteFile {
  let f: NoteFile | undefined;
  ids.forEach((id, i) => (f = withPart(f, NOTE, part(id), `2026-11-17 10:0${i}`, false)));
  return f!;
}

describe('a conflict file is named for its whole note, and never written for one', () => {
  it('adds .conflict to the whole name, whatever the note ends in', () => {
    expect(conflictNameOf('Field notes.md')).toBe('Field notes.md.conflict');
    expect(conflictNameOf('/w/todo.txt')).toBe('/w/todo.txt.conflict');
    expect(conflictNameOf('Plan.markdown')).toBe('Plan.markdown.conflict');
  });

  it('knows a conflict file in any letter case, and nothing else', () => {
    expect(isConflictName('/w/Field notes.md.conflict')).toBe(true);
    expect(isConflictName('/w/todo.txt.CONFLICT')).toBe(true);
    expect(isConflictName('/w/Field notes.md')).toBe(false);
    expect(isConflictName('/w/conflict.md')).toBe(false);
  });

  it('writes nothing for a conflict file, even one VS Code reads as markdown', () => {
    const asked = { scheme: 'file', enabled: true, inFolder: true };
    expect(notWritten({ ...asked, isConflictFile: true })).toBe('conflictFile');
    expect(notWritten({ ...asked, isConflictFile: false })).toBeNull();
    expect(richOffered({ scheme: 'file', path: '/w/Field notes.md.conflict', languageId: 'markdown' })).toBe(false);
    expect(richOffered({ scheme: 'file', path: '/w/todo.txt.conflict' })).toBe(false);
  });

  it('writes nothing with the setting off, outside a workspace folder, or for a note not on disk', () => {
    const note = { scheme: 'file', isConflictFile: false, enabled: true, inFolder: true };
    expect(notWritten({ ...note, enabled: false })).toBe('settingOff');
    expect(notWritten({ ...note, inFolder: false })).toBe('noFolder');
    expect(notWritten({ ...note, scheme: 'untitled' })).toBe('notAFile');
  });
});

describe('when a part comes and goes', () => {
  it('numbers parts in the order written, dated with their write', () => {
    const f = file('a', 'b', 'c');
    expect(f.parts.map((p) => p.part.n)).toEqual([1, 2, 3]);
    expect(f.parts.map((p) => p.part.time)).toEqual(['2026-11-17 10:00', '2026-11-17 10:01', '2026-11-17 10:02']);
    expect(f.closedAt).toBeNull();
  });

  it('takes out the part a choice settles; the others keep their numbers, and the next part follows on', () => {
    const done = settled(file('a', 'b', 'c'), 'b')!;
    expect(done.stored.part.n).toBe(2);
    expect(done.next!.parts.map((p) => p.part.n)).toEqual([1, 3]);
    const more = withPart(done.next!, NOTE, part('d'), '2026-11-17 10:09', false);
    expect(more.parts.map((p) => p.part.n)).toEqual([1, 3, 4]);
  });

  it('deletes the file with its last part', () => {
    expect(settled(file('a'), 'a')!.next).toBeNull();
  });

  it('changes nothing for a choice whose message has no part, or a part that no choice settles', () => {
    expect(settled(file('a'), 'zzz')).toBeNull();
    expect(settled(file(null), 'a')).toBeNull();
  });

  it('writes a part again after Undo, as it was, with the next number and its first time', () => {
    const f = file('a', 'b');
    const done = settled(f, 'a')!;
    const again = withPartAgain(done.next!, NOTE, done.stored);
    expect(again.parts.map((p) => p.part.n)).toEqual([2, 3]);
    expect(again.parts[1]!.part.time).toBe('2026-11-17 10:00');
    expect(again.parts[1]!.part.facts).toBe(facts);
    expect(again.parts[1]!.noticeId).toBe('a');
  });

  it('starts at 1 again once the file has gone', () => {
    const done = settled(file('a'), 'a')!;
    expect(withPartAgain(done.next ?? undefined, NOTE, done.stored).parts[0]!.part.n).toBe(1);
    expect(withPart(undefined, NOTE, part('b'), '2026-11-17 11:00', false).parts[0]!.part.n).toBe(1);
  });

  it('keeps the parts when the note closes, saying when, and takes that back when it opens', () => {
    const shut = closed(file('a', 'b'), '2026-11-17 10:52');
    expect(shut.parts).toHaveLength(2);
    expect(shut.closedAt).toBe('2026-11-17 10:52');
    expect(reopened(shut).closedAt).toBeNull();
  });

  it('says the note was closed when a part is written at its close', () => {
    const f = withPart(undefined, NOTE, part('a'), '2026-11-17 10:52', true);
    expect(f.closedAt).toBe('2026-11-17 10:52');
    expect(withPart(f, NOTE, part('b'), '2026-11-17 10:53', true).closedAt).toBe('2026-11-17 10:52');
  });
});
