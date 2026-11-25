// A backup's file name: what it says, how a long note name is cut to fit, and how the name is read
// back.

import { describe, expect, it } from 'vitest';
import {
  BACKUP_NAME_MAX,
  backupName,
  backupStamp,
  isQuietLabel,
  kindOfLabel,
  readBackupName,
} from '../../../src/host/model/backupNames';

const TAG = 'a1b2c3';
const STAMP = '2026-11-14 08.15.00';

describe('backupName', () => {
  it('says the note, whose text it holds, and when, in words the user reads', () => {
    expect(backupName('Field notes.md', 'theirs', TAG, STAMP, 1)).toBe(
      `Field notes.md (other program's version) ${STAMP} ${TAG}.md`,
    );
    expect(backupName('Field notes.md', 'yours', TAG, STAMP, 2)).toBe(
      `Field notes.md (copy of your text) ${STAMP} ${TAG} 2.md`,
    );
    expect(backupName('notes.md', 'older', TAG, STAMP, 1)).toBe(`notes.md (older text) ${STAMP} ${TAG}.md`);
    expect(backupName('notes.md', 'cut', TAG, STAMP, 1)).toBe(`notes.md (cut version) ${STAMP} ${TAG}.md`);
    expect(backupName('notes.md', 'disk', TAG, STAMP, 1)).toBe(`notes.md (file on disk) ${STAMP} ${TAG}.md`);
  });

  it('cuts a long name so the whole backup name is at most BACKUP_NAME_MAX characters', () => {
    for (const length of [130, 140, 200, 229, 230, 255]) {
      const note = 'n'.repeat(length - 3) + '.md';
      for (const kind of ['theirs', 'yours'] as const)
        for (const n of [1, 2, 999]) {
          const name = backupName(note, kind, TAG, STAMP, n);
          expect(name.length).toBeLessThanOrEqual(BACKUP_NAME_MAX);
          expect(name.endsWith(n === 1 ? ` ${STAMP} ${TAG}.md` : ` ${STAMP} ${TAG} ${n}.md`)).toBe(true);
          expect(name.startsWith('nnn')).toBe(true);
          expect(readBackupName(name)).toMatchObject({ kind, tag: TAG });
        }
    }
  });

  it('never cuts a character in two, and ends the cut name with neither a dot nor a space', () => {
    const emoji = '\u{1F600}';
    const note = 'x'.repeat(135) + emoji + 'y'.repeat(40) + '.md';
    const name = backupName(note, 'theirs', TAG, STAMP, 1);
    expect(name.length).toBeLessThanOrEqual(BACKUP_NAME_MAX);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(name)).toBe(false);
    expect(
      backupName('a'.repeat(120) + '.' + ' '.repeat(30) + 'b.md', 'theirs', TAG, STAMP, 1).startsWith(
        'a'.repeat(120) + ' (',
      ),
    ).toBe(true);
  });

  it('replaces characters a file system refuses', () => {
    expect(backupName('a:b?c.md', 'theirs', TAG, STAMP, 1)).toBe(
      `a_b_c.md (other program's version) ${STAMP} ${TAG}.md`,
    );
  });
});

describe('readBackupName', () => {
  it('reads a name back, the note, what it holds and its tag', () => {
    expect(readBackupName(`Field notes.md (copy of your text) ${STAMP} ${TAG} 3.md`)).toEqual({
      note: 'Field notes.md',
      kind: 'yours',
      tag: TAG,
    });
    // A note whose own name has parentheses in it.
    expect(readBackupName(`Plan (draft).md (other program's version) ${STAMP} ${TAG}.md`)).toEqual({
      note: 'Plan (draft).md',
      kind: 'theirs',
      tag: TAG,
    });
  });

  it('is null for a file that is not a backup', () => {
    expect(readBackupName('notes.md')).toBeNull();
    expect(readBackupName(`notes.md (something else) ${STAMP} ${TAG}.md`)).toBeNull();
  });
});

describe('the parts of a name', () => {
  it("takes what a backup holds from the core label, and any other as the other program's version", () => {
    expect(kindOfLabel('yours')).toBe('yours');
    expect(kindOfLabel('cut')).toBe('cut');
    expect(kindOfLabel('unknownBase')).toBe('disk');
    expect(kindOfLabel('fileOnDisk')).toBe('disk');
    expect(kindOfLabel('beforeRemoval')).toBe('yours');
    for (const label of ['beforeSave', 'conflict', 'undecodable', 'notMerged'] as const)
      expect(kindOfLabel(label)).toBe('theirs');
    expect(kindOfLabel(undefined)).toBe('theirs');
  });

  it('keeps the copy taken before a change took out saved text quietly, and no other', () => {
    expect(isQuietLabel('beforeRemoval')).toBe(true);
    for (const label of ['yours', 'conflict', 'fileOnDisk', undefined] as const)
      expect(isQuietLabel(label)).toBe(false);
  });

  it('gives the time in local time, with no character a file system refuses', () => {
    expect(backupStamp(new Date(2026, 10, 17, 9, 5, 7))).toBe('2026-11-17 09.05.07');
  });
});
