import { describe, expect, it } from 'vitest';
import * as W from '../../../src/host/model/conflictFile';
import {
  countWords,
  promptFor,
  statusText,
  statusTooltip,
  waitingText,
  waitingTooltip,
} from '../../../src/host/model/conflictStatus';
import { fill } from '../../../src/host/model/templates';

const field = (changes: number) => ({ note: 'Field notes.md', conflictFile: 'Field notes.md.conflict', changes });
const budget = (changes: number) => ({ note: 'Budget.md', conflictFile: 'Budget.md.conflict', changes });

describe('the status bar item', () => {
  it('counts the open changes, and is hidden with none', () => {
    expect(statusText([])).toBeNull();
    expect(statusText([field(1)])).toBe('Tandem: 1 change');
    expect(statusText([field(3), budget(1)])).toBe('Tandem: 4 changes');
    expect(waitingText(0)).toBeNull();
    expect(waitingText(1)).toBe('$(comment-unresolved) 1 message for you');
    expect(waitingText(2)).toBe('$(comment-unresolved) 2 messages for you');
    expect(waitingTooltip('Plans.md', 'Your view now has the change from disk.')).toBe(
      'Plans.md: Your view now has the change from disk.',
    );
  });

  it('says for one note what was written where, in the singular or the plural', () => {
    const one = { note: 'Field notes.md', conflictFile: 'Field notes.md.conflict' };
    expect(statusTooltip([field(1)])).toBe(fill(W.STATUS_TIP_ONE, { ...one, changes: '1 change' }));
    expect(statusTooltip([field(3)])).toBe(fill(W.STATUS_TIP_ONE, { ...one, changes: '3 changes' }));
  });

  it('lists the files for several notes, up to five, and how many more', () => {
    expect(statusTooltip([field(3), budget(1)]).split('\n')).toEqual([
      fill(W.STATUS_TIP_MANY, { count: 2, changes: '4 changes' }),
      fill(W.STATUS_TIP_FILE, { conflictFile: 'Field notes.md.conflict', changes: '3 changes' }),
      fill(W.STATUS_TIP_FILE, { conflictFile: 'Budget.md.conflict', changes: '1 change' }),
    ]);
    const seven = Array.from({ length: 7 }, (_, i) => ({
      note: `n${i}.md`,
      conflictFile: `n${i}.md.conflict`,
      changes: 1,
    }));
    const lines = statusTooltip(seven).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[5]).toBe(fill(W.STATUS_TIP_FILE, { conflictFile: 'n4.md.conflict', changes: '1 change' }));
    expect(lines[6]).toBe(fill(W.STATUS_TIP_MORE, { count: 2 }));
  });

  it('counts a row of the quick pick', () => {
    expect(countWords(1)).toBe('1 change');
    expect(countWords(3)).toBe('3 changes');
  });
});

describe('the prompt for an agent', () => {
  const path = (changes: number) => ({
    note: 'notes/Field notes.md',
    conflictFile: 'notes/Field notes.md.conflict',
    changes,
  });

  it('names the note and its conflict file by their paths', () => {
    expect(promptFor([path(1)])).toBe(
      fill(W.PROMPT_ONE, { note: 'notes/Field notes.md', conflictFile: 'notes/Field notes.md.conflict' }),
    );
    expect(promptFor([path(3)])).toContain('"notes/Field notes.md.conflict"');
  });

  it('lists every file for several notes, and is none with nothing unsettled', () => {
    expect(promptFor([path(3), budget(1)])).toBe(
      fill(W.PROMPT_MANY, {
        notes: 2,
        files: '"notes/Field notes.md.conflict", "Budget.md.conflict"',
      }),
    );
    expect(promptFor([])).toBeNull();
  });
});
