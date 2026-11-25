// The problems VS Code holds for a document, as a panel draws them: each range clamped to the
// text and turned into LF offsets, an empty range widened to the word at it (as VS Code's own
// editor draws one), at most MAX_DIAGNOSTICS of them, the most severe kept first.

import type { Text } from '@codemirror/state';
import type { DiagnosticItem, DiagnosticSeverity } from '../../core/featureProtocol';

/** The most problems sent to a panel for one document. */
export const MAX_DIAGNOSTICS = 1000;
/** The longest message sent; a longer one is cut and ends with an ellipsis. */
export const MAX_MESSAGE_CHARS = 2000;
/** The longest source or code sent. */
const MAX_LABEL_CHARS = 200;
/** How far an empty range looks either side for the word it stands in. */
const MAX_WORD_CHARS = 100;

/** What the host reads off one `vscode.Diagnostic`. */
export interface RawDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** `vscode.DiagnosticSeverity`: 0 error, 1 warning, 2 information, 3 hint. */
  severity: number;
  message: string;
  source?: string | undefined;
  code?: string | number | { value: string | number } | undefined;
  /** `vscode.DiagnosticTag`: 1 unnecessary, 2 deprecated. */
  tags?: readonly number[] | undefined;
}

const SEVERITIES: readonly DiagnosticSeverity[] = ['error', 'warning', 'information', 'hint'];
const UNNECESSARY = 1;
const DEPRECATED = 2;

function severityOf(value: number): DiagnosticSeverity {
  return SEVERITIES[value] ?? 'information';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The LF offset of a position, held inside the text. */
function clamped(doc: Text, p: { line: number; character: number }): number {
  if (!Number.isFinite(p.line) || p.line < 0) return 0;
  if (p.line >= doc.lines) return doc.length;
  const line = doc.line(Math.floor(p.line) + 1);
  const character = Number.isFinite(p.character) ? Math.floor(p.character) : 0;
  return line.from + Math.max(0, Math.min(character, line.length));
}

const WORD = /[\p{L}\p{N}_'’-]/u;

/** The range an empty range at `at` is drawn over: the word around it, else one character beside it. */
export function widenEmpty(doc: Text, at: number): { from: number; to: number } {
  const line = doc.lineAt(at);
  const text = line.text;
  const i = at - line.from;
  let start = i;
  let end = i;
  while (start > 0 && i - start < MAX_WORD_CHARS && WORD.test(text.charAt(start - 1))) start--;
  while (end < text.length && end - i < MAX_WORD_CHARS && WORD.test(text.charAt(end))) end++;
  if (end > start) return { from: line.from + start, to: line.from + end };
  if (i < text.length) return { from: at, to: at + 1 };
  if (i > 0) return { from: at - 1, to: at };
  return { from: at, to: at };
}

function codeOf(code: RawDiagnostic['code']): string {
  if (code === undefined || code === null) return '';
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

/** The problems as the panel takes them, ordered by where they start. */
export function diagnosticItems(doc: Text, raw: readonly RawDiagnostic[]): DiagnosticItem[] {
  const kept = [...raw]
    .filter((d) => typeof d.message === 'string' && d.range)
    .sort((a, b) => (a.severity ?? 2) - (b.severity ?? 2))
    .slice(0, MAX_DIAGNOSTICS);
  const out: DiagnosticItem[] = [];
  for (const d of kept) {
    let from = clamped(doc, d.range.start);
    let to = clamped(doc, d.range.end);
    if (to < from) [from, to] = [to, from];
    if (to === from) ({ from, to } = widenEmpty(doc, from));
    const tags = d.tags ?? [];
    out.push({
      from,
      to,
      severity: severityOf(d.severity),
      message: clip(d.message, MAX_MESSAGE_CHARS),
      source: clip(typeof d.source === 'string' ? d.source : '', MAX_LABEL_CHARS),
      code: clip(codeOf(d.code), MAX_LABEL_CHARS),
      unnecessary: tags.includes(UNNECESSARY),
      deprecated: tags.includes(DEPRECATED),
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
