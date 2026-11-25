// Readers of small pieces of markdown source, shared by the host and the panel, and the character
// codes the core's readers compare by.

export const CODE_TAB = 9;
export const CODE_LF = 10;
const CODE_FF = 12;
export const CODE_CR = 13;
export const CODE_SPACE = 32;
export const CODE_DOUBLE_QUOTE = 34;
export const CODE_HASH = 35;
export const CODE_DOLLAR = 36;
export const CODE_SINGLE_QUOTE = 39;
export const CODE_OPEN_PAREN = 40;
export const CODE_PLUS = 43;
export const CODE_DASH = 45;
export const CODE_DOT = 46;
const CODE_DIGIT_0 = 48;
const CODE_DIGIT_9 = 57;
export const CODE_COLON = 58;
export const CODE_EQUALS = 61;
const CODE_UPPER_A = 65;
const CODE_UPPER_Z = 90;
export const CODE_OPEN_BRACKET = 91;
export const CODE_BACKSLASH = 92;
export const CODE_CLOSE_BRACKET = 93;
export const CODE_UNDERSCORE = 95;
export const CODE_BACKTICK = 96;
export const CODE_LOWER_A = 97;
export const CODE_LOWER_B = 98;
export const CODE_LOWER_Z = 122;
export const CODE_OPEN_BRACE = 123;
export const CODE_PIPE = 124;
export const CODE_CLOSE_BRACE = 125;

/** A space or a tab, by character code: the white space CommonMark allows inside a line. */
export function isSpaceOrTab(code: number): boolean {
  return code === CODE_SPACE || code === CODE_TAB;
}

/** The white space the HTML tokenizer reads between a tag's name and its attributes: tab, LF, FF, CR, space. */
export function isHtmlSpace(code: number): boolean {
  return code === CODE_SPACE || code === CODE_TAB || code === CODE_LF || code === CODE_FF || code === CODE_CR;
}

/** An ASCII letter, by character code: what may follow `<` or `</` in a tag. */
export function isAsciiLetter(code: number): boolean {
  return (code >= CODE_UPPER_A && code <= CODE_UPPER_Z) || (code >= CODE_LOWER_A && code <= CODE_LOWER_Z);
}

/** An ASCII digit, by character code. */
export function isAsciiDigit(code: number): boolean {
  return code >= CODE_DIGIT_0 && code <= CODE_DIGIT_9;
}

/** One ASCII punctuation character: the characters a backslash escapes (CommonMark). */
export const ESCAPABLE = /[!-/:-@[-`{-~]/;

const ESCAPE = new RegExp(`\\\\(${ESCAPABLE.source})`, 'g');

/** `text` with each backslash escape replaced by the character it escapes. */
export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPE, '$1');
}

/** The angle brackets of a destination written as `<my file.png>` removed, and the space around it. */
export function stripAngles(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}

/** Where a closing run of exactly `n` backticks starts at or after `from`, or -1. */
export function findBacktickRun(s: string, from: number, n: number): number {
  let i = s.indexOf('`', from);
  while (i >= 0) {
    let len = 1;
    while (s[i + len] === '`') len++;
    if (len === n) return i;
    i = s.indexOf('`', i + len);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tags

// Obsidian's rule: `#` at the start of a line or after white space, then a name of anything but
// white space, control characters and punctuation (`_`, `-` and `/` are not punctuation here),
// with at least one character that is not a digit. The two classes below are the inside of a
// regular expression's `[...]`, so the host's search pattern is built from them too.

/** The white space a tag follows and ends at: JavaScript's `\s`, by which Obsidian reads tags. */
export const TAG_SPACE = String.raw`\t-\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF`;
/** The rest of what ends a tag: controls, ASCII punctuation but `_ - /`, two blocks of Unicode punctuation. */
export const TAG_BREAKS = String.raw`\x00-\x08\x0E-\x1F!-,.:-@[-^\x60{-~\x7F-\x9F\u2000-\u206F\u2E00-\u2E7F`;
/** A tag name longer than this is text: nothing real comes near it, and the scan stays short. */
export const MAX_TAG_LENGTH = 200;

const SPACE = new RegExp(`[${TAG_SPACE}]`);
const TAG_NAME = new RegExp(`[^${TAG_SPACE}${TAG_BREAKS}]+`, 'y');

/** Whether a tag's `#` may stand after `before`, the character in front of it ('' at the start of a line). */
export function tagMayFollow(before: string): boolean {
  return before === '' || SPACE.test(before);
}

/**
 * The length of the tag name that starts at `from` in `text`, just after its `#`: 0 when there is
 * none, when it is all digits, or when it is longer than MAX_TAG_LENGTH.
 */
export function tagNameLength(text: string, from: number): number {
  TAG_NAME.lastIndex = from;
  const name = TAG_NAME.exec(text)?.[0] ?? '';
  return name.length <= MAX_TAG_LENGTH && /\D/.test(name) ? name.length : 0;
}
