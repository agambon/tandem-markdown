// The sentences a screen reader is told when another program's change lands in the note: what it
// did, how much, where, then which note. A place is a heading in its own words, an empty or a new
// one with the heading next to it, "above the first heading", or a third of a note with no
// headings with the first words of a line the change is at, which Find can reach. A change inside
// a block drawn as a picture names the block. The note's name comes last, so a key that cuts the
// sentence short loses only the name. The sentence for the line the person's cursor is on leaves
// the name out, and says where that line is when the change's other lines are elsewhere.

import { fill } from '../../core/fill';
import { listed } from '../../core/listText';

/** All of the change added whole lines (`added`), took out whole lines (`tookOut`), or anything else. */
export type Shape = 'added' | 'tookOut' | 'changed';

export type Third = 'first' | 'middle' | 'last';

/** The nearest heading with words, before a heading (`after` it) or else after it (`before` it). */
export interface NextTo {
  side: 'after' | 'before';
  name: string;
}

/** A heading over a change: its words, whether the change added it, and for an empty or a new one, the heading next to it. */
export interface PlaceHeading {
  name: string;
  isNew: boolean;
  nextTo: NextTo | null;
}

/**
 * In a note with no headings, the first words of a line the change is at, as the note holds them:
 * the first line it changed or added (`on`), or where it only took lines out, the line just after
 * them (`above`) or, at the note's end, just before them (`below`).
 */
export interface Quote {
  words: string;
  at: 'on' | 'above' | 'below';
}

export interface Place {
  aboveFirst: boolean;
  /** The headings over it, in the note's order, each once. */
  headings: readonly PlaceHeading[];
  /** In a note with no headings, the thirds of the note it is in, in order. */
  thirds: readonly Third[];
  /** In a note with no headings, where to find it; null where no line there has words. */
  quote: Quote | null;
}

export interface Told {
  fileName: string;
  shape: Shape;
  /** Lines, or a table's rows (`unit`), that the change added, reworded or took out, each once. */
  count: number;
  unit: 'line' | 'row';
  /**
   * The block drawn as a picture that it touched, by the name a sentence gives it ("a diagram"):
   * all of it there (`lines` equals `count`), or `lines` of it there and the rest outside any
   * block. Null when it touched none, or blocks of more than one kind or more than one block.
   */
  block: { name: string; lines: number } | null;
  frontMatter: boolean;
  place: Place;
  /** The change gave a warning in the Problems list, and no message speaks for it. */
  problems: boolean;
}

/**
 * What stayed as the person left it, for the second sentence: the cursor and their unsaved typing
 * (`cursorAndTyping`); the cursor, where nothing was unsaved (`cursorNoTyping`); the cursor, where
 * the note held unsaved changes from before the tab opened that it cannot see (`cursorTypingUnknown`).
 */
export type Kept = 'cursorAndTyping' | 'cursorNoTyping' | 'cursorTypingUnknown';

export interface ToldOnYourLine {
  /** Lines the change added, reworded or took out besides that line. */
  more: number;
  place: Place | null;
  yours: Place;
  kept: Kept | null;
}

/**
 * Every sentence a screen reader is told, and every part of one, «name» marking what is filled
 * in; the functions below choose among them and fill them in. A sentence names a block drawn as a
 * picture by its kind's `sentenceName` (render/drawnBlock.ts), and a table by `table`.
 */
export const ANNOUNCE_WORDS = {
  // How much, and what a change did.
  line: '«count» line',
  lines: '«count» lines',
  row: '«count» row',
  rows: '«count» rows',
  verb: { added: 'added', tookOut: 'took out', changed: 'changed' },
  /** What a change put in goes `to` a block; what it changed or took out is `of` it. */
  into: { added: 'to', other: 'of' },
  table: 'a table',

  // Where: headings.
  underHeading: 'under the heading «heading»',
  underNewHeading: 'under a new heading, «heading»',
  underNewHeadingNextTo: 'under a new heading, «heading», «nextTo»',
  underEmptyHeading: 'under an empty heading',
  underEmptyHeadingNextTo: 'under the empty heading «nextTo»',
  underNewEmptyHeading: 'under a new empty heading',
  underNewEmptyHeadingNextTo: 'under a new empty heading «nextTo»',
  underHeadings: 'under the headings «headings»',
  /** Four headings or more, by their number, the first and the last. */
  underManyHeadings: 'under «count» headings, from «first» to «last»',
  /** An empty heading among others in a list. */
  emptyHeading: 'an empty heading',
  emptyHeadingNextTo: 'the empty heading «nextTo»',
  nextTo: { after: 'after the heading «heading»', before: 'before the heading «heading»' },
  aboveFirst: 'above the first heading',
  aboveFirstAnd: 'above the first heading and «under»',

  // Where: a note with no headings.
  third: { first: 'first', middle: 'middle', last: 'last' },
  inThird: 'in the «third» third of your note',
  inThirds: 'in the «thirds» thirds of your note',
  /** The first words of a line the change is at, by where the line is and how many lines it changed. */
  quote: {
    onOne: 'beginning "«words»"',
    onFirst: 'the first beginning "«words»"',
    above: 'just above the line beginning "«words»"',
    below: 'just below the line beginning "«words»"',
  },

  // The sentence for a change, by where it is.
  did: 'Another program «verb» «amount»',
  frontMatter: '«did» «into» the front matter, at the top of your note «file».',
  blockInThirds: '«did» «into» «block» «thirds» «file».',
  blockQuotedInThirds: '«did» «into» «block», «quote», «thirds» «file».',
  blockUnder: '«did» «into» «block» «where», in your note «file».',
  someInBlock: '«lines» of them in «block»',
  partlyInThirds: '«did», «some», «thirds» «file».',
  partlyQuotedInThirds: '«did», «quote», «some», «thirds» «file».',
  partlyUnder: '«did» «where», «some», in your note «file».',
  inThirdsOf: '«did» «thirds» «file».',
  quotedInThirdsOf: '«did», «quote», «thirds» «file».',
  under: '«did» «where», in your note «file».',
  /** After the sentence, for a change that gave a warning in the Problems list, by its count and unit. */
  warning: {
    line: 'The Problems list has a warning about that line.',
    lines: 'The Problems list has a warning about those lines.',
    row: 'The Problems list has a warning about that row.',
    rows: 'The Problems list has a warning about those rows.',
  },

  // The sentence for the line the cursor is on, then what stayed as the person left it.
  yourLine: 'Another program changed the line you are on.',
  /** The other lines are where the line the cursor is on is. */
  yourLineAndMoreThere: 'Another program changed the line you are on and «more», all «where».',
  yourLineAndMoreQuotedThere: 'Another program changed the line you are on and «more», «quote», all «where».',
  /** The other lines are elsewhere, or not all where the line the cursor is on is. */
  yourLineAndMoreElsewhere: 'Another program changed the line you are on, «yours», and «more» «where».',
  yourLineAndMoreQuotedElsewhere: 'Another program changed the line you are on, «yours», and «more», «quote», «where».',
  moreLine: '«count» more line',
  moreLines: '«count» more lines',
  kept: {
    cursorAndTyping: 'Your cursor and your unsaved typing are as you left them.',
    cursorNoTyping: 'Your cursor is where you left it, and you had no unsaved typing.',
    cursorTypingUnknown:
      "Your cursor is where you left it. This tab can't tell whether the change reached unsaved typing you did before it opened.",
  },
} as const;
const W = ANNOUNCE_WORDS;

function amount(count: number, unit: Told['unit']): string {
  const [one, many] = unit === 'line' ? [W.line, W.lines] : [W.row, W.rows];
  return fill(count === 1 ? one : many, { count });
}

function nextTo(n: NextTo): string {
  return fill(W.nextTo[n.side], { heading: n.name });
}

function listedHeading(h: PlaceHeading): string {
  if (h.name !== '') return h.name;
  return h.nextTo ? fill(W.emptyHeadingNextTo, { nextTo: nextTo(h.nextTo) }) : W.emptyHeading;
}

function underHeading(h: PlaceHeading): string {
  const next = h.nextTo ? nextTo(h.nextTo) : null;
  if (h.name === '') {
    if (h.isNew) return next ? fill(W.underNewEmptyHeadingNextTo, { nextTo: next }) : W.underNewEmptyHeading;
    return next ? fill(W.underEmptyHeadingNextTo, { nextTo: next }) : W.underEmptyHeading;
  }
  if (!h.isNew) return fill(W.underHeading, { heading: h.name });
  return next
    ? fill(W.underNewHeadingNextTo, { heading: h.name, nextTo: next })
    : fill(W.underNewHeading, { heading: h.name });
}

/** Up to three headings by name; four or more by their number, the first and the last. */
function underHeadings(headings: Place['headings']): string {
  if (headings.length === 1) return underHeading(headings[0]!);
  if (headings.length <= 3) return fill(W.underHeadings, { headings: listed(headings.map(listedHeading)) });
  return fill(W.underManyHeadings, {
    count: headings.length,
    first: listedHeading(headings[0]!),
    last: listedHeading(headings[headings.length - 1]!),
  });
}

function underPlace(place: Place): string {
  const under = place.headings.length > 0 ? underHeadings(place.headings) : '';
  if (!place.aboveFirst) return under;
  return under === '' ? W.aboveFirst : fill(W.aboveFirstAnd, { under });
}

function inThirds(thirds: readonly Third[]): string {
  return thirds.length === 1
    ? fill(W.inThird, { third: W.third[thirds[0]!] })
    : fill(W.inThirds, { thirds: listed(thirds.map((t) => W.third[t])) });
}

function wherePlace(place: Place): string {
  const where = underPlace(place);
  return where === '' && place.thirds.length > 0 ? inThirds(place.thirds) : where;
}

function quoted(place: Place, count: number): string | null {
  const q = place.quote;
  if (!q) return null;
  const form = q.at === 'on' ? (count === 1 ? W.quote.onOne : W.quote.onFirst) : W.quote[q.at];
  return fill(form, { words: q.words });
}

/** The sentence for a change, with the Problems list's sentence after it where it gave a warning. */
export function outsideSentence(t: Told): string {
  const did = fill(W.did, { verb: W.verb[t.shape], amount: amount(t.count, t.unit) });
  const into = t.shape === 'added' ? W.into.added : W.into.other;
  const where = underPlace(t.place);
  const thirds = where === '' ? inThirds(t.place.thirds) : '';
  const file = t.fileName;
  let sentence: string;
  if (t.frontMatter) {
    sentence = fill(W.frontMatter, { did, into, file });
  } else if (t.block && t.block.lines === t.count) {
    const block = t.block.name;
    const quote = quoted(t.place, t.count);
    sentence =
      where !== ''
        ? fill(W.blockUnder, { did, into, block, where, file })
        : quote
          ? fill(W.blockQuotedInThirds, { did, into, block, quote, thirds, file })
          : fill(W.blockInThirds, { did, into, block, thirds, file });
  } else if (t.block) {
    const some = fill(W.someInBlock, { lines: t.block.lines, block: t.block.name });
    const quote = quoted(t.place, t.count);
    sentence =
      where !== ''
        ? fill(W.partlyUnder, { did, where, some, file })
        : quote
          ? fill(W.partlyQuotedInThirds, { did, quote, some, thirds, file })
          : fill(W.partlyInThirds, { did, some, thirds, file });
  } else {
    const quote = quoted(t.place, t.count);
    sentence =
      where !== ''
        ? fill(W.under, { did, where, file })
        : quote
          ? fill(W.quotedInThirdsOf, { did, quote, thirds, file })
          : fill(W.inThirdsOf, { did, thirds, file });
  }
  if (!t.problems) return sentence;
  const warning = t.unit === 'line' ? W.warning.line : W.warning.row;
  const warnings = t.unit === 'line' ? W.warning.lines : W.warning.rows;
  return `${sentence} ${t.count === 1 ? warning : warnings}`;
}

function samePlace(a: Place, b: Place): boolean {
  return (
    a.aboveFirst === b.aboveFirst &&
    a.thirds.join() === b.thirds.join() &&
    a.headings.length === b.headings.length &&
    a.headings.every((h, i) => h.name === b.headings[i]!.name && h.isNew === b.headings[i]!.isNew)
  );
}

/** The sentence for a change to the line the cursor is on, then what stayed as the person left it. */
export function yourLineSentence(t: ToldOnYourLine): string {
  let sentence: string = W.yourLine;
  if (t.more > 0 && t.place) {
    const more = fill(t.more === 1 ? W.moreLine : W.moreLines, { count: t.more });
    const where = wherePlace(t.place);
    const quote = quoted(t.place, t.more);
    if (samePlace(t.place, t.yours)) {
      sentence = quote
        ? fill(W.yourLineAndMoreQuotedThere, { more, quote, where })
        : fill(W.yourLineAndMoreThere, { more, where });
    } else {
      const yours = wherePlace(t.yours);
      sentence = quote
        ? fill(W.yourLineAndMoreQuotedElsewhere, { yours, more, quote, where })
        : fill(W.yourLineAndMoreElsewhere, { yours, more, where });
    }
  }
  return t.kept ? `${sentence} ${W.kept[t.kept]}` : sentence;
}
