// Git change marks in a headless panel: which messages are taken, and how marks move with
// the text until the host sends the next set.

import type { EditorState } from '@codemirror/state';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ChangeMark } from '../../../src/core/featureProtocol';
import { textOf } from '../../../src/core/positions';
import { lineChanges } from '../../../src/host/model/lineChanges';
import {
  changeMarksOf,
  readChangeMarks,
  revertChangeMark,
  setChangeMarks,
} from '../../../src/panel/render/changeMarks';
import { seeded } from '../../random';
import { stateOf } from '../helpers';

const TEXT = 'one\ntwo, edited\nthree\nfour\n';

/** Each mark as its kind and the lines it covers. */
function lines(state: EditorState): string[] {
  return changeMarksOf(state).map((m) => {
    const first = state.doc.lineAt(m.from).number;
    const last = state.doc.lineAt(m.to).number;
    return m.kind === 'removed' ? `removed at ${first}` : `${m.kind} ${first}-${last}`;
  });
}

function given(state: EditorState, marks: ChangeMark[]): EditorState {
  return state.update({ effects: setChangeMarks.of({ version: 0, items: marks }) }).state;
}

const changed: ChangeMark = { kind: 'changed', from: 4, to: 15 };
const removed: ChangeMark = { kind: 'removed', from: 22, to: 22 };

describe('change marks in the panel', () => {
  it('takes well-formed marks and leaves out the rest', () => {
    expect(
      readChangeMarks([
        changed,
        { kind: 'moved', from: 0, to: 1 },
        { kind: 'added', from: 3, to: 1 },
        { kind: 'added', from: -1, to: 1 },
        { kind: 'added', from: 0 },
        removed,
      ]),
    ).toEqual([changed, removed]);
    expect(readChangeMarks({})).toEqual([]);
  });

  it('keeps a mark on its lines while they are typed in, and a removed mark before the line after it', () => {
    let state = given(stateOf(TEXT), [changed, removed]);
    expect(lines(state)).toEqual(['changed 2-2', 'removed at 4']);
    state = state.update({ changes: { from: 4, insert: 'Typed ' } }).state;
    state = state.update({ changes: { from: state.doc.line(2).to, insert: ' more' } }).state;
    state = state.update({ changes: { from: state.doc.line(4).from, insert: 'x' } }).state;
    expect(lines(state)).toEqual(['changed 2-2', 'removed at 4']);
    expect(state.doc.line(2).text).toBe('Typed two, edited more');
  });

  it('moves the marks down with lines inserted above them', () => {
    let state = given(stateOf(TEXT), [changed, removed]);
    state = state.update({ changes: { from: 0, insert: 'zero\n' } }).state;
    expect(lines(state)).toEqual(['changed 3-3', 'removed at 5']);
  });

  it('reverts added, changed, and removed hunks back to the exact committed text over random edits', () => {
    const linesArb = fc.array(fc.constantFrom('alpha', 'beta', 'gamma', 'delta', ''), { maxLength: 20 });
    fc.assert(
      fc.property(linesArb, linesArb, (beforeLines, afterLines) => {
        const before = beforeLines.join('\n');
        const after = afterLines.join('\n');
        const marks = lineChanges(before, textOf(after));
        let state = stateOf(after);
        // Apply every hunk revert from bottom to top; the document must equal `before` exactly.
        for (let i = marks.length - 1; i >= 0; i--) {
          const spec = revertChangeMark(state.doc, marks[i]!);
          expect(spec).not.toBeNull();
          state = state.update({ changes: spec! }).state;
        }
        expect(state.doc.toString()).toBe(before);
      }),
      seeded({ numRuns: 500 }),
    );
  });
});
