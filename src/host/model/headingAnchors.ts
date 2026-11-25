// Which heading a link's `#fragment` names.

import type { OutlineItem } from '../../core/outline';

/** A heading's anchor as GitHub makes it: lower case, punctuation gone, spaces to hyphens. */
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * The heading a fragment names, from the file's headings in order: by the id its attributes
 * give it (`## Title {#intro}`; `ids` in the same order), else by GitHub's anchor (the second
 * "Notes" heading is `notes-1`), else by its text (as a wikilink writes it), else by the
 * anchor of the fragment itself. -1 when none does.
 */
export function findHeading(
  headings: readonly string[],
  fragment: string,
  ids: readonly (string | undefined)[] = [],
): number {
  const wanted = fragment.trim();
  if (wanted === '') return -1;
  const byId = ids.indexOf(wanted);
  if (byId >= 0) return byId;
  const seen = new Map<string, number>();
  const slugs = headings.map((h) => {
    const base = slugOf(h);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  });
  const lower = wanted.toLowerCase();
  let i = slugs.indexOf(lower);
  if (i >= 0) return i;
  i = headings.findIndex((h) => h.trim().toLowerCase() === lower);
  if (i >= 0) return i;
  const slug = slugOf(wanted);
  return slug === '' ? -1 : slugs.findIndex((s, k) => s === slug || slugOf(headings[k]!) === slug);
}

/** Whether a note's outline has the heading `fragment` names, by `findHeading`. */
export function outlineHas(outline: readonly OutlineItem[], fragment: string): boolean {
  return (
    findHeading(
      outline.map((h) => h.anchorText ?? h.text),
      fragment,
      outline.map((h) => h.id),
    ) >= 0
  );
}
