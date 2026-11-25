// A conflict file's name: the note's whole name plus `.conflict` (Field notes.md.conflict,
// todo.txt.conflict), so that nothing assumes the note ends in `.md`. A file so named is never a
// note: the rich views are not offered for it, outside changes are not merged into it, no backup
// is made of it, and no conflict file is written for it, even where a setting makes VS Code read
// it as markdown.

/** The ending a conflict file's name adds to its note's. */
export const CONFLICT_ENDING = '.conflict';

/** A conflict file's path or name, in any letter case. */
export function isConflictName(path: string): boolean {
  return path.toLowerCase().endsWith(CONFLICT_ENDING);
}

/** The path or name of the conflict file beside a note. */
export function conflictNameOf(path: string): string {
  return `${path}${CONFLICT_ENDING}`;
}
