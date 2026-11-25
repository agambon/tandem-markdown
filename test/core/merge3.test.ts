// merge3 decides what lands in a user's file when another program changed it while they were
// typing. A wrong merge loses someone's words.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toLf } from '../../src/core/eol';
import { type BothInserted, type MergeResult, type Prefer, merge3, merge3Detailed } from '../../src/core/merge3';
import { replaying, seeded } from '../random';

/** The merged text with every conflict switched to the side that was not chosen. */
function switchConflicts(r: MergeResult, chosen: Prefer): string {
  let out = '';
  let pos = 0;
  for (const c of r.conflicts) {
    out += r.text.slice(pos, c.from) + (chosen === 'ours' ? c.theirs : c.ours);
    pos = c.to;
  }
  return out + r.text.slice(pos);
}

/** Everything any merge result must satisfy, whatever the inputs, in either mode (MergeOptions.exactBase). */
function expectConsistent(
  base: string,
  ours: string,
  theirs: string,
  prefer: Prefer,
  exactBase: boolean,
  r: MergeResult,
): void {
  // Ascending and not overlapping (two may meet in the text when a clean deletion lay
  // between them in the base).
  let prevTo = 0;
  for (const c of r.conflicts) {
    expect(c.from).toBeGreaterThanOrEqual(prevTo);
    expect(c.to).toBeGreaterThanOrEqual(c.from);
    expect(c.to).toBeLessThanOrEqual(r.text.length);
    expect(r.text.slice(c.from, c.to)).toBe(prefer === 'ours' ? c.ours : c.theirs);
    expect(c.ours).not.toBe(c.theirs);
    prevTo = c.to;
  }
  // Switching every conflict gives exactly the merge that prefers the other side.
  const other: Prefer = prefer === 'ours' ? 'theirs' : 'ours';
  expect(switchConflicts(r, prefer)).toBe(merge3(base, ours, theirs, { prefer: other, exactBase }).text);
  // The merge does not depend on which side is called ours, except for which side's lines come
  // first where both inserted lines at one place: the swapped merge is clean exactly when this
  // one is, gives the same text outside those stretches, and the same lines inside them. Only
  // with an exact base are any lines kept together.
  const detailed = merge3Detailed(base, ours, theirs, { prefer, exactBase });
  expect(detailed.text).toBe(r.text);
  expect(detailed.conflicts).toEqual(r.conflicts);
  if (!exactBase) expect(detailed.bothInserted).toEqual([]);
  const swapped = merge3Detailed(base, theirs, ours, { prefer: other, exactBase });
  expect(swapped.conflicts.length === 0).toBe(r.conflicts.length === 0);
  const pieces = (text: string, stretches: BothInserted[]) => {
    const outside: string[] = [];
    const inside: string[] = [];
    let pos = 0;
    for (const s of stretches) {
      expect(s.from).toBeGreaterThanOrEqual(pos);
      outside.push(text.slice(pos, s.from));
      inside.push(text.slice(s.from, s.to));
      pos = s.to;
    }
    outside.push(text.slice(pos));
    return { outside, inside };
  };
  const mine = pieces(r.text, detailed.bothInserted);
  const theirsFirst = pieces(swapped.text, swapped.bothInserted);
  expect(theirsFirst.outside).toEqual(mine.outside);
  const textLines = (s: string) =>
    s
      .split('\n')
      .filter((l) => l !== '')
      .sort();
  expect(theirsFirst.inside.map(textLines)).toEqual(mine.inside.map(textLines));
  detailed.bothInserted.forEach((s, k) => {
    expect(swapped.bothInserted[k]).toMatchObject({ ours: s.theirs, theirs: s.ours });
  });
  if (!(base + ours + theirs).includes('<<<<<<<')) expect(r.text).not.toContain('<<<<<<<');
  if (!(base + ours + theirs).includes('>>>>>>>')) expect(r.text).not.toContain('>>>>>>>');
  expect(missingOnce(base, ours, theirs, r.text)).toEqual([]);
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
/** A word as the merge reads text: a run of word characters, one CJK character, or one other character that is not a space. */
const WORD = new RegExp(`[${CJK}]|(?:(?![${CJK}])[\\p{L}\\p{N}\\p{M}\\p{Pc}])+|\\S`, 'gu');

/**
 * The words and non-blank lines that the base, ours and theirs each hold exactly once, and that
 * `merged` lacks. Each is one text all three kept, and a merge keeps it, whichever side it
 * prefers. It may be joined to the text beside it (a line break deleted between two lines joins
 * them), so it is looked for as text.
 */
function missingOnce(base: string, ours: string, theirs: string, merged: string): string[] {
  const counts = (items: string[]) => {
    const c = new Map<string, number>();
    for (const x of items) c.set(x, (c.get(x) ?? 0) + 1);
    return c;
  };
  const missing: string[] = [];
  for (const split of [(s: string) => s.match(WORD) ?? [], (s: string) => s.split('\n').filter((l) => l !== '')]) {
    const [b, o, t] = [base, ours, theirs].map((s) => counts(split(s)));
    for (const [x, n] of b!) if (n === 1 && o!.get(x) === 1 && t!.get(x) === 1 && !merged.includes(x)) missing.push(x);
  }
  return missing;
}

function merged(base: string, ours: string, theirs: string, prefer: Prefer = 'ours', exactBase = false): MergeResult {
  const r = merge3(base, ours, theirs, { prefer, exactBase });
  expectConsistent(base, ours, theirs, prefer, exactBase, r);
  return r;
}

const clean = (text: string): MergeResult => ({ text, conflicts: [] });

/** Where there may be doubt: either the merge both sides meant, cleanly, or a conflict; never a clean wrong text. */
function notWrong(r: MergeResult, meant: string): void {
  if (r.conflicts.length === 0) expect(r.text).toBe(meant);
}

const joinLines = (lines: string[], finalNewline: boolean) =>
  lines.join('\n') + (finalNewline && lines.length > 0 ? '\n' : '');

/**
 * What is wrong with `kept` as the lines both sides inserted at one place, `ours` and
 * `theirs`, kept together (all three as lines without their line breaks). Empty when:
 * - each line of text is there as often as the side with more copies of it has it;
 * - ours's lines, blank lines included, are there in their order, and so are theirs's, unless
 *   no order of those lines keeps both sides' orders; then theirs's lines that ours does not
 *   have are there in their order;
 * - ours's lines come first: no line only theirs has stands right before one only ours has;
 * - a line has as many blank lines right before it as some copy of it has on one side, and the
 *   blank lines at the end are as many as the side with more has.
 */
function bothKeptFaults(ours: string[], theirs: string[], kept: string[]): string[] {
  const faults: string[] = [];
  const textOf = (lines: string[]) => lines.filter((l) => l !== '');
  const copies = (lines: string[]) => {
    const c = new Map<string, number>();
    for (const l of textOf(lines)) c.set(l, (c.get(l) ?? 0) + 1);
    return c;
  };
  const inOrder = (small: string[], big: string[]) => {
    let k = 0;
    for (const x of big) if (k < small.length && small[k] === x) k++;
    return k === small.length;
  };
  const o = copies(ours);
  const t = copies(theirs);
  const k = copies(kept);
  const most = new Map<string, number>();
  for (const l of [...o.keys(), ...t.keys()]) most.set(l, Math.max(o.get(l) ?? 0, t.get(l) ?? 0));
  for (const l of new Set([...most.keys(), ...k.keys()]))
    if ((k.get(l) ?? 0) !== (most.get(l) ?? 0)) faults.push(`"${l}" is there ${k.get(l) ?? 0} times`);
  if (!inOrder(ours, kept)) faults.push("ours's lines are out of order");
  if (!inOrder(theirs, kept)) {
    const orders = (rest: string[], prefix: string[]): boolean =>
      rest.length === 0
        ? inOrder(textOf(ours), prefix) && inOrder(textOf(theirs), prefix)
        : rest.some(
            (l, i) => rest.indexOf(l) === i && orders([...rest.slice(0, i), ...rest.slice(i + 1)], [...prefix, l]),
          );
    const all = [...most].flatMap(([l, n]) => Array.from({ length: n }, () => l));
    if (orders(all, [])) faults.push("theirs's lines are out of order");
    else if (
      !inOrder(
        textOf(theirs).filter((l) => !o.has(l)),
        textOf(kept),
      )
    )
      faults.push("theirs's own lines are out of order");
  }
  const text = textOf(kept);
  for (let i = 0; i + 1 < text.length; i++)
    if (!o.has(text[i]!) && o.has(text[i + 1]!) && !t.has(text[i + 1]!))
      faults.push(`"${text[i]}" of theirs stands before "${text[i + 1]}" of ours`);
  const blanksBefore = (lines: string[]) => {
    const seen = new Map<string, Set<number>>();
    let blanks = 0;
    for (const l of lines) {
      if (l !== '') {
        if (!seen.has(l)) seen.set(l, new Set());
        seen.get(l)!.add(blanks);
      }
      blanks = l === '' ? blanks + 1 : 0;
    }
    return { seen, end: blanks };
  };
  const bo = blanksBefore(ours);
  const bt = blanksBefore(theirs);
  const bk = blanksBefore(kept);
  for (const [l, counts] of bk.seen)
    for (const n of counts)
      if (!bo.seen.get(l)?.has(n) && !bt.seen.get(l)?.has(n)) faults.push(`"${l}" has ${n} blank lines before it`);
  if (bk.end !== Math.max(bo.end, bt.end)) faults.push(`${bk.end} blank lines at the end`);
  return faults;
}

/** A gap where both sides inserted different lines (see bothKeptFaults). */
type Kept = { ours: string[]; theirs: string[] };
/** A line of the merge meant, or a gap where both sides inserted lines. */
type Part = string | Kept;

/** Whether `text` is `parts` as lines, each gap filled with lines that bothKeptFaults finds nothing wrong with. */
function fits(text: string, parts: Part[], finalNewline: boolean): boolean {
  if (finalNewline && text !== '' && !text.endsWith('\n')) return false;
  const lines = text === '' ? [] : (finalNewline ? text.slice(0, -1) : text).split('\n');
  const from = (k: number, pos: number): boolean => {
    if (k === parts.length) return pos === lines.length;
    const part = parts[k]!;
    if (typeof part === 'string') return lines[pos] === part && from(k + 1, pos + 1);
    for (let n = 0; n <= part.ours.length + part.theirs.length && pos + n <= lines.length; n++)
      if (bothKeptFaults(part.ours, part.theirs, lines.slice(pos, pos + n)).length === 0 && from(k + 1, pos + n))
        return true;
    return false;
  };
  return from(0, 0);
}

describe('merge3 identities', () => {
  it('gives theirs when ours is the base, ours when theirs is, and the text when both agree', () => {
    expect(merged('a\nb\n', 'a\nb\n', 'a\nB\n')).toEqual(clean('a\nB\n'));
    expect(merged('a\nb\n', 'a\nB\n', 'a\nb\n')).toEqual(clean('a\nB\n'));
    expect(merged('a\nb\n', 'x\ny\n', 'x\ny\n')).toEqual(clean('x\ny\n'));
  });

  it('holds the identities for random texts', () => {
    const unit = fc.constantFrom('a', 'b', ' ', '.', '\n', 'é', '😀');
    const text = fc.string({ unit, maxLength: 40 });
    fc.assert(
      fc.property(text, text, (b, x) => {
        expect(merge3(b, b, x)).toEqual(clean(x));
        expect(merge3(b, x, b)).toEqual(clean(x));
        expect(merge3(b, x, x)).toEqual(clean(x));
      }),
      seeded({ numRuns: 500 }),
    );
  });
});

describe('merge3 by hand', () => {
  it('merges changes to different lines, adjacent ones included', () => {
    expect(merged('one\ntwo\nthree\nfour\n', 'ONE\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nFOUR\n')).toEqual(
      clean('ONE\nTWO\nthree\nFOUR\n'),
    );
  });

  it('merges changes to different words of one line', () => {
    expect(merged('the quick brown fox\n', 'the slow brown fox\n', 'the quick brown cat\n')).toEqual(
      clean('the slow brown cat\n'),
    );
    expect(merged('the quick brown fox\n', 'the slow brown fox\n', 'the quick red fox\n')).toEqual(
      clean('the slow red fox\n'),
    );
  });

  it('merges edits to different sentences of one long paragraph', () => {
    const base = 'First sentence here. Second sentence follows it. Third one ends the paragraph.\nNext line.\n';
    const ours = 'First sentence is changed. Second sentence follows it. Third one ends the paragraph.\nNext line.\n';
    const theirs = 'First sentence here. Second sentence follows it. A new third one ends it.\nNext line.\n';
    expect(merged(base, ours, theirs)).toEqual(
      clean('First sentence is changed. Second sentence follows it. A new third one ends it.\nNext line.\n'),
    );
  });

  it('keeps an edit on its own line when the other side rewrote the lines around it', () => {
    const base = 'line19\nline20 beta gamma\nline21 beta gamma\nline22 a longer line of prose.\n';
    const ours = 'line19\nline20 beta gamma edited by us\nline21 beta gamma\nline22 a longer line of prose.\n';
    const theirs = 'rewritten 19 by them\nline20 beta gamma\nrewritten 21 by them\nrewritten 22 by them\n';
    expect(merged(base, ours, theirs)).toEqual(
      clean('rewritten 19 by them\nline20 beta gamma edited by us\nrewritten 21 by them\nrewritten 22 by them\n'),
    );
  });

  it('does not splice one edited word into a sentence the other side rewrote', () => {
    const base = 'Intro. The quick brown fox jumps over it. End.\n';
    const ours = 'Intro. The quick brown dog jumps over it. End.\n';
    const theirs = 'Intro. A slow red cat sleeps under it. End.\n';
    const r = merged(base, ours, theirs);
    expect(r.text).toBe(ours);
    expect(r.conflicts).toHaveLength(1);
    expect(merged(base, ours, theirs, 'theirs').text).toBe(theirs);
  });

  it('merges word by word in a very long line too (where the token diff changes method)', () => {
    // 3,000 words on one line: every space matches every other, so the Myers diff is used.
    const words = Array.from({ length: 3000 }, (_, i) => `w${i % 50}`);
    const line = (ws: string[]) => ws.join(' ') + '\nend\n';
    const ours = [...words];
    const theirs = [...words];
    ours[10] = 'OURS';
    ours[1500] = 'OURS2';
    theirs[1501] = 'THEIRS';
    theirs[2990] = 'THEIRS2';
    const expected = [...words];
    expected[10] = 'OURS';
    expected[1500] = 'OURS2';
    expected[1501] = 'THEIRS';
    expected[2990] = 'THEIRS2';
    expect(merged(line(words), line(ours), line(theirs))).toEqual(clean(line(expected)));
  });

  it('gives one conflict when both sides rewrite a very long line', () => {
    const say = (seed: number) => Array.from({ length: 3000 }, (_, i) => `w${(i * seed) % 37}`).join(' ') + '\n';
    const r = merged(say(1), say(7), say(11));
    expect(r.text).toBe(say(7));
    expect(r.conflicts).toHaveLength(1);
  });

  it('stops when the work allowance runs out, and returns the preferred side whole as one conflict', () => {
    // Three unrelated texts of 110,000 lines drawn from six contents: diffing them would take seconds.
    let s = 1;
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pool = ['', '', '---', '- item', '| a | b |', 'same line'];
    const make = () => Array.from({ length: 110_000 }, () => pool[Math.floor(rand() * pool.length)]).join('\n') + '\n';
    const [base, ours, theirs] = [make(), make(), make()];
    const r = merge3(base, ours, theirs);
    expect(r.text).toBe(ours);
    expect(r.conflicts).toEqual([{ from: 0, to: ours.length, ours, theirs, base }]);
    expect(merge3(base, ours, theirs, { prefer: 'theirs' }).text).toBe(theirs);
  });

  it('does not stop on a large text with ordinary edits', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `Line ${i} of a long note, with some words in it.`);
    const ours = [...lines];
    const theirs = [...lines];
    const expected = [...lines];
    for (let k = 0; k < 50; k++) {
      ours[k * 397] = expected[k * 397] = `${lines[k * 397]} (ours ${k})`;
      theirs[k * 397 + 5] = expected[k * 397 + 5] = `(theirs ${k}) ${lines[k * 397 + 5]}`;
    }
    const join = (ls: string[]) => ls.join('\n') + '\n';
    expect(merge3(join(lines), join(ours), join(theirs))).toEqual(clean(join(expected)));
  });

  it('merges a deleted word next to an edited word', () => {
    expect(merged('a b c d\n', 'a c d\n', 'a b C d\n')).toEqual(clean('a C d\n'));
  });

  it('treats the same change on both sides as no conflict', () => {
    expect(merged('a\nb\nc\n', 'a\nB\nc\nd\n', 'a\nB\nc\n')).toEqual(clean('a\nB\nc\nd\n'));
    expect(merged('x y z\n', 'x Y z\n', 'x Y z!\n')).toEqual(clean('x Y z!\n'));
  });

  it('merges a word both sides deleted with words one side added later in the line', () => {
    expect(merged('alpha beta gamma\n', 'alpha gamma\n', 'alpha gamma delta\n')).toEqual(clean('alpha gamma delta\n'));
    expect(merged('alpha beta gamma\n', 'alpha gamma delta\n', 'alpha gamma\n')).toEqual(clean('alpha gamma delta\n'));
    expect(merged('- [ ] buy old milk\n', '- [ ] buy milk\n', '- [ ] buy milk today\n')).toEqual(
      clean('- [ ] buy milk today\n'),
    );
  });

  it('reads a change by its words first, so the marks it adds meet no change of the other side', () => {
    const cases: [string, string, string][] = [
      ['see [[a]] and [[b]] or [[c]] then\n', 'see [[a]] and [[b]] then\n', 'se [[d]] e [[a]] and [[b]] then\n'],
      ['see **a** and **b** or **c** then\n', 'see **a** and **b** then\n', 'se **d** e **a** and **b** then\n'],
    ];
    for (const [base, deleted, added] of cases)
      for (const prefer of ['ours', 'theirs'] as const) {
        expect(merged(base, deleted, added, prefer)).toEqual(clean(added));
        expect(merged(base, added, deleted, prefer)).toEqual(clean(added));
      }
  });

  it('keeps a conflict where one side edits a link the other side renamed in place', () => {
    const r = merged('see [[a]] and [[b]] then\n', 'see [[a]] and [[bee]] then\n', 'see [[d]] and [[a]] then\n');
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  it('keeps the preferred side when both insert at the same spot', () => {
    const base = 'a\nc\n';
    const r = merged(base, 'a\nb\nc\n', 'a\nx\nc\n');
    expect(r.text).toBe('a\nb\nc\n');
    expect(r.conflicts).toEqual([{ from: 2, to: 4, ours: 'b\n', theirs: 'x\n', base: '' }]);
    expect(merged(base, 'a\nb\nc\n', 'a\nx\nc\n', 'theirs').text).toBe('a\nx\nc\n');

    const inLine = merged('the cat\n', 'the big cat\n', 'the fat cat\n');
    expect(inLine.text).toBe('the big cat\n');
    expect(inLine.conflicts).toHaveLength(1);
  });

  it('keeps both lines inserted at one spot against an exact base, ours first', () => {
    const base = 'a\nc\n';
    expect(merged(base, 'a\nb\nc\n', 'a\nx\nc\n', 'ours', true)).toEqual(clean('a\nb\nx\nc\n'));
    expect(merged(base, 'a\nb\nc\n', 'a\nx\nc\n', 'theirs', true)).toEqual(clean('a\nb\nx\nc\n'));
    // Within a line it is the preferred side, as without an exact base.
    const inLine = merged('the cat\n', 'the big cat\n', 'the fat cat\n', 'ours', true);
    expect(inLine.text).toBe('the big cat\n');
    expect(inLine.conflicts).toHaveLength(1);
  });

  it('conflicts when one side deletes a line the other edits', () => {
    const r = merged('keep\ngone\nkeep too\n', 'keep\nkeep too\n', 'keep\nGONE changed\nkeep too\n');
    expect(r.text).toBe('keep\nkeep too\n');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.theirs).toContain('GONE changed');
    expect(merged('keep\ngone\nkeep too\n', 'keep\nkeep too\n', 'keep\nGONE changed\nkeep too\n', 'theirs').text).toBe(
      'keep\nGONE changed\nkeep too\n',
    );
  });

  it('merges an append at the end with an edit in the middle', () => {
    expect(merged('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\nd\ne\n')).toEqual(clean('a\nB\nc\nd\ne\n'));
  });

  it('handles texts without a final newline', () => {
    expect(merged('a\nb', 'A\nb', 'a\nb\nc')).toEqual(clean('A\nb\nc'));
    expect(merged('a\nb\n', 'a\nb', 'A\nb\n')).toEqual(clean('A\nb'));
    expect(merged('a\nb', 'x\na\nb', 'a\nB')).toEqual(clean('x\na\nB'));
    expect(merged('a\nb', 'a\nb\n', 'a\nb\n')).toEqual(clean('a\nb\n'));
    expect(merged('one\ntwo\nthree', 'one\ntwo', 'one\ntwo edited\nthree')).toEqual(clean('one\ntwo edited'));
    expect(merged('one\ntwo', 'one\ntwo\nthree', 'one edited\ntwo')).toEqual(clean('one edited\ntwo\nthree'));
  });

  it('merges a new line next to a line the other side deletes or edits at its end', () => {
    expect(merged('a\nb\nc\n', 'a\nnew\nb\nc\n', 'a\nc\n')).toEqual(clean('a\nnew\nc\n'));
    expect(merged('a\nb\nc\n', 'a\nnew\nb\nc\n', 'a edited\nb\nc\n')).toEqual(clean('a edited\nnew\nb\nc\n'));
  });

  it('merges a line typed after the end of a line with a line the other side puts after it', () => {
    // A line break typed after text belongs to that typing; only a blank line's break can be read
    // as standing on either side of a change next to it.
    const base = 'gamma fox\nindia beta\n';
    const ours = 'gamma fox X\nnew\nindia beta\n';
    const theirs = 'gamma fox\nfox golf\nindia beta\n';
    expect(merged(base, ours, theirs)).toEqual(clean('gamma fox X\nnew\nfox golf\nindia beta\n'));
  });

  it('conflicts on a new line inserted before a line the other side edits at its start', () => {
    // Both insert something at one place (the start of line b); which comes first is a guess.
    const r = merged('a\nb\nc\n', 'a\nnew\nb\nc\n', 'a\nB! b\nc\n');
    expect(r.text).toBe('a\nnew\nb\nc\n');
    expect(r.conflicts).toHaveLength(1);
  });

  it('handles an empty base', () => {
    expect(merged('', 'x\n', '')).toEqual(clean('x\n'));
    const r = merged('', 'mine\n', 'theirs\n');
    expect(r.text).toBe('mine\n');
    expect(r.conflicts).toEqual([{ from: 0, to: 5, ours: 'mine\n', theirs: 'theirs\n', base: '' }]);
  });

  it('handles an empty base that is exact', () => {
    expect(merged('', 'mine\n', 'theirs\n', 'ours', true)).toEqual(clean('mine\ntheirs\n'));
    // Text with no line break is not whole lines.
    const r = merged('', 'mine', 'theirs', 'ours', true);
    expect(r.text).toBe('mine');
    expect(r.conflicts).toEqual([{ from: 0, to: 4, ours: 'mine', theirs: 'theirs', base: '' }]);
  });

  it('handles a side that is empty', () => {
    expect(merged('a\nb\n', '', 'a\nb\n')).toEqual(clean(''));
    const r = merged('a\nb\n', '', 'a\nB\n');
    expect(r.text).toBe('');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ from: 0, to: 0, ours: '' });
    expect(merged('a\nb\n', '', 'a\nB\n', 'theirs').text).toBe('a\nB\n');
  });

  it('keeps conflicts ascending when there are several', () => {
    const base = 'one two three\nfour\nfive six seven\n';
    const r = merged(base, 'one TWO three\nfour\nfive SIX seven\n', 'one 2 three\nfour\nfive 6 seven\n');
    expect(r.conflicts).toHaveLength(2);
    expect(r.conflicts[0]!.to).toBeLessThan(r.conflicts[1]!.from);
  });
});

// ---------------------------------------------------------------------------
// Text repeated or lost: where content repeats, one side's change could sit in more than
// one place, and the two sides' diffs may pick different places. Shrunk cases, kept by
// name.

// ---------------------------------------------------------------------------
// A side whose text ends without the base's final line break took that line break off its own
// last line. Lines the other side puts after that line stay lines of their own, and the merged
// text ends as the side whose lines end it does.

describe('merge3 never joins two lines where a side ends its text without a line break', () => {
  // [name, base, the side without a final line break, the other side, the merge]
  const cases: [string, string, string, string, string][] = [
    [
      'the last line deleted with the final line break, lines appended by the other side',
      '\n\n\n\n\nG\nGx\n',
      '\n\n\n\n\n\nG',
      '\n\n\n\n\nG\nGx\nx y z\n\n',
      '\n\n\n\n\n\nG\nx y z\n\n',
    ],
    ['only the final line break taken off, a line appended', 'a\nb\n', 'a\nb', 'a\nb\nc\n', 'a\nb\nc\n'],
    ['only the final line break taken off, a line appended without one', 'a\nb\n', 'a\nb', 'a\nb\nc', 'a\nb\nc'],
    ['the last line deleted with the final line break, a line appended', 'a\nb\n', 'a', 'a\nb\nc\n', 'a\nc\n'],
    ['the last line edited and its line break taken off, a line appended', 'a\nb\n', 'a\nB', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['the final line break taken off, a line put before the last', 'a\nb\n', 'a\nb', 'a\nx\nb\n', 'a\nx\nb'],
  ];

  it.each(cases)('%s', (_name, base, noBreak, other, meant) => {
    for (const prefer of ['ours', 'theirs'] as const) {
      // The file's text without the line break, and the document's.
      expect(merged(base, other, noBreak, prefer)).toEqual(clean(meant));
      expect(merged(base, noBreak, other, prefer)).toEqual(clean(meant));
    }
  });

  it('in CRLF texts, which the core merges as LF (toLf) and VS Code writes back as CRLF', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    for (const [, base, noBreak, other, meant] of cases) {
      const [b, n, o] = [base, noBreak, other].map((s) => toLf(crlf(s)));
      for (const prefer of ['ours', 'theirs'] as const) {
        expect(crlf(merged(b!, o!, n!, prefer).text)).toBe(crlf(meant));
        expect(crlf(merged(b!, n!, o!, prefer).text)).toBe(crlf(meant));
      }
    }
  });

  it('ends as the preferred side does where the lines that end the merge conflict', () => {
    // Theirs deleted "b", "c" and the final line break; ours edited "c". The line break after "a"
    // is in the conflict: ours's text has it, theirs's does not.
    const base = 'a\nb\nc\n';
    expect(merged(base, 'a\nb\nC\n', 'a', 'ours')).toMatchObject({ text: 'a\nb\nC\n', conflicts: [{ theirs: '' }] });
    expect(merged(base, 'a\nb\nC\n', 'a', 'theirs').text).toBe('a');
    expect(merged(base, 'a', 'a\nb\nC\n', 'ours').text).toBe('a');
  });
});

// A base with no final line break is merged as one with it: a side that deletes the last line
// deletes that line, never the line break before it, so what the other side wrote on that line
// is never joined onto the line above. The merged text ends as the base did, unless a side put a
// final line break on.
describe('merge3 merges a base with no final line break as one with it', () => {
  it('conflicts where one side deletes the last line and the other changed it', () => {
    const base = '# Plan\n\nOrder wood\nCall Jim';
    const typed = '# Plan\n\nOrder wood\nCall Jim at nine';
    const deleted = '# Plan\n\nOrder wood';
    for (const [ours, theirs] of [
      [typed, deleted],
      [deleted, typed],
    ] as const) {
      expect(merged(base, ours, theirs, 'ours')).toMatchObject({ text: ours, conflicts: [{ base: '\nCall Jim' }] });
      expect(merged(base, ours, theirs, 'theirs').text).toBe(theirs);
    }
    // As with a final line break.
    expect(merged(`${base}\n`, `${typed}\n`, `${deleted}\n`, 'ours').conflicts).toHaveLength(1);
    expect(merged('a\nb', 'a', 'a\nb c', 'ours').conflicts).toHaveLength(1);
  });

  it('keeps a final line break a side put on, and ends without one where neither did', () => {
    expect(merged('a\nb', 'a\nb\n', 'x\nb')).toEqual(clean('x\nb\n'));
    expect(merged('a\nb', 'x\nb', 'a\nb\n')).toEqual(clean('x\nb\n'));
    expect(merged('a\nb', 'a\nB', 'x\nb')).toEqual(clean('x\nB'));
  });
});

describe('merge3 never repeats or drops a change', () => {
  it('a new line "G" on one side, "G" in place of all on the other', () => {
    // The wrong result is "G\nG": the G twice, though neither side has it twice.
    const r = merged('\nGx', 'G', 'G\n\n');
    expect(r.text).toBe('G');
    expect(r.conflicts).toEqual([{ from: 0, to: 1, ours: 'G', theirs: 'G\n\n', base: '\nGx' }]);
    expect(merged('\nGx', 'G', 'G\n\n', 'theirs').text).toBe('G\n\n');
  });

  it("an insertion that meets the other side's replacement at either end conflicts", () => {
    // Both put an "A" at one place: "AA" would be a guess.
    expect(merged('x', 'Ax', 'A').conflicts).toHaveLength(1);
    expect(merged('x', 'xA', 'A').conflicts).toHaveLength(1);
    expect(merged('x', 'Ax', 'A').text).toBe('Ax');
  });

  it('the same lines inserted where they could sit in several places conflict', () => {
    // Ours inserted "b\na\n" after the last "a"; theirs inserted "Z\na\nb\n" at the top. In
    // "a b a" both could be "a b" inserted anywhere: merged cleanly they give "a b" twice.
    const r = merged('a\nb\na\n', 'a\nb\na\nb\na\n', 'Z\na\nb\na\nb\na\n');
    expect(r.conflicts.length).toBeGreaterThan(0);
    // The same in one line, by words.
    expect(merged('a b a', 'a b a b a', 'Z a b a b a').conflicts.length).toBeGreaterThan(0);
  });

  it('two deletions of one copy of a repeated line never lose both copies', () => {
    // Each side deleted one of two equal lines next to an edit. Ours's diff reads "top same"
    // made TOP, theirs's "same end" made END: merged cleanly, both copies would be lost.
    notWrong(merged('top\nsame\nsame\nend\n', 'TOP\nsame\nend\n', 'top\nsame\nEND\n'), 'TOP\nsame\nEND\n');
    notWrong(merged('top\nsame\nsame\nend\n', 'top\nsame\nend\n', 'top\nsame\nEND\n'), 'top\nsame\nEND\n');
  });

  it('two deletions of one blank line out of a run never lose two', () => {
    notWrong(merged('a\n\n\n\nb\n', 'A\n\n\nb\n', 'a\n\n\nB\n'), 'A\n\n\nB\n');
  });

  it('adjacent deletions of different lines both apply', () => {
    expect(merged('l10\nl11\nl12\nl13\n', 'l10\nl11\nl13 edited\n', 'l10\nl12\nl13\n')).toEqual(
      clean('l10\nl13 edited\n'),
    );
  });

  it('edits of two lines merge with a deletion of the lines after them, with no final newline', () => {
    // The edits' token diff folds the line break between them in; that is not a line moved.
    expect(merged('line0\nline1\nline2\nline3', 'line0\nline1', 'line0 edited\nthem1\nline2\nline3')).toEqual(
      clean('line0 edited\nthem1'),
    );
    // A line deleted and the next edited at its start read as one change that joins lines;
    // the last line's own line break, which the other side deletes, is the same either way.
    expect(merged('line0\nline1\nline2\nline3', 'line0\nline1\nline2', 'line0\nthem2 line2\nline3')).toEqual(
      clean('line0\nthem2 line2'),
    );
  });

  it('a new line next to a repeated line, and an edit of its twin, conflict', () => {
    // Ours put a second "x" after "x"; theirs changed that "x". Which "x" theirs changed,
    // the old or the new, is a guess.
    const r = merged('x\ny\n', 'x\nx\ny\n', 'X\ny\n');
    expect(r.conflicts.length).toBeGreaterThan(0);
  });

  it('text added at the end of a line the other side empties conflicts', () => {
    // Ours reads as "x" deleted and " b" added after "a"; theirs empties the line "a". Applied
    // side by side they would leave " b" and lose the "a" it was written against.
    const r = merged('x\na\n', 'a b\n', 'x\n\n');
    expect(r.text).toBe('a b\n');
    expect(r.conflicts).toEqual([{ from: 0, to: 3, ours: 'a b', theirs: '', base: 'a' }]);
    expect(merged('x\na\n', 'a b\n', 'x\n\n', 'theirs').text).toBe('\n');
  });

  it('text added to a word the other side replaces conflicts, though folded with a later edit', () => {
    // Theirs adds " b" after "a" and deletes "Gx"; with only a line break between, the two
    // are one change that starts right after "a", which ours replaces with "same".
    const r = merged('a\nGx\n', 'same\nGx\n', 'a b\n\n');
    expect(r.text).toBe('same\nGx\n');
    expect(r.conflicts).toEqual([{ from: 0, to: 7, ours: 'same\nGx', theirs: 'a b\n', base: 'a\nGx' }]);
  });

  it('a blank line both sides put beside one blank line is taken once', () => {
    // Each side's text has two blank lines after "Gx" where the base has one: the same edit.
    const r = merged('\n\n\n\nGx\n\na', '\n\n\n\n\nGx\n\n\na', '\n\n\n\nGx\n\n\na');
    expect(r).toEqual(clean('\n\n\n\n\nGx\n\n\na'));
  });

  // Cases where the texts allow two readings that merge differently. Each must be the merge
  // both sides meant, or a conflict.
  it.each([
    // Two of one side's changes joined across a line lost the lines the second could slide over.
    [
      'changes joined across a line keep their readings',
      '\nb a\n\nx y z\n\na\n\n',
      '\nb a\n\na\n\n',
      'same\n\na b\nb a\n\n\nb a\n\nx y z\n\nx y z\n\na\n\n\n',
      'same\n\na b\nb a\n\nb a\n\n\nx y z\n\na\n\n\n',
    ],
    // "same\na" made "same a": a line break made a space, or "a" moved up and its line deleted.
    [
      'lines joined on one side, one of them deleted on the other',
      'same\na\n\n\nGx\n\na b',
      'same\n\n\nGx\na b',
      'same a\n\n\nGx A\n\na b',
      'same a\n\n\nGx A\na b',
    ],
    [
      'lines joined on one side, one of them edited on the other',
      'a\nsame\n\n',
      'a\nGx\n\n\n',
      'a same\n\n',
      'a same\nGx\n\n\n',
    ],
    // The kept blank line can be any of three: theirs's line has no certain place.
    [
      'two changes of one side around a kept line equal to lines they write',
      'G\n\nsame\n',
      'a b\n\n\n\n',
      'G\nx y z\n\nsame\n',
      'a b\n\nx y z\n\n\n',
    ],
    [
      'a new copy of a line joined with an edit below it, and the line edited',
      'same\n\n\n\n',
      'same\nsame\n\nx y z\n\n',
      'same A\n\n\n\n',
      'same\nsame A\n\nx y z\n\n',
    ],
    // "a" inserted after a blank line, with blank lines inserted further on, can stand before it.
    [
      'the same lines inserted by both, read in different places across blank lines',
      'Gx\nb a\nx y z\n\n\n\n',
      'Gx\n\na\nx y z\n\n\n\n',
      'Gx\nsame\nb a\n\na\n\n\n\n\na b\n\n',
      'Gx\nsame\n\na\n\n\n\n\na b\n\n',
    ],
    // Three copies of "same" on one side, two in the base: no single matching of lines.
    [
      "the same lines inserted by both, one side's copies matched another way",
      'G\nb a\nsame\nb a\nsame\nG',
      'G\nsame\n\n\nsame\n\nsame\n\nA',
      'G\nsame\n\nb a\nsame\nb a\nsame\nG',
      'G\nsame\n\n\nsame\n\nsame\n\nA',
    ],
    [
      'the same lines inserted by both, one read as new lines and one as an edit',
      'b a\n\na b\n',
      'b a\n\nb a\na\n',
      '\nb a\n\nb a\na\na b\n',
      '\nb a\n\nb a\na\n',
    ],
    ['a copy of a last line with no line break, and the line rewritten', 'a', 'a\nG', 'b a\nG', 'b a\nG\nG'],
    // Ours made "Gx" into "a b" and deleted "a"; read by tokens it kept "a" and added " b".
    ['a line rewritten as words of the next, which the other side empties', 'Gx\na\n', 'a b\n', 'Gx\n\n', 'a b\n\n'],
    // Theirs's " b" after "a" is folded with its deletion of "Gx" into one change.
    [
      'a word added to a line the other side rewrites, with the next line',
      'a\nGx\n',
      'same\nGx\n',
      'a b\n\n',
      'same\na b\n\n',
    ],
    // "same\n" made "x y z\nA": the "A" stands at the start of the next line.
    [
      'a replacement ending partway into a line the other side may occupy',
      'same\n\na\nsame',
      'x y z\nA\na\nsame',
      'same\n\n\na A\nsame',
      'x y z\n\nA\na A\nsame',
    ],
    [
      'three copies of a line, one of them edited on the other side',
      '\na\nb a',
      'a\na\na\nsame',
      '\nA\nb a',
      'a\na\nA\nsame',
    ],
    [
      'a kept line equal to one the next change writes',
      'same\nGx\nG\n\n',
      'a b\nGx\nGx\nG\nG\n',
      'same\n\nGx\nG\n\n',
      'a b\nGx\n\nGx\nG\nG\n',
    ],
    [
      'four copies of a line, matched by no single shortest reading',
      '\n\n\na b\n\nsame\na b',
      'same\n\nsame\n\nA\na b A\nb a\nsame\na b\nsame\nG',
      '\n\n\na b\n\nsame A\na b',
      'same\n\nsame\n\nA\na b A\nb a\nsame A\na b\nsame\nG',
    ],
    [
      "an edit at the end of a last line with no line break, inside the other side's change",
      'x y z\nsame',
      'x y z\nsame A',
      '\nsame\nsame',
      '\nsame A\nsame',
    ],
    [
      'two lines made two others, one of them equal to a kept one',
      '\na b\nGx\nb a',
      'same\na b\nGx A\nb a',
      '\n\nGx\nsame',
      '\nsame\nGx A\nsame',
    ],
    // Theirs's "\na b" made "A b\na" keeps "\n a" or " b" (two shortest token readings); in
    // one, ours's "a" made "A" is the same edit as theirs's, in the other it lands on the new "a".
    [
      'an edit of a word the other side kept in one reading and rewrote in another',
      '\na b',
      '\nA b',
      'A b\na',
      'A b\na',
    ],
    // Ours joined "a b" with the next line ("\na" made " A"); theirs put a copy of "a b" beside it.
    [
      'a copy of a line beside it, and the line joined with the next on the other side',
      '\n\nG\n\na b\na\n\n',
      '\n\n\nG\n\na b A\n\n',
      '\n\nG\nsame\na b\na b\na\n\n',
      '\n\n\nG\nsame\na b A\na b\n\n',
    ],
    // Ours put "", "same" before a blank line, which could as well be "same", "" after it; theirs
    // deleted a line break there, which may be that blank line or the one ending the line above.
    [
      'lines put beside a blank line the other side deletes',
      'a\nb a\n\nsame\n',
      'a\nb a\n\nsame\n\nsame\n',
      'a\na\nsame\n',
      'a\na\n\nsame\nsame\n',
    ],
    [
      'lines put beside a blank line the other side deletes, with no final newline',
      'x y z\n\nGx\n\n\nG\nx y z',
      'x y z\n\nsame\n\nGx\nGx\n\n\nG\nx y z',
      'A y z\nGx\n\n\nG A\nA y z',
      'A y z\n\nsame\nGx\nGx\n\n\nG A\nA y z',
    ],
  ])('%s', (_name, base, ours, theirs, meant) => {
    notWrong(merged(base, ours, theirs), meant);
    notWrong(merged(base, ours, theirs, 'theirs'), meant);
    notWrong(merged(base, ours, theirs, 'ours', true), meant);
    notWrong(merged(base, ours, theirs, 'theirs', true), meant);
  });
});

// ---------------------------------------------------------------------------
// An edited line with a blank line moved past it: a line diff that pairs only equal lines keeps
// one blank line more by pairing them one further along, and reads the edited line as written
// beside its old self. The two are one change, so the other side's change to the line is
// weighed against it.

/** How often `word` (a word as the merge reads text) stands in the merge outside every conflict. */
function outsideConflicts(r: MergeResult, word: string): number {
  let n = 0;
  for (const m of r.text.matchAll(WORD))
    if (m[0] === word && !r.conflicts.some((c) => m.index >= c.from && m.index < c.to)) n++;
  return n;
}

describe('merge3 pairs an edited line with its old self across blank lines', () => {
  // With the file preferred: the document edited a line and moved a blank line past it, and the
  // file deleted words from that line. The last column holds the words the other side deleted.
  it.each([
    [
      'a line edited below a blank line, its words taken out by the file',
      'lima alpha india\ngamma ⟦9001⟧ ⟦9002⟧ ⟦9003⟧\nkilo lima kilo mike ⟦9004⟧\n\n⟦9005⟧ gamma lima golf\ngolf ⟦9006⟧ echo\n\n',
      'lima alpha ⟦3⟧ indiahotel\nhotelgamma ⟦9001⟧ ⟦9002⟧ ⟦9003⟧\n\ngolf\nbeta\n⟦10⟧ kilo⟦8⟧ lima kil m⟦4⟧ ike ⟦9004⟧⟦6⟧ \n\n⟦9005⟧ gamma⟦1⟧ ⟦9⟧li⟦11⟧ ma g⟦5⟧ olf\ngokilo ',
      'lima alpha indi ⟦7⟧ a\ngamma ⟦9001⟧ ⟦9002⟧ ⟦9003⟧\nkilo lima kilo mike ⟦9004⟧\namma lima golf\ngolf ⟦9006⟧',
      ['9005'],
    ],
    [
      'a paragraph split by a blank line, its lines taken apart by the file',
      'alpha india ⟦9001⟧\nlima gamma ⟦9002⟧ gamma kilo\ndelta ⟦9003⟧ kilo golf golf\ngolf beta echo fox golf ⟦9004⟧\n⟦9005⟧ \nhotel lima golf india gamma kilo\nmike\n\n⟦9006⟧ india golf gamma\n⟦9007⟧ ⟦9008⟧ golf alpha mike echo\nfox alpha delta mike alpha\n\n',
      'alphfox a limai⟦4⟧ ndia alpha ⟦2⟧ ⟦9001⟧\nlima l\ngamma imagolf  gamgolfma ⟦9002⟧ gamma kilo kil b⟦23⟧et⟦14⟧\nbeta a.o golf golf\ngolf becho eta echo fox⟦16⟧\n golf ⟦9004⟧\n⟦9005⟧ \nhotel lima golf i⟦10⟧ndia ga⟦20⟧ mmdeltaa kilo\nmihotel ⟦19⟧ ke\n\n⟦9006⟧ i⟦6⟧⟦17⟧dia ⟦22⟧  golf  mike\ndelta\nkilo\n⟦26⟧ ⟦3⟧ gamma\n\n⟦15⟧ ⟦9007⟧ ⟦9008⟧hotel\n golf alpha mi⟦28⟧ \n⟦7⟧ g⟦27⟧ olf ⟦8⟧ ⟦9⟧ ke echo\nf⟦18⟧ox alpha delta mike alha\nlima\n⟦13⟧beta',
      'alpha india ⟦9001⟧\nlma ⟦9002⟧ gamma kilo\ndelta ⟦9003⟧ golf golf\nalpha ⟦12⟧ beta\ngolf beta echo fox glf ⟦9004⟧\n⟦9005⟧ \necho ⟦25⟧ delta\nhotel lima golf india gamma k ⟦11⟧ ilo\nmike\n\n⟦9006⟧ india golf gamm golf alph ⟦5⟧ a mike echo\nfox alpha delta mik ⟦24⟧ e alpha\n\n',
      ['9007', '9008'],
    ],
    [
      'a line edited above a blank line, cut short by the file',
      'alpha \n\n\nindia ⟦9001⟧ \n\ngamma lima ⟦9002⟧\nfox ⟦9003⟧ mike ⟦9004⟧ ⟦9005⟧\necho ⟦9006⟧ mike beta golf\nalpha beta alpha\nkilo gamma golf kilo golf\nfox hotel ⟦9007⟧\ngolf\n',
      'alp⟦9⟧\nha \n\n ⟦15⟧ ⟦16⟧ \nindia ⟦9001⟧ beta ⟦18⟧ fox  mike\n\ngamma⟦1⟧ lima ⟦9002⟧\nfox ⟦19⟧ ⟦9003⟧ mike ⟦9004⟧ alphagolf ⟦9005⟧⟦3⟧\n\necho ⟦9006⟧ mie beta golf\nalpha beta alpha\nkilo lima. gamma g⟦4⟧olf gamma kil⟦10⟧ o gol\n⟦5⟧ ⟦6⟧ f\nfox hotel ⟦9007⟧⟦13⟧ \ngolf\n',
      'alpha \n\n\nind \n\ngamma lima ⟦9002⟧ke ⟦9004⟧ ⟦9005⟧\necho ⟦9006⟧ mike beta golf\nalpha beta alpha\nkilo gamma golf kilo golf\nfox hotel ⟦9007⟧\ngolf\ngolf ⟦27⟧ echo\n',
      ['9001'],
    ],
    // Shrunk from the oracle (keeps no word one side removed...).
    ['a line edited past a blank line, emptied by the other side', '\nx y z\n', 'A y z\n\nA', '\n\nA', ['y', 'z']],
    [
      'a line edited past a blank line, deleted by the other side',
      'same\nx y z\n\na\n',
      '\nx y z A\nb a\na\n',
      'same\n\na',
      ['x', 'y', 'z'],
    ],
    // Ours's "b a A" reads as written above "same", a line ours holds twice.
    [
      'a line edited past a line the side holds twice, replaced by the other side',
      '\n\nsame\nb a\n',
      '\nx y z\na\nsame\n\nb a A\nsame\nGx\nG\n',
      '\n\nsame\n\nG\n',
      ['b'],
    ],
    [
      'a line edited past a blank line, rewritten by the other side',
      '\n\nx y z\n\n',
      '\nG\nx y z new\n\n\n',
      '\n\nGx\n\n',
      ['x', 'y', 'z'],
    ],
  ])('%s', (_name, base, ours, theirs, gone) => {
    for (const prefer of ['ours', 'theirs'] as const) {
      for (const exactBase of [false, true]) {
        const r = merged(base, ours, theirs, prefer, exactBase);
        expect(r.conflicts.length).toBeGreaterThan(0);
        for (const w of gone) expect(outsideConflicts(r, w)).toBe(0);
      }
    }
  });

  it('conflicts when one side edits a line and moves a blank line past it, and the other deletes it', () => {
    // Read as a new line above a blank line and the old one deleted, ours's edit would merge
    // cleanly with theirs's deletion: the line theirs deleted would stand again, unreported.
    const base = '\n\nx y z\n\n';
    const ours = '\nG\nx y z new\n\n\n';
    const theirs = '\n\n\n';
    expect(merged(base, ours, theirs, 'ours')).toMatchObject({ text: ours, conflicts: [{ theirs: '\n' }] });
    expect(merged(base, ours, theirs, 'theirs').text).toBe(theirs);
  });

  it('keeps an edited line whole when blank lines moved past it, under either preference', () => {
    // Ours deleted the first blank line, edited every line and added lines around "delta". Paired
    // by equal lines only, its blank lines are one further along than it kept them: "delta FOUR"
    // reads as written in place of "beta" and "gamma", and "delta four" as deleted. Ours's
    // changes are one change, and theirs's edit of "beta" and its new line before "delta four"
    // fall inside it: one conflict, and either side's text whole.
    const base = 'alpha one\n\nbeta two\ngamma three\n\ndelta four\n';
    const ours = 'alpha ONE\nbeta TWO\ngamma THREE\n\nadded line\ndelta FOUR\nlast line\n\n';
    const theirs = 'alpha one\n\nbeta two!\ngamma three\n\nfile line\ndelta four\n';
    const preferTheirs = merged(base, ours, theirs, 'theirs');
    expect(preferTheirs.text).toBe(theirs);
    expect(preferTheirs.conflicts).toHaveLength(1);
    const preferOurs = merged(base, ours, theirs, 'ours');
    expect(preferOurs.text).toBe(ours);
    expect(preferOurs.conflicts).toHaveLength(1);
    expect(preferOurs.conflicts[0]!.theirs).toContain('file line');
  });

  // Lines both sides write at one place are a conflict, or against an exact base both kept,
  // ours's first (null: "a" in "a b" may be one line edited, so a conflict there too). A change
  // joined from an edited line's halves must not hide that place.
  it.each([
    // Theirs's "b a" made "b G" with "a b", "same" appended after the blank line reads also as
    // "b a" moved past the blank line and edited: one change, ending at that blank line. Ours's
    // "a" appended at the same point meets theirs's appended lines.
    ['after the change', 'G\nb a\n\n', 'G\nb a\n\na\n', 'G\nb G\n\na b\nsame\n', null],
    // Ours's "a b" written above the blank line, with "a" and "same" deleted, reads also as "a"
    // moved up past the blank line and edited: one change, starting at that blank line. Theirs's
    // "Gx" written at the top meets ours's "a b" there.
    ['before the change', '\na\nsame\n', 'a b\n\n', 'Gx\n\na\nsame\n', 'a b\nGx\n\n'],
  ])(
    "weighs the other side's lines right %s, where the side wrote lines in one reading",
    (_name, base, ours, theirs, keptBoth) => {
      for (const prefer of ['ours', 'theirs'] as const) {
        expect(merged(base, ours, theirs, prefer).conflicts.length).toBeGreaterThan(0);
        const exact = merged(base, ours, theirs, prefer, true);
        if (keptBoth === null) expect(exact.conflicts.length).toBeGreaterThan(0);
        else notWrong(exact, keptBoth);
      }
    },
  );

  it("merges the other side's edit beyond a line of text both kept", () => {
    // Ours filled a blank line, edited "L one" and put a blank line after it; "M two" stands
    // between that change and theirs's, kept by both and held once, so they merge cleanly.
    const base = 'intro\n\nL one\n\nM two\nlast\n';
    const ours = 'intro\nX\nL one!\n\n\nM two\nlast\n';
    const theirs = 'intro\n\nL one\n\nM two\nlast line\n';
    expect(merged(base, ours, theirs)).toEqual(clean('intro\nX\nL one!\n\n\nM two\nlast line\n'));
  });
});

// ---------------------------------------------------------------------------
// A change split in two: a side's diff can read one change as text removed at one place and
// written at another (a line moved past a line of text, or a word moved within a line). Where
// one half is in a conflict, the other half is resolved with it.

describe('merge3 resolves both halves of a change split in two alike', () => {
  it('keeps a line one side moved where the other side adds a line, under either preference', () => {
    const base = 'first line\nsecond line\nthird line\n';
    const moved = 'second line\nthird line\nfirst line\n';
    const added = 'first line\nsecond line\nthird line\nnew line\n';
    expect(merged(base, moved, added, 'ours').text).toBe(moved);
    expect(merged(base, moved, added, 'theirs').text).toBe(added);
    expect(merged(base, added, moved, 'ours').text).toBe(added);
    expect(merged(base, added, moved, 'theirs').text).toBe(moved);
  });

  it('writes a line one side moved out of a conflict once, under either preference', () => {
    const base = 'top\nmoved line\nb\nc\nd\n';
    const ours = 'TOP\nb\nc\nd\nmoved line\n';
    const theirs = 'top!\nmoved line\nb\nc\nd\n';
    expect(merged(base, ours, theirs, 'ours').text).toBe(ours);
    expect(merged(base, ours, theirs, 'theirs').text).toBe(theirs);
  });

  it('keeps a word one side moved inside a line', () => {
    const base = 'alpha beta gamma delta\n';
    const ours = 'beta gamma alpha delta\n';
    const theirs = 'alpha beta gamma epsilon delta\n';
    expect(merged(base, ours, theirs, 'ours').text).toBe(ours);
    expect(merged(base, ours, theirs, 'theirs').text).toBe(theirs);
  });

  it('pairs halves only by text that the unchanged lines do not also hold', () => {
    // Ours moved "the" from "two the" to "one": the stretch at "one" is a conflict, so with theirs
    // preferred, the deletion at "two" is not applied either.
    const ours = (last: string) => `one the\nmid\ntwo\nthree\n${last}\n`;
    const theirs = (last: string) => `one more\nmid\ntwo the\nthree\n${last}\n`;
    const base = (last: string) => `one\nmid\ntwo the\nthree\n${last}\n`;
    expect(merged(base('keep a line'), ours('keep a line'), theirs('keep a line'), 'theirs').text).toBe(
      theirs('keep a line'),
    );
    // With "the" in a line neither side changed, the two are not known to be one word: both
    // changes stand as they are.
    expect(merged(base('keep the line'), ours('keep the line'), theirs('keep the line'), 'theirs').text).toBe(
      'one more\nmid\ntwo\nthree\nkeep the line\n',
    );
  });

  it('merges a moved line with no conflict when the other side edits another line', () => {
    const base = 'first line\nsecond line\nthird line\n';
    expect(
      merged(base, 'second line\nthird line\nfirst line\n', 'first line\nsecond line edited\nthird line\n'),
    ).toEqual(clean('second line edited\nthird line\nfirst line\n'));
  });
});

// ---------------------------------------------------------------------------
// Different whole lines both sides insert at one place, with nothing deleted there: against an
// exact base (MergeOptions.exactBase) both are kept, ours's first, with no conflict; otherwise
// the place is a conflict.

describe('merge3 keeps lines both sides insert at one place', () => {
  it('conflicts on them without an exact base, keeping the preferred side', () => {
    const cases: [string, string, string][] = [
      ['a\nb\n', 'a\nb\nmine\n', 'a\nb\ntheirs\n'],
      ['a\nb', 'a\nb\nmine', 'a\nb\ntheirs'],
      ['p\n', 'p\n\nmine\n', 'p\n\ntheirs\n'],
      ['- [ ] a\n', '- [ ] a\n- [ ] buy milk\n', '- [ ] a\n- [ ] buy eggs\n'],
    ];
    for (const [base, ours, theirs] of cases) {
      const r = merged(base, ours, theirs);
      expect(r.text).toBe(ours);
      expect(r.conflicts).toHaveLength(1);
      expect(merged(base, ours, theirs, 'theirs').text).toBe(theirs);
    }
  });

  /** The merge, clean whichever side is preferred. */
  const kept = (base: string, ours: string, theirs: string): string => {
    const r = merged(base, ours, theirs, 'ours', true);
    expect(r.conflicts).toEqual([]);
    expect(merged(base, ours, theirs, 'theirs', true)).toEqual(r);
    return r.text;
  };

  it("keeps lines both append at the end, ours's first", () => {
    expect(kept('a\nb\n', 'a\nb\nmine\n', 'a\nb\ntheirs\n')).toBe('a\nb\nmine\ntheirs\n');
    expect(kept('a\nb\n', 'a\nb\none\ntwo\n', 'a\nb\nthree\n')).toBe('a\nb\none\ntwo\nthree\n');
  });

  it('keeps lines both append after a last line with no line break', () => {
    expect(kept('a\nb', 'a\nb\nmine', 'a\nb\ntheirs')).toBe('a\nb\nmine\ntheirs');
    expect(kept('a\nb', 'a\nb\nmine\n', 'a\nb\ntheirs\n')).toBe('a\nb\nmine\ntheirs\n');
    // The new lines end with what the last line ends with: read by tokens they could slide
    // back over it, but lines inserted whole have no such other place.
    expect(kept('a\nSome text.', 'a\nSome text.\nMore text.', 'a\nSome text.\nOther line.')).toBe(
      'a\nSome text.\nMore text.\nOther line.',
    );
    expect(kept('- [ ] call mom', '- [ ] call mom\n- [ ] mom again', '- [ ] call mom\n- [ ] eggs')).toBe(
      '- [ ] call mom\n- [ ] mom again\n- [ ] eggs',
    );
    // After a last line with no line break, as after one with: a copy of that line, or a line
    // after two equal ones, reads the same on either side, and is kept with the other side's line.
    expect(kept('a\nb', 'a\nb\nb', 'a\nb\nc')).toBe('a\nb\nb\nc');
    expect(kept('a\nb\n', 'a\nb\nb\n', 'a\nb\nc\n')).toBe('a\nb\nb\nc\n');
    expect(kept('x\nx', 'x\nx\nmine', 'x\nx\ntheirs')).toBe('x\nx\nmine\ntheirs');
  });

  it('keeps lines both insert between the same two lines', () => {
    expect(kept('a\nb\n', 'a\nmine\nb\n', 'a\ntheirs\nb\n')).toBe('a\nmine\ntheirs\nb\n');
    expect(kept('', 'mine\n', 'theirs\n')).toBe('mine\ntheirs\n');
  });

  it('writes a line both insert once, with the rest of each side around it', () => {
    expect(kept('a\n', 'a\nL1\n', 'a\nL1\nL2\n')).toBe('a\nL1\nL2\n');
    expect(kept('a\n', 'a\nL1\nL2\n', 'a\nL1\n')).toBe('a\nL1\nL2\n');
    expect(kept('a\n', 'a\nnew\nL1\n', 'a\nL1\nL2\n')).toBe('a\nnew\nL1\nL2\n');
  });

  it("writes the same lines inserted in different orders once, in ours's order", () => {
    expect(kept('x\n', 'x\nA\nB\n', 'x\nB\nA\n')).toBe('x\nA\nB\n');
    expect(kept('x\n', 'x\nB\nA\n', 'x\nA\nB\n')).toBe('x\nB\nA\n');
  });

  it('keeps two paragraphs added after blank lines as two paragraphs', () => {
    expect(kept('p\n', 'p\n\nmine\n', 'p\n\ntheirs\n')).toBe('p\n\nmine\n\ntheirs\n');
    expect(kept('p', 'p\n\nmine', 'p\n\ntheirs')).toBe('p\n\nmine\n\ntheirs');
  });

  it("keeps blank lines both insert before the next line once, after both sides' lines", () => {
    expect(kept('a\nb\n', 'a\nmine\n\nb\n', 'a\ntheirs\n\nb\n')).toBe('a\nmine\ntheirs\n\nb\n');
  });

  it('keeps two list items that begin with the same words', () => {
    expect(kept('- [ ] a\n', '- [ ] a\n- [ ] buy milk\n', '- [ ] a\n- [ ] buy eggs\n')).toBe(
      '- [ ] a\n- [ ] buy milk\n- [ ] buy eggs\n',
    );
  });

  it('merges edits of lines away from the kept lines', () => {
    expect(kept('a\nb\nc\nd\n', 'a\nb\nmine\nc\nd edited\n', 'A\nb\ntheirs\nc\nd\n')).toBe(
      'A\nb\nmine\ntheirs\nc\nd edited\n',
    );
  });

  it("reports where the result holds both sides' lines", () => {
    expect(merge3Detailed('a\nb\n', 'a\nmine\nb\n', 'a\ntheirs\nb\n', { exactBase: true }).bothInserted).toEqual([
      { from: 2, to: 14, ours: 'mine\n', theirs: 'theirs\n' },
    ]);
    // After a last line with no line break, as after one with: each side's lines, as it wrote them.
    expect(merge3Detailed('a\nb', 'a\nb\nmine', 'a\nb\ntheirs', { exactBase: true }).bothInserted).toEqual([
      { from: 4, to: 15, ours: 'mine', theirs: 'theirs' },
    ]);
    expect(merge3Detailed('a\nb\n', 'a\nB\n', 'a\nb\nc\n', { exactBase: true }).bothInserted).toEqual([]);
  });

  it('conflicts on two insertions inside a line at the same point', () => {
    const r = merged('the cat\n', 'the big cat\n', 'the fat cat\n', 'ours', true);
    expect(r.text).toBe('the big cat\n');
    expect(r.conflicts).toHaveLength(1);
    // Text with no line break at a line start is part of that line.
    expect(merged('a\nb\n', 'a\nmine b\n', 'a\ntheirs\nb\n', 'ours', true).conflicts).toHaveLength(1);
  });

  it('conflicts when a side also deletes or replaces text where both insert', () => {
    // Ours deletes the line after the place; edits the start of that line; edits its end, so
    // that its line diff reads the new line and the edit as one change of that line.
    expect(merged('a\nb\nc\n', 'a\nmine\nc\n', 'a\ntheirs\nb\nc\n', 'ours', true).conflicts).toHaveLength(1);
    expect(merged('a\nb\n', 'a\nmine\nB! b\n', 'a\ntheirs\nb\n', 'ours', true).conflicts).toHaveLength(1);
    expect(merged('a\nb\n', 'a\nmine\nb edited\n', 'a\ntheirs\nb\n', 'ours', true).conflicts).toHaveLength(1);
    // Theirs rewrites a line into three; its first piece is no line inserted whole.
    expect(merged('a\n\n', '\na\n\n', 'A\na b\nx y z\n\n', 'ours', true).conflicts).toHaveLength(1);
  });

  it('conflicts when the inserted lines could stand on either side of an equal line', () => {
    // Each side's lines can be read before or after the blank line already there: as two
    // paragraphs, as one, or with theirs first.
    const r = merged('a\n\n', 'a\n\nmine\n\n', 'a\n\ntheirs\n\n', 'ours', true);
    expect(r.text).toBe('a\n\nmine\n\n');
    expect(r.conflicts).toHaveLength(1);
    expect(merged('a\n\nb\n', 'a\n\nmine\n\nb\n', 'a\n\ntheirs\n\nb\n', 'ours', true).conflicts).toHaveLength(1);
    expect(merged('x\na\ny\n', 'x\na\na\ny\n', 'x\nz\na\ny\n', 'ours', true).conflicts).toHaveLength(1);
  });

  it("conflicts when one side's new line holds the other's words, in order and together", () => {
    // Either may be the other edited: kept together, one line would stand twice.
    const r = merged('a\n', 'a\nx\n', 'a\nx y\n', 'ours', true);
    expect(r.text).toBe('a\nx\n');
    expect(r.conflicts).toHaveLength(1);
    expect(merged('a\n', 'a\nlima \n', 'a\nlima\n', 'ours', true).conflicts).toHaveLength(1);
    expect(merged('a\n', 'a\n⟦6⟧ hotel\n', 'a\n⟦6⟧ \n', 'ours', true).conflicts).toHaveLength(1);
    // A line both have is no other's edit: it is written once, and the rest kept.
    expect(merged('a\n', 'a\nx\n', 'a\nx\nx y\n', 'ours', true)).toEqual(clean('a\nx\nx y\n'));
  });

  it('conflicts when only one side ends the text with a line break', () => {
    const r = merged('a\nb', 'a\nb\nmine\n', 'a\nb\ntheirs', 'ours', true);
    expect(r.text).toBe('a\nb\nmine\n');
    expect(r.conflicts).toHaveLength(1);
    expect(merged('', 'mine', 'theirs', 'ours', true).conflicts).toHaveLength(1);
  });

  it('keeps different lines both insert at one certain place, unless a line holds another', () => {
    // Base lines are distinct and unlike every inserted line, so each side's lines have one
    // place. Lines away from that place are edited by one side or the other. A conflict is
    // allowed only when a line only one side has holds the words of a line only the other has,
    // in order and together (it may be that line edited).
    const POOL = ['', '', 'same', 'a', 'a b', 'b a.', '- [ ] buy milk', '- [ ] buy eggs', '# Heading', 'end.'];
    const wordsIn = (line: string) => line.match(/[\p{L}\p{N}\p{M}\p{Pc}]+|\S/gu) ?? [];
    const holds = (big: string, small: string) => {
      const [b, s] = [wordsIn(big), wordsIn(small)];
      return s.length > 0 && b.some((_, k) => s.every((w, j) => b[k + j] === w));
    };
    let cleanRuns = 0;
    const insertion = fc.array(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 });
    const scenario = fc.integer({ min: 0, max: 12 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        at: fc.integer({ min: 0, max: n }),
        ours: insertion,
        theirs: insertion,
        owner: fc.array(fc.constantFrom(0, 0, 1, 2), { minLength: n, maxLength: n }),
        finalNewline: fc.boolean(),
        prefer: fc.constantFrom<Prefer>('ours', 'theirs'),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ n, at, ours, theirs, owner, finalNewline, prefer }) => {
        // Text with no line break at all is not whole lines; and at the end of a text with no
        // final line break, a last blank line is that line break.
        if (!finalNewline && (n === 0 || (at === n && [ours, theirs].some((l) => l[l.length - 1] === '')))) return;
        const lines = Array.from({ length: n }, (_, i) => `line${i} end.`);
        const edited = (who: number, i: number) =>
          owner[i] === who && i !== at - 1 && i !== at ? `${lines[i]} edited by ${who}` : lines[i]!;
        const side = (who: number, inserted: string[]) => {
          const out = lines.map((_, i) => edited(who, i));
          out.splice(at, 0, ...inserted);
          return joinLines(out, finalNewline);
        };
        const both = lines.map((l, i) => (owner[i] === 0 ? l : edited(owner[i]!, i)));
        const r = merged(joinLines(lines, finalNewline), side(1, ours), side(2, theirs), prefer, true);
        const onlyOurs = ours.filter((x) => !theirs.includes(x));
        const onlyTheirs = theirs.filter((y) => !ours.includes(y));
        const edit = onlyOurs.some((x) => onlyTheirs.some((y) => holds(x, y) || holds(y, x)));
        if (!edit) expect(r.conflicts).toEqual([]);
        if (r.conflicts.length > 0) return;
        cleanRuns++;
        const meant: Part[] = [...both.slice(0, at), { ours, theirs }, ...both.slice(at)];
        if (JSON.stringify(ours) === JSON.stringify(theirs)) meant.splice(at, 1, ...ours);
        if (!fits(r.text, meant, finalNewline))
          expect.fail(`${JSON.stringify(r.text)} is not the merge meant, ${JSON.stringify(meant)}`);
      }),
      seeded({ numRuns: 500 }),
    );
    if (!replaying) expect(cleanRuns).toBeGreaterThan(250);
  });
});

/**
 * Texts made from one base by known edits, so the merge each side meant is known. The
 * shapes are the dangerous ones: repeated identical lines, runs of blank lines, content
 * inserted equal to its neighbors, texts with and without a final newline, both sides
 * making the same edit, both sides deleting overlapping runs, and edits right next to
 * each other (adjacent lines, adjacent words).
 *
 * The promise: when merge3 reports no conflict, its text is the base with both sides'
 * edits applied, each once. That is the exact form of "the merge is ours with only
 * theirs's changes applied, and theirs with only ours's": nothing appears that neither
 * side wrote, nothing either side wrote appears twice, nothing both kept is lost. Against
 * an exact base, where both sides inserted different lines at one place, both sides' lines
 * are there as bothKeptFaults states. A conflict is always allowed (there may be doubt); a
 * clean wrong answer is not.
 */
const ORACLE_RUNS = Number(process.env.MERGE3_ORACLE_RUNS ?? 1500);
/** A run takes about half a millisecond on a desktop; four times that is allowed. */
const ORACLE_TIME_LIMIT_MS = 20_000 + 2 * ORACLE_RUNS;

type LineOp =
  | { kind: 'keep' }
  | { kind: 'delete' }
  | { kind: 'replace'; text: string }
  | { kind: 'word'; index: number; text: string }
  | { kind: 'append'; text: string };

const LINE_POOL = ['', '', '', 'same', 'same', 'a', 'a b', 'b a', 'x y z', 'G', 'Gx'];
const WORD_POOL = ['A', 'same', 'a', 'G', 'x', 'new'];

const lineOp = fc.oneof(
  { weight: 6, arbitrary: fc.constant<LineOp>({ kind: 'keep' }) },
  { weight: 2, arbitrary: fc.constant<LineOp>({ kind: 'delete' }) },
  { weight: 2, arbitrary: fc.constantFrom(...LINE_POOL).map((text): LineOp => ({ kind: 'replace', text })) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.nat(2), fc.constantFrom(...WORD_POOL))
      .map(([index, text]): LineOp => ({ kind: 'word', index, text })),
  },
  { weight: 1, arbitrary: fc.constantFrom(...WORD_POOL).map((text): LineOp => ({ kind: 'append', text })) },
);
/** Lines inserted before a base line (or at the end): none, or one or two from the pool. */
const insertOp = fc.oneof(
  { weight: 5, arbitrary: fc.constant<string[]>([]) },
  { weight: 2, arbitrary: fc.array(fc.constantFrom(...LINE_POOL), { minLength: 1, maxLength: 2 }) },
);
/** A side's edit to one place, or the same edit on both sides, or each side its own. */
const pairOf = <T>(op: fc.Arbitrary<T>, none: T) =>
  fc.oneof(
    { weight: 4, arbitrary: op.map((o) => [o, none] as [T, T]) },
    { weight: 4, arbitrary: op.map((o) => [none, o] as [T, T]) },
    { weight: 2, arbitrary: op.map((o) => [o, o] as [T, T]) },
    { weight: 2, arbitrary: fc.tuple(op, op) },
  );

const scenario = fc.integer({ min: 0, max: 9 }).chain((n) =>
  fc.record({
    lines: fc.array(fc.constantFrom(...LINE_POOL), { minLength: n, maxLength: n }),
    ops: fc.array(pairOf(lineOp, { kind: 'keep' } as LineOp), { minLength: n, maxLength: n }),
    inserts: fc.array(pairOf(insertOp, [] as string[]), { minLength: n + 1, maxLength: n + 1 }),
    finalNewline: fc.boolean(),
  }),
);

/**
 * A scenario in which one side also moves a blank line past a line it edits: it removes or fills
 * a blank line next to that line and puts a blank line on the line's other side. A line diff that
 * pairs only equal lines keeps one blank line more by pairing them one further along, and reads
 * the edited line as written beside its old self. Scenarios with no text line next to a blank
 * line are left as drawn.
 */
const blankMoved = scenario.chain((s) =>
  fc
    .record({
      at: fc.nat(),
      side: fc.constantFrom<0 | 1>(0, 1),
      edit: fc.oneof(
        fc.constantFrom(...WORD_POOL).map((text): LineOp => ({ kind: 'append', text })),
        fc
          .tuple(fc.nat(2), fc.constantFrom(...WORD_POOL))
          .map(([index, text]): LineOp => ({ kind: 'word', index, text })),
      ),
      gone: fc.constantFrom<LineOp>(
        { kind: 'delete' },
        { kind: 'replace', text: 'Gx' },
        { kind: 'replace', text: 'b a' },
      ),
    })
    .map(({ at, side, edit, gone }) => {
      const places: [number, number][] = [];
      s.lines.forEach((l, i) => {
        if (l === '') return;
        if (s.lines[i - 1] === '') places.push([i, i - 1]);
        if (s.lines[i + 1] === '') places.push([i, i + 1]);
      });
      if (places.length === 0) return s;
      const [i, blank] = places[at % places.length]!;
      const ops = s.ops.map((pair) => [...pair] as [LineOp, LineOp]);
      const inserts = s.inserts.map((pair) => [[...pair[0]], [...pair[1]]] as [string[], string[]]);
      ops[i]![side] = edit;
      ops[blank]![side] = gone;
      inserts[blank < i ? i + 1 : i]![side].push('');
      return { ...s, ops, inserts };
    }),
);

const sameOp = (x: LineOp, y: LineOp) => JSON.stringify(x) === JSON.stringify(y);

function applyLineOp(line: string, op: LineOp): string[] {
  switch (op.kind) {
    case 'keep':
      return [line];
    case 'delete':
      return [];
    case 'replace':
      return [op.text];
    case 'append':
      return [line === '' ? op.text : `${line} ${op.text}`];
    case 'word': {
      const words = line.split(' ');
      if (line === '' || op.index >= words.length) return [line];
      words[op.index] = op.text;
      return [words.join(' ')];
    }
  }
}

/**
 * The texts, and the merge both sides meant as lines, or null when the two sides changed one
 * line or one gap differently in a way that has no single meaning (left to the other
 * properties). A gap where both sides inserted different lines is a `Kept` part against an
 * exact base (MergeOptions.exactBase); without one it has no single meaning.
 */
function build(
  s: {
    lines: string[];
    ops: [LineOp, LineOp][];
    inserts: [string[], string[]][];
    finalNewline: boolean;
  },
  exactBase: boolean,
): { base: string; ours: string; theirs: string; meant: Part[] | null } {
  const side = (k: 0 | 1) => {
    const out: string[] = [];
    s.lines.forEach((l, i) => {
      out.push(...s.inserts[i]![k]);
      out.push(...applyLineOp(l, s.ops[i]![k]));
    });
    out.push(...s.inserts[s.lines.length]![k]);
    return out;
  };
  const expected: Part[] = [];
  let meaningful = true;
  const both = (i: number) => {
    const [o, t] = s.ops[i]!;
    if (o.kind === 'keep') return applyLineOp(s.lines[i]!, t);
    if (t.kind === 'keep' || sameOp(o, t)) return applyLineOp(s.lines[i]!, o);
    // Two different word edits of one line, on different words: both apply.
    const line = s.lines[i]!;
    const words = line.split(' ');
    if (
      o.kind === 'word' &&
      t.kind === 'word' &&
      o.index !== t.index &&
      line !== '' &&
      o.index < words.length &&
      t.index < words.length
    ) {
      words[o.index] = o.text;
      words[t.index] = t.text;
      return [words.join(' ')];
    }
    meaningful = false;
    return [line];
  };
  // Different lines both sides inserted in one gap are both kept where the gap's place is
  // certain: each line beside it is kept by both sides and is written once in every text.
  // Elsewhere each side's lines may be read at another place (beside an equal line, or as part
  // of its change of one of two equal lines), so what it meant is not known from its text.
  const texts = [s.lines, side(0), side(1)];
  const certain = (i: number) =>
    [i - 1, i].every(
      (l) =>
        l < 0 ||
        l >= s.lines.length ||
        (s.ops[l]![0].kind === 'keep' &&
          s.ops[l]![1].kind === 'keep' &&
          texts.every((ls) => ls.filter((x) => x === s.lines[l]).length === 1)),
    );
  const gap = (i: number): Part[] => {
    const [o, t] = s.inserts[i]!;
    if (o.length === 0) return t;
    if (t.length === 0 || JSON.stringify(o) === JSON.stringify(t)) return o;
    if (!exactBase || !certain(i)) meaningful = false;
    return [{ ours: o, theirs: t }];
  };
  s.lines.forEach((_, i) => {
    expected.push(...gap(i));
    expected.push(...both(i));
  });
  expected.push(...gap(s.lines.length));
  // A side that writes a line equal to one it removes can have its text read another way
  // (deleting a blank line and inserting one beside it is no change at all), so what it
  // meant is not known from its text: such scenarios are left out.
  for (const k of [0, 1] as const) {
    const removed = new Set<string>();
    const written = new Set<string>();
    s.lines.forEach((l, i) => {
      const op = s.ops[i]![k];
      if (op.kind !== 'keep') {
        removed.add(l);
        for (const w of applyLineOp(l, op)) written.add(w);
      }
    });
    for (const ins of s.inserts) for (const w of ins[k]) written.add(w);
    if ([...written].some((w) => removed.has(w))) meaningful = false;
  }
  // In a run of equal adjacent lines, edits by the two sides can always be read as the same
  // edit (one of two "a" lines deleted by each is one "a" deleted, which the merge takes once,
  // as a false conflict): what they meant is not known from the texts, so such scenarios
  // are left out here and covered by the named cases above. A single line counts as such a
  // run once both sides put a copy of it beside it: each side then holds the line twice
  // there, the same text, so the merge takes it once.
  // (Lines the side deletes next to the run, or makes copies of its line, leave its copies
  // next to the run too. The run is of lines as both sides leave them: lines both make
  // into the same line count as that line.)
  const copiesInRun = (k: 0 | 1, from: number, to: number, line: string) => {
    const passes = (i: number) => {
      const out = applyLineOp(s.lines[i]!, s.ops[i]![k]);
      return out.length === 0 || (out.length === 1 && out[0] === line);
    };
    let lo = from;
    while (lo > 0 && passes(lo - 1)) lo--;
    let hi = to;
    while (hi < s.lines.length && passes(hi)) hi++;
    for (let slot = lo; slot <= hi; slot++) if (s.inserts[slot]![k].some((l) => l === line)) return true;
    return false;
  };
  const touchesRun = (k: 0 | 1, from: number, to: number) => {
    for (let i = from; i < to; i++) if (s.ops[i]![k].kind !== 'keep') return true;
    return copiesInRun(k, from, to, s.lines[from]!);
  };
  for (let i = 0; i < s.lines.length;) {
    let j = i + 1;
    while (j < s.lines.length && s.lines[j] === s.lines[i]) j++;
    if (j - i >= 2 && touchesRun(0, i, j) && touchesRun(1, i, j)) meaningful = false;
    i = j;
  }
  const bothMake = (i: number): string | null => {
    const [o, t] = s.ops[i]!;
    const out = applyLineOp(s.lines[i]!, o);
    return out.length === 1 && JSON.stringify(out) === JSON.stringify(applyLineOp(s.lines[i]!, t)) ? out[0]! : null;
  };
  for (let i = 0; i < s.lines.length;) {
    const line = bothMake(i);
    let j = i + 1;
    if (line !== null) while (j < s.lines.length && bothMake(j) === line) j++;
    if (line !== null && copiesInRun(0, i, j, line) && copiesInRun(1, i, j, line)) meaningful = false;
    i = j;
  }
  // A side's deletion of a stretch that ends with the line it starts with can be read one
  // line further along ("", "same", "" with the first two deleted is the last two deleted),
  // and so on while the lines keep matching: whether it is the other side's lines there
  // that it deleted is not known from its text.
  for (const k of [0, 1] as const) {
    const other = k === 0 ? 1 : 0;
    for (let i = 0; i < s.lines.length;) {
      if (s.ops[i]![k].kind !== 'delete') {
        i++;
        continue;
      }
      let j = i;
      while (j < s.lines.length && s.ops[j]![k].kind === 'delete') j++;
      let [lo, hi] = [i, j];
      while (hi < s.lines.length && s.lines[hi] === s.lines[lo]) [lo, hi] = [lo + 1, hi + 1];
      const maxHi = hi;
      [lo, hi] = [i, j];
      while (lo > 0 && s.lines[lo - 1] === s.lines[hi - 1]) [lo, hi] = [lo - 1, hi - 1];
      const minLo = lo;
      if (minLo < i || maxHi > j) {
        for (let l = minLo; l < maxHi; l++) if (s.ops[l]![other].kind !== 'keep') meaningful = false;
        for (let slot = minLo; slot <= maxHi; slot++) if (s.inserts[slot]![other].length > 0) meaningful = false;
      }
      i = j;
    }
  }
  // The same lines inserted by both sides at two different slots are one edit when each side's
  // copy could as well stand at the other's slot: what lies between, as that side leaves it,
  // is made of the same lines ("same", "" inserted before a "same", "" by one side and after it
  // by the other gives one text). The merge takes them once; which was meant is not known.
  const commute = (a: string[], b: string[]) => JSON.stringify([...a, ...b]) === JSON.stringify([...b, ...a]);
  /** What side k holds from slot `from` (its insertion there included when `withFirst`) up to slot `to`. */
  const between = (k: 0 | 1, from: number, to: number, withFirst: boolean) => {
    const out: string[] = [];
    for (let l = from; l < to; l++) {
      if (l > from || withFirst) out.push(...s.inserts[l]![k]);
      out.push(...applyLineOp(s.lines[l]!, s.ops[l]![k]));
    }
    return out;
  };
  for (let i = 0; i < s.inserts.length; i++) {
    for (let j = i + 1; j < s.inserts.length; j++) {
      for (const k of [0, 1] as const) {
        const other = k === 0 ? 1 : 0;
        const block = s.inserts[i]![k];
        if (block.length === 0 || JSON.stringify(block) !== JSON.stringify(s.inserts[j]![other])) continue;
        if (commute(block, between(k, i, j, false)) && commute(block, between(other, i, j, true))) meaningful = false;
      }
    }
  }
  // Lines both sides delete leave no mark in either text, so the gaps on both sides of them
  // are one gap: "G" deleted with "x" inserted after it, against "x" inserted before "G" and
  // "G" deleted, is the same edit (G made x) on both sides, taken once. Lines both insert
  // there are only known to be different edits when each inserts them at the same slots.
  for (let i = 0; i < s.lines.length;) {
    if (!(s.ops[i]![0].kind === 'delete' && s.ops[i]![1].kind === 'delete')) {
      i++;
      continue;
    }
    let j = i;
    while (j < s.lines.length && s.ops[j]![0].kind === 'delete' && s.ops[j]![1].kind === 'delete') j++;
    const slots = s.inserts.slice(i, j + 1);
    const putIn = (k: 0 | 1) => slots.some((g) => g[k].length > 0);
    const alike = slots.every((g) => JSON.stringify(g[0]) === JSON.stringify(g[1]));
    if (putIn(0) && putIn(1) && !alike) meaningful = false;
    i = j;
  }
  const join = (ls: string[]) => joinLines(ls, s.finalNewline);
  const lists = [s.lines, side(0), side(1), expected];
  // With no final newline, a last empty line cannot be told from no line, and deleting the
  // last line takes the line break before it, which belongs to whoever wrote it: the texts
  // would not carry the edits the lists describe.
  if (!s.finalNewline && lists.some((ls) => ls.length > 0 && ls[ls.length - 1] === '')) meaningful = false;
  const lastOps = s.ops[s.lines.length - 1];
  if (!s.finalNewline && lastOps && (lastOps[0].kind === 'delete' || lastOps[1].kind === 'delete')) meaningful = false;
  const ours = join(side(0));
  const theirs = join(side(1));
  // Two sides that end with the same text made the same edit as far as their texts can tell,
  // whatever the lists say each did (one deletes the first of two equal lines and puts a blank
  // line at the top, the other deletes the second and puts one at the end): that text is
  // what both meant.
  if (ours === theirs) return { base: join(s.lines), ours, theirs, meant: side(0) };
  return { base: join(s.lines), ours, theirs, meant: meaningful ? expected : null };
}

/**
 * Merges a scenario and, when the merge is clean and what both sides meant is known, checks it.
 * What was checked: 'lines', 'kept' (with a gap where both inserted lines) or null.
 */
function oracleChecks(s: Parameters<typeof build>[0], prefer: Prefer, exactBase: boolean): 'lines' | 'kept' | null {
  const { base, ours, theirs, meant } = build(s, exactBase);
  const r = merged(base, ours, theirs, prefer, exactBase);
  if (meant === null || r.conflicts.length > 0) return null;
  if (meant.every((p): p is string => typeof p === 'string')) {
    expect(r.text).toBe(joinLines(meant, s.finalNewline));
    return 'lines';
  }
  if (!fits(r.text, meant, s.finalNewline))
    expect.fail(`${JSON.stringify(r.text)} is not the merge meant, ${JSON.stringify(meant)}`);
  return 'kept';
}

/**
 * The words of a scenario's base lines that one side removed while the other kept them in its
 * copy of that line, and that the merge `r` holds outside every conflict. Only words each text
 * holds at most once count, so the keeping side's copy is the one in that line. Such a word is
 * a change of the removing side that the merge must apply, or weigh against the other side's
 * change to the line in a conflict; kept outside a conflict, that change is dropped unseen. Also
 * says whether any word was at stake.
 */
function removedKept(
  s: Parameters<typeof build>[0],
  texts: { base: string; ours: string; theirs: string },
  r: MergeResult,
): { kept: string[]; atStake: boolean } {
  const counts = (text: string) => {
    const c = new Map<string, number>();
    for (const w of text.match(WORD) ?? []) c.set(w, (c.get(w) ?? 0) + 1);
    return c;
  };
  const [b, o, t] = [texts.base, texts.ours, texts.theirs].map(counts);
  // A side that removes a line of text and writes it elsewhere moved it, and a line it edited
  // that the moved line passed reads as a line moved past text: a deletion and an insertion
  // (docs/ARCHITECTURE.md, "A change split in two"). Such a side is not asked about. Blank lines
  // moved are.
  const movesText = (k: 0 | 1) => {
    const removed = new Set<string>();
    const written = new Set<string>();
    s.lines.forEach((l, i) => {
      const op = s.ops[i]![k];
      if (op.kind === 'keep') return;
      removed.add(l);
      for (const x of applyLineOp(l, op)) written.add(x);
    });
    for (const ins of s.inserts) for (const x of ins[k]) written.add(x);
    return [...written].some((x) => x !== '' && removed.has(x));
  };
  const moved = [movesText(0), movesText(1)];
  // Within a stretch a side changed, the merge pairs the side's new lines with its old ones by one
  // reading of their words, and a copy of a line that also holds a word of another line the side
  // changed can be read as that line's ("G", "same" made "same G", "Gx": "same G" is "G" with
  // "same" put before it). The word is then text this side wrote on that other line, so its
  // staying is this side's own edit there, not the other side's deletion undone. Such a copy is
  // not asked about.
  const changedLines = (k: 0 | 1) => {
    const lineOf = new Map<string, Set<number>>();
    s.lines.forEach((l, j) => {
      if (s.ops[j]![k].kind === 'keep') return;
      for (const w of l.match(WORD) ?? []) lineOf.set(w, (lineOf.get(w) ?? new Set()).add(j));
    });
    return lineOf;
  };
  const changed = [changedLines(0), changedLines(1)];
  const readAsOther = (k: 0 | 1, i: number, copy: string[]) =>
    copy.some((l) => (l.match(WORD) ?? []).some((w) => [...(changed[k]!.get(w) ?? [])].some((j) => j !== i)));
  const kept: string[] = [];
  let atStake = false;
  s.lines.forEach((line, i) => {
    for (const w of line.match(WORD) ?? []) {
      if (b!.get(w) !== 1) continue;
      for (const k of [0, 1] as const) {
        const [keeper, remover] = k === 0 ? [o!, t!] : [t!, o!];
        if (moved[k] || keeper.get(w) !== 1 || remover.has(w)) continue;
        const copy = applyLineOp(line, s.ops[i]![k]);
        if (!copy.some((l) => l.match(WORD)?.includes(w) === true) || readAsOther(k, i, copy)) continue;
        atStake = true;
        for (const m of r.text.matchAll(WORD)) {
          if (m[0] !== w) continue;
          if (!r.conflicts.some((c) => m.index >= c.from && m.index < c.to)) kept.push(w);
        }
      }
    }
  });
  return { kept, atStake };
}

describe('merge3 oracle', () => {
  it(
    "a clean merge is the base with both sides' edits applied, each once",
    () => {
      let checked = 0;
      fc.assert(
        fc.property(scenario, fc.constantFrom<Prefer>('ours', 'theirs'), (s, prefer) => {
          if (oracleChecks(s, prefer, false) !== null) checked++;
        }),
        seeded({ numRuns: ORACLE_RUNS }),
      );
      // The shapes are hostile on purpose, so many end in a conflict or are left out; at
      // least a fifth must still be checked, or the property would prove little.
      if (!replaying) expect(checked).toBeGreaterThan(ORACLE_RUNS / 5);
    },
    ORACLE_TIME_LIMIT_MS,
  );

  it(
    'against an exact base, a clean merge keeps different lines both insert in one gap',
    () => {
      const withGap = scenario.chain((s) =>
        fc.record({
          s: fc.constant(s),
          at: fc.integer({ min: 0, max: s.lines.length }),
          ours: fc.array(fc.constantFrom(...LINE_POOL), { minLength: 1, maxLength: 2 }),
          theirs: fc.array(fc.constantFrom(...LINE_POOL), { minLength: 1, maxLength: 2 }),
        }),
      );
      let checked = 0;
      fc.assert(
        fc.property(withGap, fc.constantFrom<Prefer>('ours', 'theirs'), ({ s, at, ours, theirs }, prefer) => {
          const inserts = s.inserts.map((pair, i): [string[], string[]] => (i === at ? [ours, theirs] : pair));
          if (oracleChecks({ ...s, inserts }, prefer, true) === 'kept') checked++;
        }),
        seeded({ numRuns: ORACLE_RUNS }),
      );
      // Most gaps sit beside a repeated or changed line, where their place is not certain; at
      // least a twentieth must still be checked.
      if (!replaying) expect(checked).toBeGreaterThan(ORACLE_RUNS / 20);
    },
    // A run here merges and checks a gap more, about twice the work.
    2 * ORACLE_TIME_LIMIT_MS,
  );

  it(
    'keeps every word and line the base and both sides each hold once, under either preference',
    () => {
      // It holds whatever each side meant, so scenarios whose meaning is not known count too. A
      // side that removes a line or word at one place and writes it at another is one change,
      // which a conflict at either place must not split.
      let atStake = 0;
      fc.assert(
        fc.property(scenario, fc.constantFrom<Prefer>('ours', 'theirs'), fc.boolean(), (s, prefer, exactBase) => {
          const { base, ours, theirs } = build(s, exactBase);
          const r = merge3(base, ours, theirs, { prefer, exactBase });
          expect(missingOnce(base, ours, theirs, r.text)).toEqual([]);
          if (r.conflicts.length > 0 && missingOnce(base, ours, theirs, '').length > 0) atStake++;
        }),
        seeded({ numRuns: ORACLE_RUNS }),
      );
      // About a third of all runs end in a conflict with such text at stake; at least a fifth must.
      if (!replaying) expect(atStake).toBeGreaterThan(ORACLE_RUNS / 5);
    },
    ORACLE_TIME_LIMIT_MS,
  );

  it(
    'keeps no word one side removed from a line the other kept, outside a conflict, either way',
    () => {
      // It holds whatever each side meant, so it asks of every scenario, conflicts and all: an
      // edited line read as written beside its old self (a blank line moved past it) must not
      // keep, outside a conflict, the words the other side deleted from that line.
      let atStake = 0;
      const shapes = fc.oneof(scenario, blankMoved);
      fc.assert(
        fc.property(shapes, fc.constantFrom<Prefer>('ours', 'theirs'), fc.boolean(), (s, prefer, exactBase) => {
          const texts = build(s, exactBase);
          const r = merge3(texts.base, texts.ours, texts.theirs, { prefer, exactBase });
          const found = removedKept(s, texts, r);
          expect(found.kept).toEqual([]);
          if (found.atStake) atStake++;
        }),
        seeded({ numRuns: ORACLE_RUNS }),
      );
      // About a sixth of all runs have such a word at stake; at least a tenth must.
      if (!replaying) expect(atStake).toBeGreaterThan(ORACLE_RUNS / 10);
    },
    ORACLE_TIME_LIMIT_MS,
  );
});

// ---------------------------------------------------------------------------
// Properties

describe('merge3 properties', () => {
  it('never conflicts on changes to different lines, and applies both', () => {
    // Each line belongs to nobody, us or them; its owner edits it (at its end, its start, a
    // word, or wholly), deletes it, or puts a new line before it. Base lines are distinct,
    // to the end (each carries its number at both ends), so every change has one place to
    // go; repeated content, where it may not, has its own properties below. Left out,
    // because it conflicts on purpose: in a text with no final newline, deleting the last
    // lines while the other side deletes the line before them (both remove the same line
    // break), or deletes one of the lines it rewrites just before them ("line3\nline4" made
    // "rewritten 4" is line3 deleted or line4 deleted: in the second reading both sides
    // again remove the same line break).
    type Op = 'suffix' | 'prefix' | 'word' | 'rewrite' | 'delete' | 'before';
    const ops: Op[] = ['suffix', 'prefix', 'word', 'rewrite', 'delete', 'before'];
    const scenario = fc.integer({ min: 1, max: 30 }).chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.array(fc.constantFrom('', ' alpha', ' beta gamma', ' a longer line of prose. With two sentences.'), {
          minLength: n,
          maxLength: n,
        }),
        fc.array(fc.constantFrom(0, 0, 1, 2), { minLength: n, maxLength: n }),
        fc.array(fc.constantFrom(...ops), { minLength: n, maxLength: n }),
        fc.boolean(),
      ),
    );
    fc.assert(
      fc.property(scenario, ([n, tails, owner, op, finalNewline]) => {
        if (!finalNewline) {
          let j = n;
          while (j > 0 && op[j - 1] === 'delete' && owner[j - 1] && owner[j - 1] === owner[n - 1]) j--;
          if (j < n) {
            let deletes = false;
            // (A word edit of a line that is one word rewrites it whole.)
            const rewrites = (k: number) => op[k] === 'rewrite' || (op[k] === 'word' && !tails[k]);
            for (
              let k = j;
              k > 0 && owner[k - 1] && owner[k - 1] !== owner[n - 1] && (op[k - 1] === 'delete' || rewrites(k - 1));
              k--
            ) {
              if (op[k - 1] === 'delete') deletes = true;
            }
            if (deletes) return;
          }
        }
        const lines = Array.from({ length: n }, (_, i) => `line${i}${tails[i]}${tails[i] ? ` end${i}` : ''}`);
        const change = (l: string, i: number, tag: string): string[] => {
          switch (op[i]!) {
            case 'suffix':
              return [`${l} edited by ${tag} ${i}`];
            case 'prefix':
              return [`${tag}${i} ${l}`];
            case 'word':
              return [l.replace(/^line\d+/, `${tag}${i}`)];
            case 'rewrite':
              return [`rewritten ${i} by ${tag}`];
            case 'delete':
              return [];
            case 'before':
              return [`new line from ${tag} ${i}`, l];
          }
        };
        const side = (who: number, tag: string) =>
          lines.flatMap((l, i) => (owner[i] === who ? change(l, i, tag) : [l]));
        const expected = lines.flatMap((l, i) =>
          owner[i] === 1 ? change(l, i, 'us') : owner[i] === 2 ? change(l, i, 'them') : [l],
        );
        const join = (ls: string[]) => ls.join('\n') + (finalNewline && ls.length > 0 ? '\n' : '');
        expect(merged(join(lines), join(side(1, 'us')), join(side(2, 'them')))).toEqual(clean(join(expected)));
      }),
      seeded({ numRuns: 500 }),
    );
  });

  it('conflicts when one side empties or rewrites a whole line and the other adds to it', () => {
    // Both changed one line, one of them all its text (emptied, or rewritten with none of its
    // words kept): there is no merge both meant. Base lines are distinct; lines away from that
    // one are edited by one side or the other.
    const scenario = fc.integer({ min: 1, max: 8 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        at: fc.integer({ min: 0, max: n - 1 }),
        rewrite: fc.constantFrom('', 'Q', 'other text'),
        where: fc.constantFrom('start', 'middle', 'end'),
        added: fc.constantFrom('new', 'b', 'x y'),
        owner: fc.array(fc.constantFrom(0, 0, 1, 2), { minLength: n, maxLength: n }),
        finalNewline: fc.boolean(),
        oursRewrites: fc.boolean(),
        exactBase: fc.boolean(),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ n, at, rewrite, where, added, owner, finalNewline, oursRewrites, exactBase }) => {
        // With no final line break an emptied last line cannot be told from no line.
        if (!finalNewline && at === n - 1 && rewrite === '') return;
        const lines = Array.from({ length: n }, (_, i) => `line${i} has words ${i}`);
        const words = lines[at]!.split(' ');
        const addedTo =
          where === 'start'
            ? `${added} ${lines[at]}`
            : where === 'end'
              ? `${lines[at]} ${added}`
              : [...words.slice(0, 2), added, ...words.slice(2)].join(' ');
        const side = (who: number, line: string) =>
          joinLines(
            lines.map((l, i) => (i === at ? line : owner[i] === who && Math.abs(i - at) > 1 ? `${l} edited` : l)),
            finalNewline,
          );
        const [ours, theirs] = oursRewrites
          ? [side(1, rewrite), side(2, addedTo)]
          : [side(1, addedTo), side(2, rewrite)];
        const base = joinLines(lines, finalNewline);
        expect(merged(base, ours, theirs, 'ours', exactBase).conflicts.length).toBeGreaterThan(0);
        expect(merged(base, ours, theirs, 'theirs', exactBase).conflicts.length).toBeGreaterThan(0);
      }),
      seeded({ numRuns: 500 }),
    );
  });

  it('conflicts on text added at a word the other side replaces, folded with the next edit', () => {
    // One side replaces the last word of a line (or the first); the other adds text right
    // after it (before it) and also edits the first word of the next line (the last of the
    // previous), so its two edits are one change with only a line break between. The added
    // text was written against a word the other side replaced: it has no place both meant.
    const scenario = fc.integer({ min: 2, max: 6 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        at: fc.integer({ min: 0, max: n - 2 }),
        after: fc.boolean(),
        replacedBy: fc.constantFrom('Q', 'other text'),
        finalNewline: fc.boolean(),
        oursReplaces: fc.boolean(),
        exactBase: fc.boolean(),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ n, at, after, replacedBy, finalNewline, oursReplaces, exactBase }) => {
        const lines = Array.from({ length: n }, (_, i) => [`a${i}`, `b${i}`, `c${i}`]);
        // After: the last word of line `at`, and the first of the next. Before: the first word
        // of the next line, and the last of line `at`.
        const [target, near]: [[number, number], [number, number]] = after
          ? [
              [at, 2],
              [at + 1, 0],
            ]
          : [
              [at + 1, 0],
              [at, 2],
            ];
        const replaced = lines.map((ws) => [...ws]);
        replaced[target[0]]![target[1]] = replacedBy;
        const added = lines.map((ws) => [...ws]);
        const word = lines[target[0]]![target[1]]!;
        added[target[0]]![target[1]] = after ? `${word} more` : `more ${word}`;
        added[near[0]]![near[1]] = 'Z';
        const text = (ls: string[][]) =>
          joinLines(
            ls.map((ws) => ws.join(' ')),
            finalNewline,
          );
        const [ours, theirs] = oursReplaces ? [text(replaced), text(added)] : [text(added), text(replaced)];
        const base = text(lines);
        expect(merged(base, ours, theirs, 'ours', exactBase).conflicts.length).toBeGreaterThan(0);
        expect(merged(base, ours, theirs, 'theirs', exactBase).conflicts.length).toBeGreaterThan(0);
      }),
      seeded({ numRuns: 500 }),
    );
  });

  it('never conflicts on edits to different words of one long line, and applies both', () => {
    const scenario = fc
      .integer({ min: 2, max: 200 })
      .chain((n) => fc.tuple(fc.constant(n), fc.array(fc.constantFrom(0, 0, 0, 1, 2), { minLength: n, maxLength: n })));
    fc.assert(
      fc.property(scenario, ([n, owner]) => {
        // A paragraph on one line: words, commas and periods, as prose is written.
        const words = Array.from({ length: n }, (_, i) => `w${i}`);
        const join = (ws: string[]) =>
          'Intro: ' + ws.map((w, i) => (i % 9 === 8 ? `${w}.` : i % 4 === 3 ? `${w},` : w)).join(' ') + '\nAfter.\n';
        const ours = words.map((w, i) => (owner[i] === 1 ? `ours${i}` : w));
        const theirs = words.map((w, i) => (owner[i] === 2 ? `theirs${i}` : w));
        const expected = words.map((w, i) => (owner[i] === 1 ? ours[i]! : owner[i] === 2 ? theirs[i]! : w));
        expect(merged(join(words), join(ours), join(theirs))).toEqual(clean(join(expected)));
      }),
      seeded({ numRuns: 400 }),
    );
  });

  it('stays consistent for random edits of realistic markdown on both sides', () => {
    const word = fc.constantFrom('the', 'note', 'and', '[[Page]]', '**bold**', 'émigré', '東京', '👍🏽', '|', '-');
    const line = fc.oneof(
      fc.array(word, { minLength: 1, maxLength: 30 }).map((w) => w.join(' ')),
      fc.constant(''),
      fc.constantFrom('# Heading', '- item', '| a | b |', '| --- | --- |', '```'),
    );
    const doc = fc.array(line, { maxLength: 25 }).map((ls) => ls.join('\n'));
    const edits = fc.array(
      fc.record({
        at: fc.double({ min: 0, max: 1, noNaN: true }),
        remove: fc.integer({ min: 0, max: 20 }),
        insert: fc.oneof(fc.constant(''), word, fc.constantFrom('\n', ' new words ', 'X')),
      }),
      { maxLength: 5 },
    );
    const apply = (text: string, es: { at: number; remove: number; insert: string }[]) => {
      for (const e of es) {
        const at = Math.floor(e.at * text.length);
        text = text.slice(0, at) + e.insert + text.slice(Math.min(text.length, at + e.remove));
      }
      return text;
    };
    fc.assert(
      fc.property(doc, edits, edits, fc.constantFrom<Prefer>('ours', 'theirs'), (base, eo, et, prefer) => {
        const ours = apply(base, eo);
        const theirs = apply(base, et);
        merged(base, ours, theirs, prefer);
      }),
      seeded({ numRuns: 400 }),
    );
  });
});
