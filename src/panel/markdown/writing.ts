// Rules for writing markdown text that the commands and paste share: a link's destination as
// markdown accepts it, and the longest run of a mark character, which a code span's fence must
// outgrow.

/** The length of the longest run of `char` in `text`. */
export function longestRun(text: string, char: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

function balancedParens(text: string): boolean {
  let depth = 0;
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** A link or image destination for `address`: as written when it can be, else in angle brackets. */
export function linkDestination(address: string): string {
  if (!/[\s<>]/.test(address) && balancedParens(address)) return address;
  return `<${address.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
}
