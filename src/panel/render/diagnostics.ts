// Problems VS Code knows of in the document (a spell checker's, a linter's, the markdown link
// check's), drawn at their ranges in both views: a wavy underline in the problem's color, a
// faded range for unused text, a struck one for deprecated text. The host sends every problem
// with each change (`diagnostics`); hostRanges.ts places them in this panel's text and carries
// them over every edit. They are marks only, which change no text and no line's height, drawn
// from the field that holds them, as the outside-change mark is; CodeMirror draws in the page
// only those near the window. A table's cells show them too (`markSources`). The hover card and
// the quick fixes are ui/problemCard.ts.

import { RangeSetBuilder, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { DiagnosticItem, DiagnosticSeverity } from '../../core/featureProtocol';
import type { Feature } from '../features';
import { hostRangeField, listenForHostSet, mapInner } from '../hostRanges';
import { markSources } from './framework';

/** The most problems a panel takes from one message (the host sends no more than this). */
const MAX_TAKEN = 1000;

const SEVERITIES: readonly DiagnosticSeverity[] = ['error', 'warning', 'information', 'hint'];

const problems = hostRangeField<DiagnosticItem>(mapInner);

/** The effect that hands the panel a set of problems, as the host sent it. */
export const setDiagnostics = problems.set;

/** The problems the panel holds, where they now stand in its text. */
export function diagnosticsOf(state: EditorState): readonly DiagnosticItem[] {
  return state.field(problems.field, false)?.items ?? [];
}

/** The problems whose range holds `pos` (an edge counts), most severe first. */
export function diagnosticsAt(state: EditorState, pos: number): DiagnosticItem[] {
  return diagnosticsOf(state)
    .filter((d) => d.from <= pos && d.to >= pos && d.to > d.from)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

/** The items of a `diagnostics` message that are well formed, at most MAX_TAKEN. */
export function readDiagnostics(value: unknown): DiagnosticItem[] {
  if (!Array.isArray(value)) return [];
  const out: DiagnosticItem[] = [];
  for (const v of value) {
    const d = v as Partial<DiagnosticItem> | null;
    if (
      !d ||
      !Number.isInteger(d.from) ||
      !Number.isInteger(d.to) ||
      d.from! < 0 ||
      d.to! < d.from! ||
      !SEVERITIES.includes(d.severity as DiagnosticSeverity) ||
      typeof d.message !== 'string'
    )
      continue;
    out.push({
      from: d.from!,
      to: d.to!,
      severity: d.severity!,
      message: d.message,
      source: typeof d.source === 'string' ? d.source : '',
      code: typeof d.code === 'string' ? d.code : '',
      unnecessary: d.unnecessary === true,
      deprecated: d.deprecated === true,
    });
    if (out.length >= MAX_TAKEN) break;
  }
  return out;
}

const MARKS = new Map<string, Decoration>();

function markOf(d: DiagnosticItem): Decoration {
  const cls = d.unnecessary
    ? 'tm-problem tm-problem-unnecessary'
    : `tm-problem tm-problem-${d.severity}${d.deprecated ? ' tm-problem-deprecated' : ''}`;
  let mark = MARKS.get(cls);
  if (!mark) MARKS.set(cls, (mark = Decoration.mark({ class: cls })));
  return mark;
}

/** The marks for the problems in `state`, empty ones left out. */
function marksOf(state: EditorState): DecorationSet {
  const items = diagnosticsOf(state);
  if (items.length === 0) return Decoration.none;
  const length = state.doc.length;
  const ranges = items
    .filter((d) => d.to > d.from && d.from < length)
    .map((d) => markOf(d).range(d.from, Math.min(d.to, length)));
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.value);
  return builder.finish();
}

const marksByField = new WeakMap<object, DecorationSet>();

/** The marks for the problems in `state`, kept while the problems it holds stay the same. */
function heldMarks(state: EditorState): DecorationSet {
  const held = state.field(problems.field, false);
  if (!held) return Decoration.none;
  let marks = marksByField.get(held);
  if (!marks) marksByField.set(held, (marks = marksOf(state)));
  return marks;
}

export const diagnostics: Feature = {
  id: 'diagnostics',
  extension: () => [
    problems.field,
    listenForHostSet('diagnostics', 'items', readDiagnostics, setDiagnostics),
    EditorView.decorations.compute([problems.field], heldMarks),
    // A table's cells show them too.
    markSources.of({
      marks: heldMarks,
      changed: (tr) => tr.startState.field(problems.field, false) !== tr.state.field(problems.field, false),
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-problem': { textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
      '& .cm-content .tm-problem-error': {
        textDecoration: 'underline wavy var(--vscode-editorError-foreground, #f14c4c)',
      },
      '& .cm-content .tm-problem-warning': {
        textDecoration: 'underline wavy var(--vscode-editorWarning-foreground, #cca700)',
      },
      '& .cm-content .tm-problem-information': {
        textDecoration: 'underline wavy var(--vscode-editorInfo-foreground, #3794ff)',
      },
      '& .cm-content .tm-problem-hint': {
        textDecoration: 'underline dotted var(--vscode-editorHint-foreground, rgba(238, 238, 238, 0.7))',
      },
      '& .cm-content .tm-problem-deprecated': { textDecorationLine: 'underline line-through' },
      '& .cm-content .tm-problem-unnecessary': { opacity: '0.67' },
    }),
  ],
};
