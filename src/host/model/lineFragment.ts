// A link to a line, `notes.md#L12`, read as VS Code's markdown extension reads one: `L12` or
// `12`, with an optional column (`L12,5`) and an optional end (`L12-L20`), the letter in any
// case. A heading or anchor of that name comes first; this is what a `#fragment` reaches when
// the file has none.

const LINE = /^L?(\d+)(?:,\d+)?(?:-L?\d+(?:,\d+)?)?$/i;

/**
 * Where the line `fragment` names starts in `text` (LF line endings), or -1 when `fragment` does
 * not name a line. A line past the end is the last line, as in VS Code.
 */
export function findLine(text: string, fragment: string): number {
  const match = LINE.exec(fragment.trim());
  if (!match) return -1;
  const line = Number(match[1]);
  if (!Number.isSafeInteger(line) || line < 1) return -1;
  let from = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', from);
    if (next < 0) break;
    from = next + 1;
  }
  return from;
}
