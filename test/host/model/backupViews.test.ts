// The words of a comparison with a backup and of the list of a note's backups.

import { describe, expect, it } from 'vitest';
import { backupRow, comparisonTitle, kindWords } from '../../../src/host/model/backupViews';

describe('comparisonTitle', () => {
  it('names both sides as the messages do', () => {
    expect(comparisonTitle('Field notes.md', 'theirs', false, null)).toBe(
      "Field notes.md: other program's version ↔ your text",
    );
    expect(comparisonTitle('Field notes.md', 'older', false, null)).toBe('Field notes.md: older text ↔ your text');
    expect(comparisonTitle('Field notes.md', 'cut', false, null)).toBe('Field notes.md: cut version ↔ your text');
    expect(comparisonTitle('Field notes.md', 'disk', false, null)).toBe('Field notes.md: file on disk ↔ your text');
    expect(comparisonTitle('Field notes.md', 'yours', false, null)).toBe(
      'Field notes.md: copy of your text ↔ your text now',
    );
  });

  it('names the file on disk on the right once the note is closed', () => {
    expect(comparisonTitle('Field notes.md', 'theirs', true, null)).toBe(
      "Field notes.md: other program's version ↔ file on disk",
    );
  });

  it('calls a file that is not named as a backup a backup', () => {
    expect(kindWords(null)).toBe('backup');
    expect(comparisonTitle('Field notes.md', null, false, null)).toBe('Field notes.md: backup ↔ your text');
  });
});

describe('backupRow', () => {
  // The date is written as the machine's own locale writes it, so the case states what holds in any.
  it('says what a backup holds, and when it was written, to the second', () => {
    const at = new Date(2026, 10, 17, 10, 31, 5).getTime();
    const row = backupRow('yours', at, null);
    expect(row.label).toBe('copy of your text');
    expect(row.description).not.toBe('');
    expect(backupRow('yours', at, null).description).toBe(row.description);
    expect(backupRow('yours', at + 1000, null).description).not.toBe(row.description);
  });
});
