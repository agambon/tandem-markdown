// Computes line-numbered clash passages (quoted user vs disk lines) for conflict files and
// Problems diagnostics.

import { diffChanges } from '../diff';
import type { MergeConflict } from '../merge3';
import { carryOffset, lineEndAt, lineSpanOf, lineStartAt, withoutBreak } from '../textLines';
import type { ClashPassage, Place } from './types';

/**
 * Extracts each conflicting passage where the user's words were kept in `mergedText`, returning
 * whole-line quotes of both sides along with the nearest heading/line anchor and zero-based line.
 */
export function clashPassages(
  mergedText: string,
  conflicts: readonly MergeConflict[],
  diskText: string,
): ClashPassage[] {
  const toDisk = diffChanges(mergedText, diskText);
  return conflicts.map((c) => {
    const start = lineStartAt(mergedText, c.from);
    const before = mergedText.slice(start, c.from);
    const after =
      c.ours.endsWith('\n') || c.to === mergedText.length || mergedText[c.to] === '\n'
        ? ''
        : mergedText.slice(c.to, lineEndAt(mergedText, c.to));
    const yours = c.ours === '' ? '' : withoutBreak(before + c.ours + after);

    const a = carryOffset(c.from, toDisk, 'start');
    const b = carryOffset(c.to, toDisk, 'end');
    let span = lineSpanOf(diskText, a, Math.max(a, b));
    const own = withoutBreak(versionChanged(c.base, c.theirs));
    const within = diskText.slice(span[0], span[1]);
    const k = own.trim() === '' ? -1 : within.indexOf(own);
    if (k >= 0 && within.indexOf(own, k + 1) < 0) span = lineSpanOf(diskText, span[0] + k, span[0] + k + own.length);
    const tookLines = own === '' && c.base.includes('\n');
    const theirs = tookLines ? '' : withoutBreak(diskText.slice(...span));

    return {
      yours,
      theirs,
      ...placeAt(mergedText, start),
      lineNumber: lineNumberAt(mergedText, start),
    };
  });
}

function versionChanged(base: string, theirs: string): string {
  const b = base.split('\n');
  const t = theirs.split('\n');
  let i = 0;
  while (i < b.length - 1 && i < t.length - 1 && b[i] === t[i]) i++;
  let j = 0;
  while (j < b.length - i && j < t.length - i && b[b.length - 1 - j] === t[t.length - 1 - j]) j++;
  return t.slice(i, t.length - j).join('\n');
}

export function placeAt(text: string, at: number): Place {
  const start = lineStartAt(text, at);
  if (text.slice(start).trim() === '') return { at: 'end', line: null };
  const lines = text.slice(0, Math.max(0, start - 1)).split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k]!.trim() !== '') return { at: 'after', line: lines[k]! };
  }
  return { at: 'start', line: null };
}

function lineNumberAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}
