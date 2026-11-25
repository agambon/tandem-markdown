// Copy Relative Path with Line Numbers: a pointer to the lines selected in a rich tab, to paste
// into any agent's chat, as `notes/Field notes.md:12-18` (one line: `notes/Field notes.md:12`).
// The path is the note's from its workspace folder, or its full path outside one, with forward
// slashes on every system. The lines are the file's, as Source numbers them.

/** The message when the note has no file yet. */
export const NO_PATH_YET = 'Save this note first: it has no path yet.';

/** The message after copying `reference`; `unsaved`: the note has changes not yet saved. */
export function copiedMessage(reference: string, unsaved: boolean): string {
  const copied = `${reference} is on the clipboard.`;
  return unsaved ? `${copied} Save the note so that an agent reading the file finds the same lines.` : copied;
}

/**
 * The first and last line (one-based) a selection covers in `text` (LF text; `anchor` and `head`
 * are offsets in it). Nothing selected: the line the cursor is on. A selection that ends at the
 * very start of a line leaves that line out, as selecting whole lines does.
 */
export function selectedLines(text: string, anchor: number, head: number): { first: number; last: number } {
  const clamp = (offset: number) => Math.max(0, Math.min(text.length, offset));
  const from = clamp(Math.min(anchor, head));
  let to = clamp(Math.max(anchor, head));
  if (to > from && text[to - 1] === '\n') to--;
  const lineOf = (offset: number) => {
    let line = 1;
    for (let at = text.indexOf('\n'); at >= 0 && at < offset; at = text.indexOf('\n', at + 1)) line++;
    return line;
  };
  const first = lineOf(from);
  return { first, last: to === from ? first : lineOf(to) };
}

/**
 * The note's path as copied: from its workspace folder (`folderPath`, the folder's uri path) when
 * it is in one, else its full path (`fsPath`); with forward slashes either way.
 */
export function referencePath(note: { path: string; fsPath: string }, folderPath: string | undefined): string {
  if (folderPath !== undefined) {
    const folder = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
    // VS Code found the note in the folder; a drive letter may differ in case between the two.
    if (note.path.toLowerCase().startsWith(folder.toLowerCase())) return note.path.slice(folder.length);
  }
  return note.fsPath.replace(/\\/g, '/');
}

/** `path:12`, or `path:12-18` for more than one line. */
export function lineReference(path: string, lines: { first: number; last: number }): string {
  return lines.last > lines.first ? `${path}:${lines.first}-${lines.last}` : `${path}:${lines.first}`;
}
