// Where a change between two texts is placed. A character diff starts each insertion and deletion
// at the first offset the text allows, and may match an old word against pieces of a new one;
// alignToWords joins such pieces and moves each change to word boundaries, so a panel's unsent
// edits and cursors mapped through it stay where the user meant (docs/ARCHITECTURE.md, "Where a
// change is placed").

import { type TextChange, diffChanges, isHighSurrogate, isLowSurrogate } from './diff';
import { isLetterOrDigit, letterOrDigitAt } from './wordChars';

/**
 * diffChanges, aligned by alignToWords. A character diff places "jacket " inserted before "jumps"
 * as "acket j" after the "j", and a concurrent deletion of "jumps" would leave "acket j" behind. The
 * text is always the same: applyChanges(a, alignedDiff(a, b)) === b.
 */
export function alignedDiff(a: string, b: string): TextChange[] {
  return alignToWords(a, diffChanges(a, b));
}

/**
 * The same edit as `given`, in the fewest changes sliding allows, each on word boundaries: a pure
 * change that can slide to touch its neighbor joins it, to a fixed point; each one left rests at
 * its best place; one still inside a word or a bracket around one, or extending a word, becomes a
 * replacement of the whole word and its bracket.
 */
export function alignToWords(text: string, given: readonly TextChange[]): TextChange[] {
  const changesText = (c: TextChange) => c.insert.length !== c.to - c.from || c.insert !== text.slice(c.from, c.to);
  const input = given.flatMap((c) => clearShapes(text, c)).filter(changesText);
  // Changes clearShapes would leave as they are and that change the text: no need to look again.
  const settled = new Set<TextChange>(input);
  const out: TextChange[] = [];
  // Changes split off a replacement, nearest last: they come before input[i].
  const pending: TextChange[] = [];
  // Replacements already split, by content: one that its own pieces make again is kept.
  const alreadySplit = new Set<string>();
  // Each replacement kept so, with the change that came after it then. Its pieces were weighed
  // against that change, and are weighed again once a different one, finished, stands there.
  const keptBefore = new Map<TextChange, TextChange | undefined>();
  const keyOf = (c: TextChange) => `${c.from} ${c.to} ${c.insert}`;
  const peek = () => (pending.length > 0 ? pending[pending.length - 1] : input[i]);
  const take = () => (pending.length > 0 ? pending.pop()! : input[i++]!);
  // The change last put at its resting place: looked at again, it has no better one.
  let atRest: TextChange | null = null;
  let i = 0;
  while (pending.length > 0 || i < input.length) {
    let c = take();
    for (;;) {
      const prev = out[out.length - 1];
      const next = peek();
      const lo = prev ? prev.to : 0;
      const hi = next ? next.from : text.length;
      const left = isPure(c) ? reach(text, c, -1, lo) : 0;
      const withPrev = prev ? join(text, prev, c, isPure(prev) ? reach(text, prev, 1, c.from) : 0, left) : null;
      if (withPrev) {
        out.pop();
        c = withPrev;
        continue;
      }
      const right = isPure(c) ? reach(text, c, 1, hi) : 0;
      const withNext = next ? join(text, c, next, right, isPure(next) ? reach(text, next, -1, c.to) : 0) : null;
      if (withNext) {
        take();
        c = withNext;
        continue;
      }
      const rested: TextChange = c !== atRest && (left > 0 || right > 0) ? restingPlace(text, c, left, right) : c;
      atRest = rested;
      const placed = widenToWords(text, rested, lo, hi);
      if (placed !== c) {
        // Moved or wider, it may be within the reach of a neighbor, or touch one.
        c = placed;
        continue;
      }
      if (!isPure(placed) && !settled.has(placed)) {
        if (!changesText(placed)) {
          // An insertion and a deletion of the same text, joined: it goes, and the change
          // before it is looked at again with its new neighbor.
          if (out.length === 0) break;
          c = out.pop()!;
          continue;
        }
        // Joining, widening and trimming can make a replacement that splitAround would split:
        // it is split as the given ones were, unless it is what its own pieces made again.
        const pieces = clearShapes(text, placed);
        if (pieces.length > 1 || pieces[0] !== placed) {
          const key = keyOf(placed);
          if (!alreadySplit.has(key)) {
            alreadySplit.add(key);
            for (const p of pieces) if (changesText(p)) settled.add(p);
            for (let k = pieces.length - 1; k > 0; k--) pending.push(pieces[k]!);
            c = pieces[0]!;
            continue;
          }
          keptBefore.set(placed, next);
        }
      }
      if (prev && keptBefore.has(prev) && keptBefore.get(prev) !== placed) {
        out.pop();
        keptBefore.delete(prev);
        alreadySplit.delete(keyOf(prev));
        pending.push(placed);
        c = prev;
        continue;
      }
      out.push(placed);
      break;
    }
  }
  return out;
}

const SPACE = /\s/;

/** True for white space, as SPACE matches it; plain ASCII is told without the pattern. */
function isSpaceChar(ch: string): boolean {
  if (ch < '\u0080') return ch === ' ' || (ch >= '\t' && ch <= '\r');
  return SPACE.test(ch);
}

/**
 * splitAround and keepOuterBrackets until neither changes anything: `c` alone, itself, when
 * neither changes it. Split pieces are pure, which keepOuterBrackets leaves alone; a trimmed
 * replacement may hold what it replaces whole, and is split in its turn.
 */
function clearShapes(text: string, c: TextChange): TextChange[] {
  const pieces = splitAround(text, c);
  if (pieces.length > 1) return pieces;
  const trimmed = keepOuterBrackets(text, pieces[0]!);
  return trimmed === pieces[0] ? pieces : clearShapes(text, trimmed);
}

/**
 * A replacement whose range includes the bracket that opens the word after it (or closes the one
 * before), and inserts the same bracket there, leaves that bracket alone, so a panel's unsent
 * typing just before `[9]` is not mapped inside it. Returns `c` itself when it trims nothing.
 */
function keepOuterBrackets(text: string, c: TextChange): TextChange {
  if (c.from === c.to || c.insert.length === 0) return c;
  let { from, to, insert } = c;
  while (
    to > from &&
    insert.length > 0 &&
    OPENERS.includes(text[to - 1]!) &&
    insert.endsWith(text[to - 1]!) &&
    letterOrDigitAt(text, to)
  ) {
    to--;
    insert = insert.slice(0, -1);
  }
  while (
    from < to &&
    insert.length > 0 &&
    CLOSERS.includes(text[from]!) &&
    insert.startsWith(text[from]!) &&
    letterOrDigitAt(text, from - 1)
  ) {
    from++;
    insert = insert.slice(1);
  }
  return from === c.from && to === c.to ? c : { from, to, insert };
}

/**
 * A change that starts or ends inside a word, extends a word, or starts or ends just inside a
 * bracket around one, widened to the whole word and bracket within [lo, hi) (the text is the same:
 * what the wider range covers is inserted again); `c` itself when it needs none. Otherwise `cat`
 * made `cats` is an insertion of `s` that an unsent deletion of `cat` leaves behind, and an unsent
 * deletion of an old `[2]` can delete a new token's bracket.
 */
function widenToWords(text: string, c: TextChange, lo: number, hi: number): TextChange {
  let { from, to, insert } = c;
  for (let wider = true; wider;) {
    wider = false;
    const takes = from < to;
    if (
      from > lo &&
      letterOrDigitAt(text, from - 1) &&
      (letterOrDigitAt(text, from) || isLetterOrDigit(insert[0]) || (takes && isCloser(text[from])))
    ) {
      while (from > lo && letterOrDigitAt(text, from - 1)) {
        insert = text[from - 1] + insert;
        from--;
      }
      wider = true;
    }
    if (from > lo && isOpener(text[from - 1]) && (letterOrDigitAt(text, from) || isLetterOrDigit(insert[0]))) {
      insert = text[from - 1] + insert;
      from--;
      wider = true;
    }
    if (
      to < hi &&
      letterOrDigitAt(text, to) &&
      (letterOrDigitAt(text, to - 1) || isLetterOrDigit(insert[insert.length - 1]) || (takes && isOpener(text[to - 1])))
    ) {
      while (to < hi && letterOrDigitAt(text, to)) {
        insert += text[to];
        to++;
      }
      wider = true;
    }
    if (
      to < hi &&
      isCloser(text[to]) &&
      (letterOrDigitAt(text, to - 1) || isLetterOrDigit(insert[insert.length - 1]))
    ) {
      insert += text[to];
      to++;
      wider = true;
    }
  }
  return from === c.from && to === c.to ? c : { from, to, insert };
}

/**
 * Splits a replacement whose inserted text holds the replaced text whole into the two insertions
 * around it (and the reverse, into two deletions); `c` alone otherwise. Else `[2]  ` and ` [1] `
 * added around `[9]` is one replacement of `9]`, onto which an unsent deletion of `[9]` maps.
 */
function splitAround(text: string, c: TextChange): TextChange[] {
  const old = text.slice(c.from, c.to);
  const i = old.length > 0 && c.insert.length > old.length ? keptAt(c.insert, old) : -1;
  // The kept text must not start or end between the halves of a surrogate pair, which a lone
  // surrogate on one side can form with its other half on the other.
  if (i >= 0 && !splitsPair(c.insert, i) && !splitsPair(c.insert, i + old.length)) {
    const out: TextChange[] = [];
    if (i > 0) out.push({ from: c.from, to: c.from, insert: c.insert.slice(0, i) });
    const rest = c.insert.slice(i + old.length);
    if (rest.length > 0) out.push({ from: c.to, to: c.to, insert: rest });
    return out;
  }
  const j = c.insert.length > 0 && old.length > c.insert.length ? keptAt(old, c.insert) : -1;
  if (j >= 0 && !splitsPair(old, j) && !splitsPair(old, j + c.insert.length)) {
    const out: TextChange[] = [];
    if (j > 0) out.push({ from: c.from, to: c.from + j, insert: '' });
    if (c.from + j + c.insert.length < c.to) out.push({ from: c.from + j + c.insert.length, to: c.to, insert: '' });
    return out;
  }
  return [c];
}

/**
 * Where the kept text sits in the other: at an end when it can (one pure change, then slid to
 * a word boundary), else its first place. In `19]  [9` the kept `9` is the last one.
 */
function keptAt(outer: string, inner: string): number {
  return outer.endsWith(inner) ? outer.length - inner.length : outer.startsWith(inner) ? 0 : outer.indexOf(inner);
}

/** A pure insertion (an empty range) or a pure deletion (nothing inserted): the changes that slide. */
function isPure(c: TextChange): boolean {
  return c.from === c.to || c.insert.length === 0;
}

/**
 * How far the pure change `c` can slide (right for 1, left for -1) through the unchanged text before
 * `limit`, making the same text: an insertion rotates, a deletion moves. It never stops inside a
 * surrogate pair, in the old text or the new.
 */
function reach(text: string, c: TextChange, dir: 1 | -1, limit: number): number {
  let k = 0;
  if (c.from === c.to) {
    const s = c.insert;
    const n = s.length;
    // s[i] and the character after it, round the end, are the halves of a pair.
    const pairAt = (i: number) => isHighSurrogate(s.charCodeAt(i)) && isLowSurrogate(s.charCodeAt((i + 1) % n));
    if (dir > 0) {
      while (
        c.from + k < limit &&
        text[c.from + k] === s[k % n] &&
        !splitsPair(text, c.from + k + 1) &&
        !pairAt(k % n)
      ) {
        k++;
      }
    } else {
      while (
        c.from - k > limit &&
        text[c.from - k - 1] === s[n - 1 - (k % n)] &&
        !splitsPair(text, c.from - k - 1) &&
        !pairAt((((n - 2 - k) % n) + n) % n)
      ) {
        k++;
      }
    }
  } else if (dir > 0) {
    while (
      c.to + k < limit &&
      text[c.from + k] === text[c.to + k] &&
      !splitsPair(text, c.from + k + 1) &&
      !splitsPair(text, c.to + k + 1)
    ) {
      k++;
    }
  } else {
    while (
      c.from - k > limit &&
      text[c.from - k - 1] === text[c.to - k - 1] &&
      !splitsPair(text, c.from - k - 1) &&
      !splitsPair(text, c.to - k - 1)
    ) {
      k++;
    }
  }
  return k;
}

/** The pure change `c` slid `k` places (right when positive), which must be within its reach. */
function slide(c: TextChange, k: number): TextChange {
  if (k === 0) return c;
  if (c.from < c.to) return { from: c.from + k, to: c.to + k, insert: '' };
  const n = c.insert.length;
  const m = ((k % n) + n) % n;
  return { from: c.from + k, to: c.to + k, insert: c.insert.slice(m) + c.insert.slice(0, m) };
}

/** What fit() needs of a change: its range and the first and last characters it inserts. */
interface Edges {
  from: number;
  to: number;
  first: string | undefined;
  last: string | undefined;
}

/** The edges of the pure change `c` slid `k` places, without building its text. */
function slidEdges(c: TextChange, k: number): Edges {
  if (c.from < c.to) return { from: c.from + k, to: c.to + k, first: undefined, last: undefined };
  const s = c.insert;
  const n = s.length;
  return { from: c.from + k, to: c.to + k, first: s[((k % n) + n) % n], last: s[(((k - 1) % n) + n) % n] };
}

/**
 * The one change that `a` and the change after it, `b`, become when one of them can slide
 * through the unchanged text between them until it touches the other, or null. `right` is how
 * far `a` reaches to the right (up to b.from) and `left` how far `b` reaches to the left (down
 * to a.to); only a pure change slides.
 */
function join(text: string, a: TextChange, b: TextChange, right: number, left: number): TextChange | null {
  const gap = b.from - a.to;
  const aSlides = right >= gap;
  if (!aSlides && left < gap) return null;
  // How far `a` slides; `b` slides the rest of the gap.
  let x = aSlides ? gap : 0;
  if (aSlides && left >= gap && isPure(a) && isPure(b) && (a.from === a.to) !== (b.from === b.to)) {
    // An insertion and a deletion become a replacement, which slides no further, and either
    // can do the sliding: the better fit is taken, the further right of equals.
    const fitAfter = (k: number) => {
      const ea = slidEdges(a, k);
      const eb = slidEdges(b, k - gap);
      return fit(text, { from: ea.from, to: eb.to, first: ea.first ?? eb.first, last: eb.last ?? ea.last });
    };
    if (fitAfter(0) > fitAfter(gap)) x = 0;
  }
  const sa = slide(a, x);
  const sb = slide(b, x - gap);
  return { from: sa.from, to: sb.to, insert: sa.insert + sb.insert };
}

/**
 * The pure change `c` slid to its best place within its reach (`left` places left, `right`
 * right): one that needs no widening to whole words if there is one, then the highest boundary
 * score, then the rightmost.
 */
function restingPlace(text: string, c: TextChange, left: number, right: number): TextChange {
  let best = -left;
  let bestFit = -1;
  for (let k = -left; k <= right; k++) {
    const f = fit(text, slidEdges(c, k));
    if (f >= bestFit) {
      bestFit = f;
      best = k;
    }
  }
  return slide(c, best);
}

/** Added to a place that needs no widening; above any boundary score, so whole words come first. */
const WHOLE_WORDS = 100;

/**
 * How good a place this is for a change: WHOLE_WORDS unless widenToWords would widen it, plus
 * the boundary score of its edges (where the inserted text meets the text around it, and
 * where the replaced range starts and ends).
 */
function fit(text: string, e: Edges): number {
  let score = 0;
  if (e.first !== undefined) score += edgeScore(text[e.from - 1], e.first) + edgeScore(e.last, text[e.to]);
  if (e.from < e.to) score += edgeScore(text[e.from - 1], text[e.from]) + edgeScore(text[e.to - 1], text[e.to]);
  return (cutsWord(text, e) ? 0 : WHOLE_WORDS) + score;
}

/** True when widenToWords would widen a change with these edges (see there). */
function cutsWord(text: string, e: Edges): boolean {
  const before = text[e.from - 1];
  const after = text[e.to];
  const takes = e.from < e.to;
  const startsInWord = isLetterOrDigit(text[e.from]) || isLetterOrDigit(e.first);
  const endsInWord = isLetterOrDigit(text[e.to - 1]) || isLetterOrDigit(e.last);
  return (
    (isLetterOrDigit(before) && (startsInWord || (takes && isCloser(text[e.from])))) ||
    (isOpener(before) && startsInWord) ||
    (isLetterOrDigit(after) && (endsInWord || (takes && isOpener(text[e.to - 1])))) ||
    (isCloser(after) && endsInWord)
  );
}

/**
 * How good the edge between two characters is to start or end a change: diff-match-patch's scale
 * (line break, punctuation before a space, a space, any punctuation), plus one just outside a
 * bracket, so a change covers a whole `[link](url)` or `**x**`. The text's ends score highest.
 */
function edgeScore(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return 7;
  const wordA = isLetterOrDigit(a);
  const wordB = isLetterOrDigit(b);
  const spaceA = !wordA && isSpaceChar(a);
  const spaceB = !wordB && isSpaceChar(b);
  const bracket = (OPENERS.includes(b) ? 1 : 0) + (CLOSERS.includes(a) ? 1 : 0);
  if (a === '\n' || b === '\n') return 4 + bracket;
  if (!wordA && !spaceA && spaceB) return 3 + bracket;
  if (spaceA || spaceB) return 2 + bracket;
  if (!wordA || !wordB) return 1 + bracket;
  return 0;
}

const OPENERS = '([{<⟦«"';
const CLOSERS = ')]}>⟧»"';

function isOpener(ch: string | undefined): boolean {
  return ch !== undefined && OPENERS.includes(ch);
}

function isCloser(ch: string | undefined): boolean {
  return ch !== undefined && CLOSERS.includes(ch);
}

/** True when offset `i` falls between the halves of a surrogate pair. */
function splitsPair(text: string, i: number): boolean {
  return i > 0 && i < text.length && isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i));
}
