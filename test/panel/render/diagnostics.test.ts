// Problems from VS Code in a headless panel: which messages are taken, the marks drawn for
// them in both views, and how they move with the text.

import type { EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { DiagnosticItem } from '../../../src/core/featureProtocol';
import { diagnosticsAt, diagnosticsOf, readDiagnostics, setDiagnostics } from '../../../src/panel/render/diagnostics';
import { stateOf } from '../helpers';

const TEXT = '# Notes\n\nA mispeled word in **bold** and a [link](gone.md).\n';

function problem(word: string, extra: Partial<DiagnosticItem> = {}): DiagnosticItem {
  const from = TEXT.indexOf(word);
  return {
    from,
    to: from + word.length,
    severity: 'warning',
    message: `About ${word}`,
    source: 'test',
    code: '',
    unnecessary: false,
    deprecated: false,
    ...extra,
  };
}

function given(state: EditorState, items: DiagnosticItem[]): EditorState {
  return state.update({ effects: setDiagnostics.of({ version: 0, items }) }).state;
}

/** Every problem mark: the text it covers and its class. */
function marks(state: EditorState): string[] {
  const out: string[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue;
    (source as DecorationSet).between(0, state.doc.length, (from, to, deco) => {
      const cls = String(deco.spec.class ?? '');
      if (cls.includes('tm-problem')) out.push(`${state.sliceDoc(from, to)}|${cls}`);
    });
  }
  return out;
}

describe('problems in the panel', () => {
  it('takes well-formed items and leaves out the rest', () => {
    const items = readDiagnostics([
      problem('mispeled'),
      { from: -1, to: 3, severity: 'error', message: 'x' },
      { from: 5, to: 2, severity: 'error', message: 'x' },
      { from: 1, to: 2, severity: 'fatal', message: 'x' },
      { from: 1, to: 2, severity: 'hint' },
      null,
      { from: 1, to: 2, severity: 'hint', message: 'kept', source: 4, code: {} },
    ]);
    expect(items.map((i) => i.message)).toEqual(['About mispeled', 'kept']);
    expect(items[1]).toMatchObject({ source: '', code: '', unnecessary: false, deprecated: false });
    expect(readDiagnostics('not a list')).toEqual([]);
  });

  it('marks each problem over its text, each severity and tag drawn its own way', () => {
    const state = given(stateOf(TEXT), [
      problem('mispeled', { severity: 'error' }),
      problem('word', { severity: 'information' }),
      problem('bold', { unnecessary: true }),
      problem('link', { severity: 'hint', deprecated: true }),
    ]);
    const found = marks(state).map((m) => m.split('|'));
    expect(found.map(([text]) => text)).toEqual(['mispeled', 'word', 'bold', 'link']);
    expect(new Set(found.map(([, cls]) => cls)).size).toBe(4);
  });

  it('draws them in Rich view as in Rich editor', () => {
    const items = [problem('mispeled')];
    expect(marks(given(stateOf(TEXT, { mode: 'view' }), items))).toEqual(marks(given(stateOf(TEXT), items)));
  });

  it('moves the marks with an edit before them, and drops one whose text is deleted', () => {
    let state = given(stateOf(TEXT), [problem('mispeled'), problem('word')]);
    state = state.update({ changes: { from: 0, insert: 'Intro.\n' } }).state;
    expect(marks(state).map((m) => m.split('|')[0])).toEqual(['mispeled', 'word']);
    const at = state.doc.toString().indexOf('mispeled');
    state = state.update({ changes: { from: at, to: at + 'mispeled '.length } }).state;
    expect(marks(state).map((m) => m.split('|')[0])).toEqual(['word']);
  });

  it('replaces every problem with the next set the host sends', () => {
    let state = given(stateOf(TEXT), [problem('mispeled'), problem('word')]);
    state = given(state, [problem('bold')]);
    expect(diagnosticsOf(state).map((d) => d.message)).toEqual(['About bold']);
    state = given(state, []);
    expect(marks(state)).toEqual([]);
  });

  it('finds the problems at a place, the most severe first, an edge counting', () => {
    const state = given(stateOf(TEXT), [
      problem('mispeled word', { severity: 'information', message: 'phrase' }),
      problem('mispeled', { severity: 'error', message: 'spelling' }),
    ]);
    const start = TEXT.indexOf('mispeled');
    expect(diagnosticsAt(state, start).map((d) => d.message)).toEqual(['spelling', 'phrase']);
    expect(diagnosticsAt(state, start + 'mispeled'.length).map((d) => d.message)).toEqual(['spelling', 'phrase']);
    expect(diagnosticsAt(state, start - 1)).toEqual([]);
  });
});
