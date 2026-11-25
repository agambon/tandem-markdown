// The check on a merge's result: a merge that repeats text neither side repeats is not used.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { merge3, merge3Detailed } from '../../src/core/merge3';
import { repeatsText, safeMerge } from '../../src/core/safeMerge';
import { replaying, seeded } from '../random';

/** A stretch a side's changes brought in, where it first stands in that side's text. */
const stretch = (side: string, text: string) => ({ text, at: side.indexOf(text) });

describe('safeMerge', () => {
  it('passes an ordinary merge through', () => {
    const r = safeMerge('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n', 'ours');
    expect(r).toEqual({ text: 'a\nB\nC\n', conflicts: [] });
  });

  it('keeps the preferred side whole, as one conflict, when a merge repeats text neither side does', () => {
    // Both sides added the same line in different places: the merge holds it twice, and the
    // check refuses it.
    const base = 'one\ntwo\nthree\nfour\n';
    const ours = 'the same added line\none\ntwo\nthree\nfour\n';
    const theirs = 'one\ntwo\nthree\nfour\nthe same added line\n';
    const r = safeMerge(base, ours, theirs, 'ours');
    expect(r.text).toBe(ours);
    expect(r.conflicts).toEqual([{ from: 0, to: ours.length, ours, theirs, base }]);
    expect(safeMerge(base, ours, theirs, 'theirs').text).toBe(theirs);
  });

  it('refuses a sentence both sides added inside different lines', () => {
    const base = 'The north wall leans.\nThe sill is soft.\nQuotes from two framers.\n';
    const ours = 'The north wall leans. Call the framer on Friday.\nThe sill is soft.\nQuotes from two framers.\n';
    const theirs = 'The north wall leans.\nThe sill is soft.\nQuotes from two framers. Call the framer on Friday.\n';
    expect(safeMerge(base, ours, theirs, 'ours')).toEqual({
      text: ours,
      conflicts: [{ from: 0, to: ours.length, ours, theirs, base }],
    });
  });

  // Each side's own lines meet the note's text in the same three words (". Done. Next"), at
  // different places: no text is repeated, so it merges.
  it("merges two sides' additions that meet the note's text in the same words", () => {
    const base = 'Next: order the posts.\nThe sill is soft near the door.\nDone.\n';
    const ours = `${base}Next: call the framer.\n`;
    const theirs = `Monday: measured the north wall.\nDone.\n${base}`;
    expect(safeMerge(base, ours, theirs, 'ours')).toEqual({
      text: `Monday: measured the north wall.\nDone.\n${base}Next: call the framer.\n`,
      conflicts: [],
    });
  });

  // The user types at the top while a program appends lines: the note took one line back in from
  // a version a save wrote over, the program appended another. Each side gains one more ". Outside
  // line" run between lines of one shape, and nothing is repeated: it merges.
  it('merges lines of one shape that each side added at a different place', () => {
    const base = 'Notes on the barn.\nOutside line 1.\nOutside line 3.\n';
    const ours = 'Notes on the barn, typed.\nOutside line 1.\nOutside line 2.\nOutside line 3.\n';
    const theirs = 'Notes on the barn.\nOutside line 1.\nOutside line 3.\nOutside line 4.\n';
    expect(safeMerge(base, ours, theirs, 'ours')).toEqual({
      text: 'Notes on the barn, typed.\nOutside line 1.\nOutside line 2.\nOutside line 3.\nOutside line 4.\n',
      conflicts: [],
    });
  });

  it('merges a rule both sides added at different places', () => {
    const r = safeMerge('Plans.\nBudget.\n', 'Plans.\n* * *\nBudget.\n', 'Plans.\nBudget.\n* * *\n', 'ours');
    expect(r).toEqual({ text: 'Plans.\n* * *\nBudget.\n* * *\n', conflicts: [] });
  });

  // A run of three tokens lies within a line: ") gamma (" across the end of theirs's first line
  // and the start of its second is no phrase ours also wrote.
  it('merges additions that share three tokens only across a line break', () => {
    const base = 'Notes.\nEnd.\n';
    const ours = 'Notes (a) gamma (b) here.\nEnd.\n';
    const theirs = 'Notes.\nEnd.\nx (c) gamma\n(d) y\n';
    expect(safeMerge(base, ours, theirs, 'ours')).toEqual({
      text: 'Notes (a) gamma (b) here.\nEnd.\nx (c) gamma\n(d) y\n',
      conflicts: [],
    });
  });

  // Two copies of one line, each brought in by one side's changes: between the same lines, they
  // are one line both sides held that the base lacks, written twice; between different lines, the
  // same line added at two places.
  it('refuses a line written once from each side only where both copies stand between the same lines', () => {
    const base = 'top\nmid\nend\n';
    const ours = 'top\n* * *\nmid\nend\n';
    const theirs = 'top\n* * *\nmid\nend\n';
    const twice = 'top\n* * *\n* * *\nmid\nend\n';
    const atOnePlace = { ours: [stretch(ours, '* * *\n')], theirs: [stretch(theirs, '* * *\n')] };
    expect(repeatsText(base, ours, theirs, { text: twice, bothInserted: [], brought: atOnePlace })).toBe(true);
    const elsewhere = 'top\nmid\n* * *\nend\n';
    const atTwo = { ours: [stretch(ours, '* * *\n')], theirs: [stretch(elsewhere, '* * *\n')] };
    const merged = 'top\n* * *\nmid\n* * *\nend\n';
    expect(repeatsText(base, ours, elsewhere, { text: merged, bothInserted: [], brought: atTwo })).toBe(false);
  });

  // One line both sides held, each side's copy edited: a base older than both lacks it, and the
  // merge writes both copies. Against an exact base they are two additions.
  it('refuses two edited copies of one line, one from each side, unless the base is exact', () => {
    const base = 'top\nend\n';
    const ours = 'top\nthe line both held, edited here\nend\n';
    const theirs = 'top\nthe line both held, edited there\nend\n';
    const merged = 'top\nthe line both held, edited here\nthe line both held, edited there\nend\n';
    const brought = {
      ours: [stretch(ours, 'the line both held, edited here\n')],
      theirs: [stretch(theirs, 'the line both held, edited there\n')],
    };
    expect(repeatsText(base, ours, theirs, { text: merged, bothInserted: [], brought })).toBe(true);
    expect(repeatsText(base, ours, theirs, { text: merged, bothInserted: [], brought }, true)).toBe(false);
  });

  it('never leaves a line more often than each side and than both sides give it together', () => {
    const word = fc.constantFrom('the', 'north', 'wall', 'leans', 'see', 'note', '(1)', '(2)', '-', '- [ ]', '##');
    const line = fc.array(word, { minLength: 1, maxLength: 4 }).map((ws) => ws.join(' '));
    const note = fc.array(line, { minLength: 1, maxLength: 6 });
    const edit = fc.record({ at: fc.nat(6), remove: fc.nat(2), insert: fc.array(line, { maxLength: 2 }) });
    const apply = (lines: string[], es: { at: number; remove: number; insert: string[] }[]) => {
      const out = [...lines];
      for (const e of es) out.splice(Math.min(e.at, out.length), e.remove, ...e.insert);
      return out.map((l) => l + '\n').join('');
    };
    const counts = (s: string) => {
      const c = new Map<string, number>();
      for (const l of s.split('\n')) if (l.trim() !== '') c.set(l, (c.get(l) ?? 0) + 1);
      return c;
    };
    fc.assert(
      fc.property(
        note,
        fc.array(edit, { maxLength: 3 }),
        fc.array(edit, { maxLength: 3 }),
        fc.boolean(),
        (ls, eo, et, exactBase) => {
          const base = apply(ls, []);
          const ours = apply(ls, eo);
          const theirs = apply(ls, et);
          const { text } = safeMerge(base, ours, theirs, 'ours', undefined, { exactBase });
          const [b, o, t] = [counts(base), counts(ours), counts(theirs)];
          for (const [l, n] of counts(text)) {
            // A line neither side holds is made where the two sides' changes meet, and repeats nothing.
            const no = o.get(l) ?? 0;
            const nt = t.get(l) ?? 0;
            expect(no + nt === 0 || n <= Math.max(no, nt) || n <= no + nt - (b.get(l) ?? 0)).toBe(true);
          }
        },
      ),
      seeded({ numRuns: 3000 }),
    );
  });

  it('refuses a merge of 2 MB texts in which both sides added the same line in different places', () => {
    const lines = Array.from({ length: 42_000 }, (_, i) => `Line ${i} of a long note, with some words in it.`);
    const base = lines.join('\n') + '\n';
    const added = 'the same line, added by both\n';
    const at = (n: number) => lines.slice(0, n).join('\n').length + 1;
    const ours = base.slice(0, at(100)) + added + base.slice(at(100));
    const theirs = base.slice(0, at(41_000)) + added + base.slice(at(41_000));
    expect(base.length).toBeGreaterThan(2_000_000);
    const r = safeMerge(base, ours, theirs, 'ours');
    expect(r.text).toBe(ours);
    expect(r.conflicts).toEqual([{ from: 0, to: ours.length, ours, theirs, base }]);
    // Different lines added in the same two places merge.
    const theirsOwn = base.slice(0, at(41_000)) + 'a line only they added\n' + base.slice(at(41_000));
    expect(safeMerge(base, ours, theirsOwn, 'ours').conflicts).toEqual([]);
  });
});

describe('safeMerge with lines both sides insert at one place', () => {
  const exact = { exactBase: true };

  it('passes lines kept together that begin with the same words', () => {
    const base = '- [ ] a\n';
    const ours = '- [ ] a\n- [ ] buy milk\n';
    const theirs = '- [ ] a\n- [ ] buy eggs\n';
    const merged = '- [ ] a\n- [ ] buy milk\n- [ ] buy eggs\n';
    expect(safeMerge(base, ours, theirs, 'ours', undefined, exact)).toEqual({ text: merged, conflicts: [] });
    expect(safeMerge(base, ours, theirs, 'theirs', undefined, exact)).toEqual({ text: merged, conflicts: [] });
    // Without an exact base the place is a conflict, and the preferred side is kept.
    expect(safeMerge(base, ours, theirs, 'ours')).toEqual({
      text: ours,
      conflicts: [{ from: 8, to: 23, ours: '- [ ] buy milk\n', theirs: '- [ ] buy eggs\n', base: '' }],
    });
    // Two task lines that share only their marker and a word are no text repeated: markup is
    // no part of a run (runTokens).
    const brought = { ours: [stretch(ours, '- [ ] buy milk\n')], theirs: [stretch(theirs, '- [ ] buy eggs\n')] };
    expect(repeatsText(base, ours, theirs, { text: merged, bothInserted: [], brought })).toBe(false);
    // Lines that share three words, counted without knowing they were kept together, look
    // repeated; kept together, they are not.
    const o = '- [ ] a\n- [ ] buy the milk today\n';
    const t = '- [ ] a\n- [ ] buy the milk later\n';
    const both = '- [ ] a\n- [ ] buy the milk today\n- [ ] buy the milk later\n';
    const sides = {
      ours: [stretch(o, '- [ ] buy the milk today\n')],
      theirs: [stretch(t, '- [ ] buy the milk later\n')],
    };
    expect(repeatsText(base, o, t, { text: both, bothInserted: [], brought: sides })).toBe(true);
    const kept = { from: 8, to: both.length, ours: '- [ ] buy the milk today\n', theirs: '- [ ] buy the milk later\n' };
    expect(repeatsText(base, o, t, { text: both, bothInserted: [kept], brought: sides })).toBe(false);
  });

  // Against the text both sides started from, the line each added is that side's own addition.
  it("merges a line both sides added against an exact base, beside the other side's line and elsewhere", () => {
    const base = 'one\ntwo\n';
    const ours = 'the same added line\none\nmy own line\ntwo\n';
    const theirs = 'one\nthe same added line\ntwo\n';
    const merged = { text: 'the same added line\none\nmy own line\nthe same added line\ntwo\n', conflicts: [] };
    expect(merge3(base, ours, theirs, exact)).toEqual(merged);
    expect(safeMerge(base, ours, theirs, 'ours', undefined, exact)).toEqual(merged);
  });

  it('counts no line of spaces as text repeated, in lines kept together or elsewhere', () => {
    const base = 'top\n';
    const ours = 'top\n- milk\n  \n';
    const theirs = 'top\n- bread\n  \n';
    const merged = 'top\n- milk\n  \n- bread\n  \n';
    const kept = { from: 4, to: merged.length, ours: '- milk\n  \n', theirs: '- bread\n  \n' };
    const brought = { ours: [stretch(ours, kept.ours)], theirs: [stretch(theirs, kept.theirs)] };
    expect(repeatsText(base, ours, theirs, { text: merged, bothInserted: [kept], brought })).toBe(false);
    expect(repeatsText(base, ours, theirs, { text: merged, bothInserted: [], brought })).toBe(false);
  });

  it('finds a repeat inside lines kept together that one side has once', () => {
    const base = 'top\n';
    const ours = 'top\nthe line ours added\n';
    const theirs = 'top\na line they added\n';
    const merged = 'top\nthe line ours added\nthe line ours added\na line they added\n';
    const kept = { from: 4, to: merged.length, ours: 'the line ours added\n', theirs: 'a line they added\n' };
    const brought = { ours: [stretch(ours, kept.ours)], theirs: [stretch(theirs, kept.theirs)] };
    expect(repeatsText(base, ours, theirs, { text: merged, bothInserted: [kept], brought })).toBe(true);
  });

  it('reports what each side brought in, lines kept together on both sides', () => {
    const m = merge3Detailed('a\nb\n', 'a\nmine\nb\nB2\n', 'a\ntheirs\nb\n', exact);
    expect(m.text).toBe('a\nmine\ntheirs\nb\nB2\n');
    expect(m.brought).toEqual({
      ours: [
        { text: 'mine\n', at: 2 },
        { text: 'B2\n', at: 9 },
      ],
      theirs: [{ text: 'theirs\n', at: 2 }],
    });
  });

  it("passes any merge that keeps both sides' lines at one place, whatever words they share", () => {
    const item = fc
      .tuple(
        fc.constantFrom('- [ ] ', '- ', '', '## '),
        fc.constantFrom('buy', 'call', 'the'),
        fc.constantFrom('milk', 'eggs', 'mom'),
      )
      .map(([mark, verb, thing]) => `${mark}${verb} ${thing}`);
    const insertion = fc.array(fc.oneof(item, fc.constant('')), { minLength: 1, maxLength: 4 });
    const scenario = fc.integer({ min: 1, max: 8 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        at: fc.integer({ min: 0, max: n }),
        ours: insertion,
        theirs: insertion,
        prefer: fc.constantFrom<'ours' | 'theirs'>('ours', 'theirs'),
      }),
    );
    let kept = 0;
    fc.assert(
      fc.property(scenario, ({ n, at, ours, theirs, prefer }) => {
        const lines = Array.from({ length: n }, (_, i) => `- [ ] task ${i} of the list`);
        const join = (ls: string[]) => ls.map((l) => l + '\n').join('');
        const withLines = (inserted: string[]) => join([...lines.slice(0, at), ...inserted, ...lines.slice(at)]);
        const base = join(lines);
        const m = merge3(base, withLines(ours), withLines(theirs), { prefer, exactBase: true });
        // (A line holding another's words, "buy milk" and "- buy milk", may be one line edited,
        // and stays a conflict in the merge itself.)
        if (m.conflicts.length === 0) kept++;
        expect(safeMerge(base, withLines(ours), withLines(theirs), prefer, undefined, exact)).toEqual(m);
      }),
      seeded({ numRuns: 1000 }),
    );
    if (!replaying) expect(kept).toBeGreaterThan(500);
  });
});
