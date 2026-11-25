// The word count the status bar shows: what is counted, and how the counts are written.

import { findFrontmatterEnd } from '../../core/frontmatter';
import { countWords } from '../../core/words';

export interface Counts {
  words: number;
  characters: number;
}

/** Numbers are written the English way to match the English words around them: 1,204. */
const NUMBER = new Intl.NumberFormat('en-US');

/**
 * "No words", "1 word", "1,204 words"; with a part of the whole (a selection), "0 of 1 word",
 * "37 of 1,204 words". The noun agrees with the whole. A whole of zero is "No words" even
 * with a part, since a part of nothing has nothing in it either.
 */
export function countText(total: number, part: number | null, one: string, many: string): string {
  if (total <= 0) return `No ${many}`;
  const noun = total === 1 ? one : many;
  if (part === null) return `${NUMBER.format(total)} ${noun}`;
  return `${NUMBER.format(part)} of ${NUMBER.format(total)} ${noun}`;
}

/** The count item's text (words) and tooltip (characters). `selected` is null with no selection. */
export function countTexts(total: Counts, selected: Counts | null): { text: string; tooltip: string } {
  return {
    text: countText(total.words, selected ? selected.words : null, 'word', 'words'),
    tooltip: countText(total.characters, selected ? selected.characters : null, 'character', 'characters'),
  };
}

/**
 * Where the counted text starts: just after the front matter block's closing line, or 0 when
 * the text has no front matter. The rule is the panel's own (core/frontmatter.ts), so the
 * count leaves out exactly what the panel draws as front matter. `lf` has LF line breaks only.
 */
export function bodyStart(lf: string): number {
  return Math.max(0, findFrontmatterEnd(lf));
}

/** Words and characters of the text after the front matter. */
export function countBody(lf: string, start: number): Counts {
  return countWords(start > 0 ? lf.slice(start) : lf);
}

/**
 * Words and characters of the selected text, leaving out any part of the selection inside the
 * front matter (so a selection is never more than the whole). Null when nothing is selected.
 * The offsets are LF offsets, as the panel reports them; they are clamped to the text.
 */
export function countSelection(
  lf: string,
  start: number,
  selection: { anchor: number; head: number } | undefined,
): Counts | null {
  if (!selection) return null;
  const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(lf.length, Math.floor(n))) : 0);
  const a = clamp(selection.anchor);
  const h = clamp(selection.head);
  if (a === h) return null;
  const from = Math.max(Math.min(a, h), start);
  const to = Math.max(Math.max(a, h), start);
  return countWords(lf.slice(from, to));
}
