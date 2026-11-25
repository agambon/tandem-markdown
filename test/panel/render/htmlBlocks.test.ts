// HTML blocks without a browser: which lines a wrapper hides, folds and aligns, and that a
// wrapper's drawing follows its pairing as it changes. What the drawings look like is checked
// in Chrome (harness/tests/html.spec.mjs).

import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createEditorState } from '../../../src/panel/editor';
import { withFullTree } from '../../../src/panel/render/framework';
import { drawn, fakeContext, lineClasses, moveTo, stateOf } from '../helpers';

/** What the HTML block feature draws, as `kind from-to class widget`, leaving out an empty class or widget. */
function htmlDrawing(state: EditorState): string[] {
  return drawn(state)
    .filter((d) => d.feature === 'htmlBlocks')
    .map((d) => [d.kind, `${d.from}-${d.to}`, d.className, d.widget].filter(Boolean).join(' '));
}

/** The 1-based numbers of the lines `state` hides or replaces with the HTML block feature. */
function hiddenLines(state: EditorState): number[] {
  const out: number[] = [];
  for (const d of drawn(state)) {
    if (d.feature !== 'htmlBlocks' || (d.kind !== 'hideLines' && d.kind !== 'replaceLines')) continue;
    const first = state.doc.lineAt(d.from).number;
    const last = state.doc.lineAt(d.to).number;
    for (let n = first; n <= last; n++) out.push(n);
  }
  return out;
}

const centered = 'Above.\n\n<div align="center">\n\nMiddle.\n\n</div>\n\nBelow.\n';

describe('a wrapper', () => {
  it('hides its tag lines with the blank line after each', () => {
    const state = stateOf(`‸${centered}`, { mode: 'view' });
    expect(hiddenLines(state)).toEqual([3, 4, 7, 8]);
  });

  it('shows a tag line while the cursor is on it in Rich editor', () => {
    const state = moveTo(stateOf(centered), centered.indexOf('<div'));
    expect(hiddenLines(state)).toEqual([7, 8]);
  });

  it('folds a <details> after its summary, unless it is written open or the selection is inside', () => {
    const details = '<details>\n<summary>More</summary>\n\nInside.\n\n</details>\n\nBelow.\n';
    expect(hiddenLines(stateOf(`${details}‸`, { mode: 'view' }))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hiddenLines(stateOf(`${details.replace('<details>', '<details open>')}‸`, { mode: 'view' }))).toEqual([
      1, 2, 6, 7,
    ]);
    const inside = moveTo(stateOf(details), details.indexOf('Inside'));
    expect(hiddenLines(inside)).toEqual([1, 2, 6, 7]);
  });

  it('folds a <details> whose <summary> follows a blank line, and redraws if text is inserted in between', () => {
    const blankSummary = '<details>\n\n<summary>More</summary>\n\nInside.\n\n</details>\n\nBelow.\n';
    const { ctx } = fakeContext();
    let state = withFullTree(createEditorState({ ctx, text: blankSummary, mode: 'view' }));
    const fresh = (s: EditorState) =>
      htmlDrawing(withFullTree(createEditorState({ ctx, text: s.doc.toString(), mode: 'view' })));
    expect(hiddenLines(state)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Inserting a paragraph between <details> and <summary> detaches the standalone summary.
    const gap = blankSummary.indexOf('\n\n') + 1;
    state = withFullTree(state.update({ changes: { from: gap, insert: '\nBetween.\n' } }).state);
    expect(htmlDrawing(state)).toEqual(fresh(state));
    // Removing that paragraph re-attaches the standalone summary.
    state = withFullTree(state.update({ changes: { from: gap, to: gap + '\nBetween.\n'.length } }).state);
    expect(htmlDrawing(state)).toEqual(fresh(state));
  });

  it('is drawn again whole when its closing tag goes, and when it comes back', () => {
    const { ctx } = fakeContext();
    let state = withFullTree(createEditorState({ ctx, text: centered, mode: 'view' }));
    const fresh = (s: EditorState) =>
      htmlDrawing(withFullTree(createEditorState({ ctx, text: s.doc.toString(), mode: 'view' })));
    const before = htmlDrawing(state);
    const close = state.doc.toString().indexOf('</div>');
    state = withFullTree(state.update({ changes: { from: close, to: close + '</div>'.length } }).state);
    expect(htmlDrawing(state)).toEqual(fresh(state));
    expect(htmlDrawing(state)).not.toEqual(before);
    state = withFullTree(state.update({ changes: { from: close, insert: '</div>' } }).state);
    expect(htmlDrawing(state)).toEqual(fresh(state));
    expect(htmlDrawing(state)).toEqual(before);
  });

  it('is drawn again when its alignment changes, though its extent does not', () => {
    const { ctx } = fakeContext();
    let state = withFullTree(createEditorState({ ctx, text: centered, mode: 'view' }));
    const before = lineClasses(state, 5);
    const at = centered.indexOf('center');
    state = withFullTree(state.update({ changes: { from: at, to: at + 'center'.length, insert: 'right' } }).state);
    const fresh = withFullTree(createEditorState({ ctx, text: state.doc.toString(), mode: 'view' }));
    expect(lineClasses(state, 5)).toEqual(lineClasses(fresh, 5));
    expect(lineClasses(state, 5)).not.toEqual(before);
  });

  it('pairs only among the blocks of one parent, here a list item', () => {
    // Paired, the closing tag's line is hidden; unpaired, it would show as code.
    const text = '- <div align="right">\n\n  Item.\n\n  </div>\n- next\n';
    const state = stateOf(`${text}‸`, { mode: 'view' });
    expect(hiddenLines(state)).toContain(5);
  });
});

describe('other HTML blocks', () => {
  it('show as code in a workspace VS Code does not trust', () => {
    const { ctx } = fakeContext({ settings: { workspaceTrusted: false } });
    const state = stateOf(`‸${centered}`, { mode: 'view', ctx });
    expect(hiddenLines(state)).toEqual([]);
    expect(htmlDrawing(state).some((d) => d.includes('Drawing'))).toBe(false);
  });
});
