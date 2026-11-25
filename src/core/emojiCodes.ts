// Emoji codes: `:name:`, lower-case letters, digits, `_`, `+` and `-` between two colons. Every
// such shape is a code; only names on GitHub's list (gemoji's) stand for an emoji. GitHub matches
// with no regard to what stands around (`a:smile:b` holds one) and reads from the left, the first
// shape winning (`a:b:smile:` holds `:b:`). The panel's parser and the plain reading find codes
// here; the list is loaded by each side only once a file shows a code (panel/render/emoji.ts,
// host/model/notePreviewText.ts) and handed to what reads them.

import {
  CODE_COLON,
  CODE_DASH,
  CODE_LOWER_A,
  CODE_LOWER_Z,
  CODE_PLUS,
  CODE_UNDERSCORE,
  isAsciiDigit,
} from './markdownText';

/** Longer than any name on the list, so the scan from a colon stays short. */
const MAX_NAME_LENGTH = 64;

/** GitHub's list: each name with its emoji. */
export type EmojiNames = Readonly<Record<string, string>>;

/** How a reading takes emoji codes while the setting is on: from the list, once it has loaded. */
export interface EmojiCodes {
  /** The list; undefined until it has loaded, and every code stays as typed meanwhile. */
  readonly names: EmojiNames | undefined;
  /**
   * Called when a code is read while `names` is undefined, so the caller can load the list and
   * read again. It may be called more than once in one reading.
   */
  readonly wanted?: () => void;
}

function isNameChar(code: number): boolean {
  return (
    (code >= CODE_LOWER_A && code <= CODE_LOWER_Z) ||
    isAsciiDigit(code) ||
    code === CODE_UNDERSCORE ||
    code === CODE_PLUS ||
    code === CODE_DASH
  );
}

/**
 * The end (just past its closing colon) of the code that opens at `from` in `text`, or -1 when
 * none does. Nothing at or after `end` is read.
 */
export function emojiCodeEnd(text: string, from: number, end = text.length): number {
  if (text.charCodeAt(from) !== CODE_COLON) return -1;
  const limit = Math.min(end, from + 2 + MAX_NAME_LENGTH);
  let i = from + 1;
  while (i < limit && isNameChar(text.charCodeAt(i))) i++;
  return i > from + 1 && i < end && text.charCodeAt(i) === CODE_COLON ? i + 1 : -1;
}

/** The emoji a code (`:name:`, colons included) stands for, or undefined when its name is not on the list. */
export function emojiOf(names: EmojiNames, code: string): string | undefined {
  const name = code.slice(1, -1);
  return Object.hasOwn(names, name) ? names[name] : undefined;
}
