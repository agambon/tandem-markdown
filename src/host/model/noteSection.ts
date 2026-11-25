// What an embed (`![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]`) shows of a note, as
// Obsidian embeds them: the note after its front matter; the section under a heading, the heading
// itself included, up to the next heading of its level or above; or the block that carries a
// block id. Also what a link to a block (`[[Note#^id]]`) previews.

import { blockIdOf } from '../../core/blockId';
import { findFrontmatterEnd } from '../../core/frontmatter';
import { buildOutline } from '../../core/outline';
import { findHeading } from './headingAnchors';

/** The largest note the host reads for an embed. A larger one is not shown. */
export const EMBED_MAX_BYTES = 256 * 1024;

type NotePart = { text: string } | { missing: 'heading' | 'block' };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/** The part of `lf` (a note's text) that `fragment` names: a heading's text, `^id`, or nothing for the whole note. */
export function notePart(lf: string, fragment: string | undefined): NotePart {
  if (!fragment) {
    const end = findFrontmatterEnd(lf);
    return { text: (end < 0 ? lf : lf.slice(end)).replace(/^\s*\n/, '').trimEnd() };
  }
  if (fragment.startsWith('^')) {
    const text = blockText(lf, fragment.slice(1));
    return text === null ? { missing: 'block' } : { text };
  }
  // Obsidian writes a heading under another as `Note#Outer#Inner`: the last one is meant.
  const wanted = fragment.slice(fragment.lastIndexOf('#') + 1);
  const headings = buildOutline(lf);
  const i = findHeading(
    headings.map((h) => h.anchorText ?? h.text),
    wanted,
  );
  if (i < 0) return { missing: 'heading' };
  const heading = headings[i]!;
  const next = headings.slice(i + 1).find((h) => h.level <= heading.level);
  return { text: lf.slice(heading.from, next ? next.from : lf.length).trimEnd() };
}

/**
 * The block of `lf` that carries the id `id`: the paragraph whose last line ends with it, the
 * list item that does, or, for an id alone on a line, the block just above it. Null when no
 * line outside code carries it.
 */
function blockText(lf: string, id: string): string | null {
  const lines = lf.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opens = FENCE.exec(line);
    if (fence) {
      if (opens && opens[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (opens) {
      fence = opens[1]!;
      continue;
    }
    if (blockIdOf(line) !== id) continue;
    if (line.trim() === `^${id}`) {
      // The block above, with or without a blank line between, as Obsidian writes one after a table.
      let end = i;
      while (end > 0 && lines[end - 1]!.trim() === '') end--;
      let start = end;
      while (start > 0 && lines[start - 1]!.trim() !== '') start--;
      return start < end ? lines.slice(start, end).join('\n') : null;
    }
    if (LIST_ITEM.test(line)) return line.trim();
    let start = i;
    while (start > 0 && lines[start - 1]!.trim() !== '' && !LIST_ITEM.test(lines[start - 1]!)) start--;
    return lines.slice(start, i + 1).join('\n');
  }
  return null;
}
