// The lines of a text that differ from an earlier version of it, as Source's gutter marks
// them: lines added, lines changed, and the place where lines were removed. Lines are compared
// whole by the project's own sequence diff (diffStrings in src/core/sequenceDiff.ts), so a
// change inside a line marks that line as changed.

import type { Text } from '@codemirror/state';
import type { ChangeMark } from '../../core/featureProtocol';
import { diffStrings } from '../../core/sequenceDiff';

/**
 * Search work allowed for one comparison, in diffSequences' units. A few edits need a tiny
 * part of it; past it, what is not yet compared is marked as changed, so a file rewritten end
 * to end costs a bounded time on the extension host's thread.
 */
const MARKS_WORK = 2_000_000;
/** Longest original hunk text attached to a change mark for inline peek and revert. */
export const MAX_HUNK_ORIGINAL_CHARS = 8_000;

/**
 * The change marks that turn `before` into `after` (both LF texts), in offsets of `after`: an
 * added or changed run of lines from the start of its first line to the end of its last, and
 * removed lines at the start of the line that now follows them (or the end of the text).
 */
export function lineChanges(before: string, after: Text): ChangeMark[] {
  const afterText = after.toString();
  if (before === afterText) return [];
  const beforeLines = before.split('\n');
  const out: ChangeMark[] = [];
  for (const h of diffStrings(beforeLines, afterText.split('\n'), { left: MARKS_WORK })) {
    if (h.b2 === h.b1) {
      const afterEnd = h.b1 >= after.lines;
      const at = afterEnd ? after.length : after.line(h.b1 + 1).from;
      const original = beforeLines.slice(h.a1, h.a2).join('\n');
      const mark: ChangeMark = { kind: 'removed', from: at, to: at };
      if (original.length <= MAX_HUNK_ORIGINAL_CHARS) mark.original = original;
      if (afterEnd) mark.afterEnd = true;
      out.push(mark);
      continue;
    }
    const kind = h.a2 === h.a1 ? 'added' : 'changed';
    const mark: ChangeMark = {
      kind,
      from: after.line(h.b1 + 1).from,
      to: after.line(h.b2).to,
    };
    if (kind === 'changed') {
      const original = beforeLines.slice(h.a1, h.a2).join('\n');
      if (original.length <= MAX_HUNK_ORIGINAL_CHARS) mark.original = original;
    }
    out.push(mark);
  }
  return out;
}
