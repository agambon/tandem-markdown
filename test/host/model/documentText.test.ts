// A document's text, read from it at most once per version.

import { describe, expect, it } from 'vitest';
import { documentText } from '../../../src/host/model/documentText';

/** A stand-in for VS Code's document that counts how often its text is read. */
function fakeDocument(text: string) {
  return {
    version: 1,
    text,
    reads: 0,
    getText() {
      this.reads++;
      return this.text;
    },
    edit(next: string) {
      this.text = next;
      this.version++;
    },
  };
}

describe('documentText', () => {
  it('reads the document once per version', () => {
    const doc = fakeDocument('one');
    expect(documentText(doc)).toBe('one');
    expect(documentText(doc)).toBe('one');
    expect(doc.reads).toBe(1);
  });

  it('never returns the text of an older version', () => {
    const doc = fakeDocument('one');
    documentText(doc);
    doc.edit('two');
    expect(documentText(doc)).toBe('two');
    expect(doc.reads).toBe(2);
  });

  it('keeps each document apart', () => {
    const a = fakeDocument('a');
    const b = fakeDocument('b');
    expect(documentText(a)).toBe('a');
    expect(documentText(b)).toBe('b');
  });
});
