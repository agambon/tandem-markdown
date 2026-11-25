// A list of names as a sentence gives it: the one rule a list in a message, a warning or a
// conflict file is joined by.

/** The word before the last of a list's items. */
export const AND = 'and';

/** `items` as a sentence lists them: "A", "A and B", "A, B and C"; empty for none. */
export function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${AND} ${items[items.length - 1]!}`;
}
