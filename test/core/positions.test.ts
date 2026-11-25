// Translating VS Code's positions into LF offsets, and reading change sets from a message.
import { describe, expect, it } from 'vitest';
import { decodeChangeSet, eventChangesToLf, offsetOf, positionOf, textOf } from '../../src/core/positions';

describe('positions', () => {
  it('turns VS Code line and character into LF offsets, and inserted CRLF text into LF', () => {
    const doc = textOf('ab\ncd\nef');
    expect(
      eventChangesToLf(doc, [
        { range: { start: { line: 1, character: 1 }, end: { line: 2, character: 0 } }, text: 'X\r\nY' },
      ]),
    ).toEqual([{ from: 4, to: 6, insert: 'X\nY' }]);
    expect(
      eventChangesToLf(doc, [
        { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, text: '' },
      ]),
    ).toBeNull();
    expect(offsetOf(doc, 1, 3)).toBeNull();
    expect(positionOf(doc, 4)).toEqual({ line: 1, character: 1 });
    expect(positionOf(doc, 8)).toEqual({ line: 2, character: 2 });
  });

  it('decodeChangeSet refuses what ChangeSet.fromJSON would wrongly accept', () => {
    expect(decodeChangeSet([1.5, 3])).toBeNull();
    expect(decodeChangeSet([3, [-1, 'x']])).toBeNull();
    expect(decodeChangeSet([3, [1, 2]])).toBeNull();
    expect(decodeChangeSet({})).toBeNull();
    expect(decodeChangeSet([2, [1, 'x'], 3])!.length).toBe(6);
  });
});
