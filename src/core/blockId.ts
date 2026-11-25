// Block ids, as Obsidian writes them: `^quote-1` at the end of a block's last line, or alone on
// the line after a list, a table or a quote. The panel fades or hides them; the host finds the
// block an embed or a link names by them.

import { isSpaceOrTab } from './markdownText';

const ID_CHARS = /^[A-Za-z0-9-]+$/;

/**
 * The id `line` ends with (`text ^quote-1`, or `^quote-1` alone), or null. The id is letters,
 * digits and dashes after a `^` that starts the line or follows a space or a tab. Only the
 * last `^` of the line is looked at.
 */
export function blockIdOf(line: string): string | null {
  const text = line.trimEnd();
  const caret = text.lastIndexOf('^');
  if (caret < 0) return null;
  const id = text.slice(caret + 1);
  if (!ID_CHARS.test(id)) return null;
  return caret === 0 || isSpaceOrTab(text.charCodeAt(caret - 1)) ? id : null;
}
