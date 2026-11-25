// The change marks: which lines of a note differ from the file at the last commit.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ChangeMark } from '../../../src/core/featureProtocol';
import { textOf } from '../../../src/core/positions';
import { lineChanges } from '../../../src/host/model/lineChanges';
import { seeded } from '../../random';

/** Each mark as the lines it covers in `after` (one-based), the way a reader of the margin sees it. */
function marked(after: string, marks: ChangeMark[]): string[] {
  const doc = textOf(after);
  return marks.map((m) => {
    const first = doc.lineAt(m.from).number;
    const last = doc.lineAt(m.to).number;
    return m.kind === 'removed' ? `removed at ${first}` : `${m.kind} ${first}-${last}`;
  });
}

describe('lines changed since the last commit', () => {
  const BEFORE = 'one\ntwo\nthree\nfour\n';

  it('marks nothing for the same text', () => {
    expect(lineChanges(BEFORE, textOf(BEFORE))).toEqual([]);
  });

  it('marks a line edited inside as changed, from its start to its end', () => {
    const after = 'one\ntwo, edited\nthree\nfour\n';
    const marks = lineChanges(BEFORE, textOf(after));
    expect(marks).toEqual([{ kind: 'changed', from: 4, to: 4 + 'two, edited'.length, original: 'two' }]);
  });

  it('marks lines put in as added and lines taken out at the line that follows them', () => {
    const after = 'one\nnew a\nnew b\ntwo\nfour\n';
    expect(marked(after, lineChanges(BEFORE, textOf(after)))).toEqual(['added 2-3', 'removed at 5']);
  });

  it('marks lines taken out at the very end at the end of the text', () => {
    const before = 'one\ntwo\nthree';
    const after = 'one';
    const marks = lineChanges(before, textOf(after));
    expect(marks).toEqual([{ kind: 'removed', from: 3, to: 3, original: 'two\nthree', afterEnd: true }]);
  });

  it('marks a run of several edited lines as one change', () => {
    const after = 'one\nTWO\nTHREE\nfour\n';
    expect(marked(after, lineChanges(BEFORE, textOf(after)))).toEqual(['changed 2-3']);
  });

  it('marks every line of a new text that shares nothing with the old one', () => {
    const after = 'a\nb\nc';
    expect(marked(after, lineChanges('x\ny', textOf(after)))).toEqual(['changed 1-3']);
  });

  it('leaves every unmarked line as one the old text had, in the same order', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'c', 'd', ''), { maxLength: 30 });
    fc.assert(
      fc.property(lines, lines, (before, after) => {
        const a = before.join('\n');
        const b = after.join('\n');
        const doc = textOf(b);
        const marks = lineChanges(a, doc);
        const covered = new Set<number>();
        let last = -1;
        for (const m of marks) {
          expect(m.from).toBeGreaterThanOrEqual(last);
          last = m.to;
          if (m.kind === 'removed') continue;
          for (let n = doc.lineAt(m.from).number; n <= doc.lineAt(m.to).number; n++) covered.add(n);
        }
        const kept = b.split('\n').filter((_, i) => !covered.has(i + 1));
        // `kept` is a subsequence of the old lines.
        let i = 0;
        for (const line of a.split('\n')) if (i < kept.length && kept[i] === line) i++;
        expect(i).toBe(kept.length);
        if (a === b) expect(marks).toEqual([]);
      }),
      seeded({ numRuns: 500 }),
    );
  });
});
