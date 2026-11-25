// What a screen reader is told of a change from outside: which of the words table's sentences
// each case takes, and what fills them in; the sentences themselves are ANNOUNCE_WORDS'.

import { describe, expect, it } from 'vitest';
import { fill } from '../../../src/core/fill';
import { listed } from '../../../src/core/listText';
import {
  ANNOUNCE_WORDS as W,
  outsideSentence,
  yourLineSentence,
  type Place,
  type PlaceHeading,
  type Told,
} from '../../../src/panel/announce/words';

const FILE = 'Field notes.md';
const heading = (name: string, more: Partial<PlaceHeading> = {}): PlaceHeading => ({
  name,
  isNew: false,
  nextTo: null,
  ...more,
});
const under = (...names: string[]): Place => ({
  aboveFirst: false,
  headings: names.map((name) => heading(name)),
  thirds: [],
  quote: null,
});
const QUESTIONS = under('Questions');
const LAST: Place = { aboveFirst: false, headings: [], thirds: ['last'], quote: null };
const told = (t: Partial<Told>): Told => ({
  fileName: FILE,
  shape: 'changed',
  count: 2,
  unit: 'line',
  block: null,
  frontMatter: false,
  place: QUESTIONS,
  problems: false,
  ...t,
});
const did = (verb: string, amount: string) => fill(W.did, { verb, amount });
const TWO_CHANGED = did(W.verb.changed, fill(W.lines, { count: 2 }));
const UNDER_QUESTIONS = fill(W.underHeading, { heading: 'Questions' });
const LAST_THIRD = fill(W.inThird, { third: W.third.last });
const AFTER_ROUTE = fill(W.nextTo.after, { heading: 'Route' });
/** The sentence for two lines changed `where`. */
const twoChangedUnder = (where: string) => fill(W.under, { did: TWO_CHANGED, where, file: FILE });

describe('the sentence for a change', () => {
  it('says what was done, how much, under which heading, then the note', () => {
    expect(outsideSentence(told({}))).toBe(twoChangedUnder(UNDER_QUESTIONS));
    expect(outsideSentence(told({ shape: 'tookOut', count: 1 }))).toBe(
      fill(W.under, { did: did(W.verb.tookOut, fill(W.line, { count: 1 })), where: UNDER_QUESTIONS, file: FILE }),
    );
  });

  it('places a change in a third of a note with no headings, with the first words of a line it is at', () => {
    expect(outsideSentence(told({ place: LAST }))).toBe(
      fill(W.inThirdsOf, { did: TWO_CHANGED, thirds: LAST_THIRD, file: FILE }),
    );
    const at = (quote: Place['quote'], count = 2) => outsideSentence(told({ count, place: { ...LAST, quote } }));
    const withQuote = (quote: string, count = 2) =>
      fill(W.quotedInThirdsOf, {
        did: count === 2 ? TWO_CHANGED : did(W.verb.changed, fill(W.line, { count })),
        quote,
        thirds: LAST_THIRD,
        file: FILE,
      });
    expect(at({ words: 'walk to the river', at: 'on' })).toBe(
      withQuote(fill(W.quote.onFirst, { words: 'walk to the river' })),
    );
    expect(at({ words: 'walk', at: 'on' }, 1)).toBe(withQuote(fill(W.quote.onOne, { words: 'walk' }), 1));
    expect(at({ words: 'walk', at: 'above' })).toBe(withQuote(fill(W.quote.above, { words: 'walk' })));
    expect(at({ words: 'walk', at: 'below' })).toBe(withQuote(fill(W.quote.below, { words: 'walk' })));
    const both: Place = { ...LAST, thirds: ['first', 'middle'] };
    expect(outsideSentence(told({ place: both }))).toBe(
      fill(W.inThirdsOf, {
        did: TWO_CHANGED,
        thirds: fill(W.inThirds, { thirds: listed([W.third.first, W.third.middle]) }),
        file: FILE,
      }),
    );
  });

  it('names an empty or a new heading with the heading next to it', () => {
    const one = (h: PlaceHeading) => outsideSentence(told({ place: { ...QUESTIONS, headings: [h] } }));
    expect(one(heading('Sightings', { isNew: true, nextTo: { side: 'after', name: 'Route' } }))).toBe(
      twoChangedUnder(fill(W.underNewHeadingNextTo, { heading: 'Sightings', nextTo: AFTER_ROUTE })),
    );
    expect(one(heading('Sightings', { isNew: true }))).toBe(
      twoChangedUnder(fill(W.underNewHeading, { heading: 'Sightings' })),
    );
    expect(one(heading('', { nextTo: { side: 'before', name: 'Route' } }))).toBe(
      twoChangedUnder(fill(W.underEmptyHeadingNextTo, { nextTo: fill(W.nextTo.before, { heading: 'Route' }) })),
    );
    expect(one(heading(''))).toBe(twoChangedUnder(W.underEmptyHeading));
    expect(one(heading('', { isNew: true, nextTo: { side: 'after', name: 'Route' } }))).toBe(
      twoChangedUnder(fill(W.underNewEmptyHeadingNextTo, { nextTo: AFTER_ROUTE })),
    );
  });

  it('names up to three headings, and four or more by the first and the last', () => {
    const where = (place: Place) => outsideSentence(told({ place }));
    const emptyAfterRoute = heading('', { nextTo: { side: 'after', name: 'Route' } });
    expect(where({ ...QUESTIONS, headings: [heading('Route'), emptyAfterRoute, heading('C')] })).toBe(
      twoChangedUnder(
        fill(W.underHeadings, {
          headings: listed(['Route', fill(W.emptyHeadingNextTo, { nextTo: AFTER_ROUTE }), 'C']),
        }),
      ),
    );
    expect(where(under('A', 'B', 'C', 'D'))).toBe(
      twoChangedUnder(fill(W.underManyHeadings, { count: 4, first: 'A', last: 'D' })),
    );
  });

  it('says what is above the first heading, alone or with the headings below it', () => {
    expect(outsideSentence(told({ place: { ...under(), aboveFirst: true } }))).toBe(twoChangedUnder(W.aboveFirst));
    expect(outsideSentence(told({ place: { ...QUESTIONS, aboveFirst: true } }))).toBe(
      twoChangedUnder(fill(W.aboveFirstAnd, { under: UNDER_QUESTIONS })),
    );
  });

  it('names a block drawn as a picture, all of the change in it or part, and a table by its rows', () => {
    const rows = did(W.verb.added, fill(W.rows, { count: 2 }));
    expect(outsideSentence(told({ shape: 'added', unit: 'row', block: { name: W.table, lines: 2 } }))).toBe(
      fill(W.blockUnder, { did: rows, into: W.into.added, block: W.table, where: UNDER_QUESTIONS, file: FILE }),
    );
    expect(outsideSentence(told({ block: { name: 'a diagram', lines: 2 }, place: LAST }))).toBe(
      fill(W.blockInThirds, {
        did: TWO_CHANGED,
        into: W.into.other,
        block: 'a diagram',
        thirds: LAST_THIRD,
        file: FILE,
      }),
    );
    const quote = { words: 'A --> B', at: 'on' } as const;
    expect(outsideSentence(told({ block: { name: 'a diagram', lines: 2 }, place: { ...LAST, quote } }))).toBe(
      fill(W.blockQuotedInThirds, {
        did: TWO_CHANGED,
        into: W.into.other,
        block: 'a diagram',
        quote: fill(W.quote.onFirst, { words: 'A --> B' }),
        thirds: LAST_THIRD,
        file: FILE,
      }),
    );
    const some = fill(W.someInBlock, { lines: 1, block: 'a diagram' });
    expect(outsideSentence(told({ block: { name: 'a diagram', lines: 1 } }))).toBe(
      fill(W.partlyUnder, { did: TWO_CHANGED, where: UNDER_QUESTIONS, some, file: FILE }),
    );
    expect(outsideSentence(told({ block: { name: 'a diagram', lines: 1 }, place: LAST }))).toBe(
      fill(W.partlyInThirds, { did: TWO_CHANGED, some, thirds: LAST_THIRD, file: FILE }),
    );
    expect(outsideSentence(told({ block: { name: 'a diagram', lines: 1 }, place: { ...LAST, quote } }))).toBe(
      fill(W.partlyQuotedInThirds, {
        did: TWO_CHANGED,
        quote: fill(W.quote.onFirst, { words: 'A --> B' }),
        some,
        thirds: LAST_THIRD,
        file: FILE,
      }),
    );
  });

  it('says a change is in the front matter, and adds the Problems list about those lines or rows', () => {
    expect(outsideSentence(told({ frontMatter: true }))).toBe(
      fill(W.frontMatter, { did: TWO_CHANGED, into: W.into.other, file: FILE }),
    );
    expect(outsideSentence(told({ problems: true }))).toBe(`${twoChangedUnder(UNDER_QUESTIONS)} ${W.warning.lines}`);
    const oneLine = fill(W.under, {
      did: did(W.verb.changed, fill(W.line, { count: 1 })),
      where: UNDER_QUESTIONS,
      file: FILE,
    });
    expect(outsideSentence(told({ count: 1, problems: true }))).toBe(`${oneLine} ${W.warning.line}`);
    expect(outsideSentence(told({ unit: 'row', problems: true })).endsWith(` ${W.warning.rows}`)).toBe(true);
  });
});

describe('the sentence for the line the cursor is on', () => {
  const ROUTE = under('Route');

  it('says the line changed, and where the other lines are: there with it, or elsewhere', () => {
    expect(yourLineSentence({ more: 0, place: null, yours: QUESTIONS, kept: null })).toBe(W.yourLine);
    expect(yourLineSentence({ more: 1, place: QUESTIONS, yours: QUESTIONS, kept: null })).toBe(
      fill(W.yourLineAndMoreThere, { more: fill(W.moreLine, { count: 1 }), where: UNDER_QUESTIONS }),
    );
    expect(yourLineSentence({ more: 3, place: ROUTE, yours: QUESTIONS, kept: null })).toBe(
      fill(W.yourLineAndMoreElsewhere, {
        yours: UNDER_QUESTIONS,
        more: fill(W.moreLines, { count: 3 }),
        where: fill(W.underHeading, { heading: 'Route' }),
      }),
    );
  });

  it('gives the first words of the other lines in a note with no headings', () => {
    const quoted: Place = { ...LAST, quote: { words: 'walk', at: 'on' } };
    const first: Place = { ...LAST, thirds: ['first'] };
    const quote = fill(W.quote.onFirst, { words: 'walk' });
    expect(yourLineSentence({ more: 2, place: quoted, yours: LAST, kept: null })).toBe(
      fill(W.yourLineAndMoreQuotedThere, { more: fill(W.moreLines, { count: 2 }), quote, where: LAST_THIRD }),
    );
    expect(yourLineSentence({ more: 2, place: quoted, yours: first, kept: null })).toBe(
      fill(W.yourLineAndMoreQuotedElsewhere, {
        yours: fill(W.inThird, { third: W.third.first }),
        more: fill(W.moreLines, { count: 2 }),
        quote,
        where: LAST_THIRD,
      }),
    );
  });

  it('then says what stayed as the person left it: their typing, none to keep, or what the tab cannot see', () => {
    for (const kept of ['cursorAndTyping', 'cursorNoTyping', 'cursorTypingUnknown'] as const)
      expect(yourLineSentence({ more: 0, place: null, yours: QUESTIONS, kept })).toBe(`${W.yourLine} ${W.kept[kept]}`);
  });
});
