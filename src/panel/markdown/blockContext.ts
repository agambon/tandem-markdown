// What a block parser can read beyond the line it is on. The base parse wrapper (reparse.ts)
// records, for each parse, the text it reads and where the front matter ends, for the parsers
// that look further down than the next line; and `reached` reads how many open blocks a line
// continues, which @lezer/markdown keeps on the line but leaves out of its typings.

import type { Input } from '@lezer/common';
import type { BlockContext, Line } from '@lezer/markdown';

/** What the wrapper records of one parse. */
interface ParseFacts {
  input: Input;
  /** End of the front matter's closing line (the offset just before its line break), or -1. */
  frontmatterEnd: number;
}

const facts = new WeakMap<object, ParseFacts>();

/** Records the text `parse` reads and where its front matter ends (-1 for none). */
export function recordParse(parse: object, input: Input, frontmatterEnd: number): void {
  facts.set(parse, { input, frontmatterEnd });
}

/** The text the parse `cx` reads. */
export function parseInput(cx: BlockContext): Input | undefined {
  return facts.get(cx)?.input;
}

/** Where the front matter of the parse `cx` ends, or -1 when the file opens with none. */
export function frontmatterEndIn(cx: BlockContext): number {
  return facts.get(cx)?.frontmatterEnd ?? -1;
}

/**
 * How many of the open blocks the current line continues. @lezer/markdown keeps this on the
 * line (its own fenced code reads it the same way) but leaves it out of its typings.
 */
export function reached(line: Line): number {
  return (line as unknown as { depth: number }).depth;
}
