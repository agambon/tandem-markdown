import { collab, receiveUpdates } from '@codemirror/collab';
import { ChangeSet, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { diffChanges } from '../../src/core/diff';
import { LOST_SHOWN_CHARS, lostEdit, lostNotice, shortLost } from '../../src/panel/lostText';

/** What `state` loses when it reloads with `next`. */
const lost = (state: EditorState, next: string) => lostEdit(state, diffChanges(state.doc.toString(), next));
const lostTyping = (state: EditorState, next: string) => lost(state, next).typed;

const BASE = 'One line.\nTwo line.\n';

function synced(text = BASE): EditorState {
  return EditorState.create({ doc: text, extensions: [collab({ startVersion: 0, clientID: 'tab' })] });
}

function typeAt(state: EditorState, at: number, text: string): EditorState {
  return state.update({ changes: { from: at, insert: text }, userEvent: 'input.type' }).state;
}

function deleteAt(state: EditorState, from: number, to: number): EditorState {
  return state.update({ changes: { from, to }, userEvent: 'delete.backward' }).state;
}

describe('lostEdit, of typing', () => {
  it('is empty when nothing typed was unsent', () => {
    expect(lostTyping(synced(), 'One line.\nTwo line.\nFrom elsewhere.\n')).toBe('');
  });

  it('finds what was typed and is missing from the text the tab reloads with', () => {
    const state = typeAt(synced(), 'One line.'.length, ' Typed here');
    expect(lostTyping(state, BASE)).toBe(' Typed here');
  });

  it('leaves out typing that reached the note and text another program deleted', () => {
    let state = typeAt(synced(), 0, 'Kept ');
    state = typeAt(state, state.doc.length, 'Lost words');
    // The note has the first typing and lacks "Two line." (another program deleted it).
    const next = 'Kept One line.\n';
    expect(lostTyping(state, next)).toBe('Lost words');
  });

  it('joins typing lost in two places with a line break, and one stretch typed in steps into one piece', () => {
    let state = typeAt(synced(), 0, 'abc');
    state = typeAt(state, 3, 'def');
    state = typeAt(state, state.doc.length, 'xyz');
    expect(lostTyping(state, BASE)).toBe('abcdef\nxyz');
  });

  it('counts only what this tab typed, not changes it received', () => {
    let state = synced();
    const theirs = ChangeSet.of({ from: 0, insert: 'Theirs ' }, state.doc.length);
    state = receiveUpdates(state, [{ changes: theirs, clientID: 'host' }]).state;
    expect(lostTyping(state, BASE)).toBe('');
  });
});

describe('lostEdit, of a deletion', () => {
  it('finds the deleted text that the text the tab reloads with has again', () => {
    const state = deleteAt(synced(), 'One '.length, 'One line'.length);
    expect(lost(state, BASE)).toEqual({ typed: '', restored: 'line' });
  });

  it('finds it where the diff writes it elsewhere along a run of the same text', () => {
    const state = deleteAt(synced('Rule ----\n'), 'Rule '.length, 'Rule -'.length);
    expect(lost(state, 'Rule ----\n').restored).toBe('-');
  });

  it('is empty when the deletion reached the note, or another program added text elsewhere', () => {
    const state = deleteAt(synced(), 'One '.length, 'One line'.length);
    expect(lost(state, 'One .\nTwo line.\n').restored).toBe('');
    expect(lost(state, 'One .\nTwo line.\nTheirs.\n').restored).toBe('');
  });

  it('gives a deleted line break as it is, for the tab to tell from text', () => {
    const state = deleteAt(synced(), 'One line.'.length, 'One line.\n'.length);
    expect(lost(state, BASE)).toEqual({ typed: '', restored: '\n' });
  });
});

describe('lostNotice', () => {
  it('shows lost typing cut short, with all of it to copy', () => {
    const typed = `${'word '.repeat(30)}\nsecond line`;
    const notice = lostNotice({ typed, restored: 'gone' });
    expect(notice?.text.startsWith('This tab reloaded and lost what you had just typed: word word')).toBe(true);
    expect(notice?.text.endsWith('…')).toBe(true);
    expect(notice?.copy).toBe(typed);
  });

  it('says a lost deletion is back, with no button', () => {
    expect(lostNotice({ typed: '', restored: 'line' })).toEqual({
      text: 'This tab reloaded and lost your last deletion, so the deleted text is back.',
    });
    // Typing of spaces alone does not hide a deletion beside it.
    expect(lostNotice({ typed: ' ', restored: 'line' })?.copy).toBeUndefined();
  });

  it('says nothing of a lost edit of spaces or line breaks alone', () => {
    expect(lostNotice({ typed: '', restored: '' })).toBeNull();
    expect(lostNotice({ typed: '  ', restored: '\n' })).toBeNull();
  });
});

describe('shortLost', () => {
  it('shows a short line as it is', () => {
    expect(shortLost('a few words')).toBe('a few words');
    expect(shortLost('  spaced  ')).toBe('spaced');
  });

  it('cuts to the first line with anything on it, ending with an ellipsis', () => {
    expect(shortLost('\nFirst line\nSecond line')).toBe('First line…');
  });

  it('cuts a long line to the limit, the ellipsis included', () => {
    const long = 'x'.repeat(200);
    const shown = shortLost(long);
    expect(Array.from(shown).length).toBe(LOST_SHOWN_CHARS);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('never splits a character made of two code units', () => {
    const shown = shortLost('😀'.repeat(100));
    expect(Array.from(shown).length).toBe(LOST_SHOWN_CHARS);
    expect(shown).toBe(`${'😀'.repeat(LOST_SHOWN_CHARS - 1)}…`);
  });
});
