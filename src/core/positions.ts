// LF text as CodeMirror holds it, and the translation between VS Code's positions and LF
// offsets. Shared by the session, the gate, the coordinator, the host and PanelSync.

import { ChangeSet, Text } from '@codemirror/state';
import type { TextChange } from './diff';
import { toLf } from './eol';

/** One change of a VS Code change event, in VS Code's own terms (zero-based line and character). */
export interface EventChange {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** The inserted text as VS Code reports it (it may hold "\r\n"). */
  text: string;
}

export function textOf(lf: string): Text {
  return Text.of(lf.split('\n'));
}

/** A ChangeSet from ascending LF changes of a text of the given length. */
export function changeSetOf(changes: readonly TextChange[], length: number): ChangeSet {
  return ChangeSet.of(
    changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
    length,
  );
}

/**
 * Decodes ChangeSet JSON, refusing anything ChangeSet.fromJSON would accept but that is not
 * a change set (it takes negative and fractional lengths without complaint).
 */
export function decodeChangeSet(json: unknown): ChangeSet | null {
  if (!Array.isArray(json)) return null;
  for (const part of json) {
    if (typeof part === 'number') {
      if (!Number.isInteger(part) || part < 0) return null;
    } else if (Array.isArray(part)) {
      if (part.length === 0 || !Number.isInteger(part[0]) || (part[0] as number) < 0) return null;
      for (let i = 1; i < part.length; i++) if (typeof part[i] !== 'string') return null;
    } else {
      return null;
    }
  }
  try {
    return ChangeSet.fromJSON(json);
  } catch {
    return null;
  }
}

/**
 * VS Code change ranges (zero-based line and character, in the text before the event) as LF
 * offsets of `before`, with the inserted text turned into LF. Null when a range does not
 * fit `before`; the caller then rebuilds the change from the texts.
 */
export function eventChangesToLf(before: Text, changes: readonly EventChange[]): TextChange[] | null {
  const out: TextChange[] = [];
  for (const c of changes) {
    const from = offsetOf(before, c.range.start.line, c.range.start.character);
    const to = offsetOf(before, c.range.end.line, c.range.end.character);
    if (from === null || to === null || to < from) return null;
    out.push({ from, to, insert: toLf(c.text) });
  }
  return out;
}

/** The LF offset of a zero-based line and character, or null when it is outside the text. */
export function offsetOf(text: Text, line: number, character: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) return null;
  if (line >= text.lines) return null;
  const l = text.line(line + 1);
  if (character > l.length) return null;
  return l.from + character;
}

/** The zero-based line and character of an LF offset, as VS Code counts them. */
export function positionOf(text: Text, offset: number): { line: number; character: number } {
  const l = text.lineAt(offset);
  return { line: l.number - 1, character: offset - l.from };
}
