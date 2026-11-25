// The one front matter rule, used by the panel's parser, the outline and the word count. A block
// starts on line 1, exactly `---` (YAML) or `+++` (TOML, as Hugo writes it), and runs to the next
// line that closes it: exactly `---` or `...` for YAML, `+++` for TOML; an unclosed block is none.
// The panel also reads JSON front matter behind a setting (markdown/frontmatter.ts).

/** Text read by position: a string, or a parser's input (Lezer's `Input` fits). */
export interface ReadableText {
  readonly length: number;
  read(from: number, to: number): string;
}

/** How much is read at a time from a `ReadableText`. */
const BLOCK = 4096;

/** The lines that close a block, by its opening line. */
const CLOSERS = new Map<string, readonly string[]>([
  ['---', ['---', '...']],
  ['+++', ['+++']],
]);

/**
 * Where the front matter at the start of `text` ends: the offset just after the closing line's
 * last character (before its line break), or -1 when the text does not start with a closed
 * block. A text that does not open one is read no further than its first four characters;
 * one that does, a block at a time up to the closing line.
 */
export function findFrontmatterEnd(text: string | ReadableText): number {
  const source: ReadableText =
    typeof text === 'string' ? { length: text.length, read: (from, to) => text.slice(from, to) } : text;
  if (source.length < 4) return -1;
  const start = source.read(0, 4);
  return start[3] === '\n' ? findClosingLine(source, CLOSERS.get(start.slice(0, 3)), 4) : -1;
}

/**
 * The end of the first line from offset `from` of `source` that is exactly one of `closers`,
 * or -1. `source` must hold a line break just before `from`.
 */
export function findClosingLine(source: ReadableText, closers: readonly string[] | undefined, from: number): number {
  const length = source.length;
  if (!closers || source.read(from - 1, from) !== '\n') return -1;
  const size = closers[0]!.length;
  // `buffer` holds the text from `bufferFrom`; it always starts at or before the current line.
  let bufferFrom = from;
  let buffer = source.read(from, Math.min(length, from + BLOCK));
  let lineFrom = from;
  for (;;) {
    let nl = buffer.indexOf('\n', lineFrom - bufferFrom);
    while (nl < 0 && bufferFrom + buffer.length < length) {
      const readTo = bufferFrom + buffer.length;
      const more = source.read(readTo, Math.min(length, readTo + BLOCK));
      if (!more) return -1; // a reader that gives nothing more: never loop on it
      buffer = buffer.slice(lineFrom - bufferFrom) + more;
      bufferFrom = lineFrom;
      nl = buffer.indexOf('\n', lineFrom - bufferFrom);
    }
    const lineTo = nl < 0 ? bufferFrom + buffer.length : bufferFrom + nl;
    if (lineTo - lineFrom === size && closers.includes(buffer.slice(lineFrom - bufferFrom, lineTo - bufferFrom))) {
      return lineTo;
    }
    if (lineTo >= length) return -1;
    lineFrom = lineTo + 1;
  }
}
