// Verify File's comparisons of the texts it gathers, and which of its words its message takes.

import { describe, expect, it } from 'vitest';
import { fill } from '../../../src/host/model/templates';
import { compareTexts, VERIFY_WORDS as W, verifyMessage } from '../../../src/host/model/verifyText';

describe('compareTexts', () => {
  it('finds the same text the same', () => {
    expect(compareTexts('a\nb\n', 'a\nb\n')).toEqual({ kind: 'same' });
    expect(compareTexts('', '')).toEqual({ kind: 'same' });
  });

  it('counts the characters that differ: a typo is one, a missing word its length', () => {
    expect(compareTexts('the cat sat', 'the bat sat')).toEqual({ kind: 'differ', characters: 1 });
    expect(compareTexts('the cat sat', 'the sat')).toEqual({ kind: 'differ', characters: 4 });
    expect(compareTexts('one\ntwo\n', 'one\ntwo\nthree\n')).toEqual({ kind: 'differ', characters: 6 });
    expect(compareTexts('abc', 'xyz')).toEqual({ kind: 'differ', characters: 3 });
  });

  it('adds up differences in two places', () => {
    expect(compareTexts('alpha beta gamma delta', 'alpha BETA gamma DELTA')).toEqual({ kind: 'differ', characters: 9 });
  });

  it('never calls two different texts the same, line endings included', () => {
    expect(compareTexts('a\n', 'a')).toEqual({ kind: 'differ', characters: 1 });
    expect(compareTexts('a\n', 'a\r\n').kind).toBe('differ');
  });
});

describe('verifyMessage', () => {
  const name = 'Field notes.md';
  const same = { kind: 'same' } as const;
  const differ = { kind: 'differ', characters: 4 } as const;

  it('agrees, from a rich tab or from Source', () => {
    expect(verifyMessage({ name, tab: same, file: same })).toMatchObject({ agree: true, text: W.bothMatch });
    expect(verifyMessage({ name, tab: null, file: same })).toMatchObject({ agree: true, text: W.fileMatches });
  });

  it('says why the file on disk was not compared, after the tab only when run from one', () => {
    expect(verifyMessage({ name, tab: same, file: 'unsaved' })).toMatchObject({
      agree: true,
      text: `${W.tabShows} ${W.notCompared.unsaved}`,
    });
    expect(verifyMessage({ name, tab: null, file: 'unsaved' }).text).toBe(W.notCompared.unsaved);
    expect(verifyMessage({ name, tab: null, file: 'noFile' }).text).toBe(fill(W.notCompared.noFile, { name }));
    expect(verifyMessage({ name, tab: null, file: 'noFile' }).text).toContain(name);
    expect(verifyMessage({ name, tab: null, file: 'unreadable' }).text).toBe(fill(W.notCompared.unreadable, { name }));
    expect(verifyMessage({ name, tab: same, file: 'encoding' }).text).toBe(`${W.tabShows} ${W.notCompared.encoding}`);
  });

  it('says only what differs', () => {
    const tabWrong = verifyMessage({ name, tab: differ, file: same });
    expect(tabWrong).toEqual({ agree: false, text: W.tabDiffers, tabDiffers: true, fileDiffers: false });
    // The file not compared is not mentioned beside a tab that differs.
    expect(verifyMessage({ name, tab: differ, file: 'unsaved' })).toEqual(tabWrong);

    expect(verifyMessage({ name, tab: same, file: differ })).toEqual({
      agree: false,
      text: W.fileDiffers,
      tabDiffers: false,
      fileDiffers: true,
    });
    expect(verifyMessage({ name, tab: null, file: differ }).fileDiffers).toBe(true);

    expect(verifyMessage({ name, tab: differ, file: differ })).toEqual({
      agree: false,
      text: W.bothDiffer,
      tabDiffers: true,
      fileDiffers: true,
    });
  });

  it('never points at the log or counts characters', () => {
    for (const tab of [same, differ, null])
      for (const file of [same, differ, 'unsaved', 'noFile', 'unreadable', 'encoding'] as const) {
        const { text } = verifyMessage({ name, tab, file });
        expect(text).not.toMatch(/log|character/i);
      }
  });
});
