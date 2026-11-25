// The characters words are made of, for everything in the core that tells a word from the text
// around it: the comparison, the merge, the judgment of saves and the word counts. Each class is
// the inside of a regular expression's `[...]`, so patterns are built from it.

/** A letter or a digit, in any script. */
export const LETTER_OR_DIGIT = '\\p{L}\\p{N}';

/** A character a word may hold: a letter or a digit, a combining mark, or joining punctuation such as `_`. */
export const WORD_CHARACTER = '\\p{L}\\p{N}\\p{M}\\p{Pc}';

/** The Chinese and Japanese characters, each of which is a word of its own. */
export const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';

const ANY_LETTER_OR_DIGIT = new RegExp(`[${LETTER_OR_DIGIT}]`, 'u');

/** True when `ch` is a letter or a digit; false for undefined. Plain ASCII is told without the pattern, which is slower. */
export function isLetterOrDigit(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  if (ch < '\u0080') return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
  return ANY_LETTER_OR_DIGIT.test(ch);
}

/** True when `text[i]` is a letter or a digit; false outside the text. */
export function letterOrDigitAt(text: string, i: number): boolean {
  return isLetterOrDigit(text[i]);
}

/** True when `text` holds a letter or a digit anywhere. */
export function hasLetterOrDigit(text: string): boolean {
  return ANY_LETTER_OR_DIGIT.test(text);
}
