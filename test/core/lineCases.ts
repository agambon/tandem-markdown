// Lines that each carry a token found nowhere else, and whole-line insertions, deletions and
// replacements of them; a replacing line may keep the token of the line it replaces. Tokens are
// numbered on from the old lines' into the new ones, so a new token often begins or ends like an
// old one (⟦1⟧ and ⟦10⟧, ⟦2⟧ and ⟦12⟧). Both texts end in a line break, or neither does.
import fc from 'fast-check';

type LineSpec = [string, string, number];

interface LineOp {
  at: number;
  remove: number;
  add: LineSpec[];
  keepToken: boolean;
}

const lineWord = fc.constantFrom('alpha', 'beta', 'fox', 'golf', 'kilo', 'lima');
const lineSpec = fc.tuple(lineWord, lineWord, fc.nat({ max: 3 }));
const lineOp = fc.record({
  at: fc.nat(),
  remove: fc.nat({ max: 3 }),
  add: fc.array(lineSpec, { maxLength: 3 }),
  keepToken: fc.boolean(),
});

/** Old lines and the operations on them. */
export const lineCase = fc.record({
  old: fc.array(lineSpec, { minLength: 1, maxLength: 10 }),
  ops: fc.array(lineOp, { minLength: 1, maxLength: 4 }),
});

function lineOf([w1, w2, shape]: LineSpec, token: string): string {
  return [`${w1} ${token} ${w2}`, `${token} ${w1}`, `${w1} ${w2} ${token}`, `${w1} ${token} `][shape]!;
}

export interface LineCase {
  a: string;
  b: string;
  /** Old offsets [from, to] that the operations may change. */
  spans: [number, number][];
  /** The tokens of the lines no operation touched. */
  untouched: string[];
  /** The tokens of replaced lines that a replacing line kept. */
  kept: string[];
}

const tokenOf = (line: string) => line.match(/⟦\d+⟧/)![0];

/** The two texts of a case, with every line ending in a line break when `finalBreak`, else all but the last. */
export function buildLines(c: { old: LineSpec[]; ops: LineOp[] }, finalBreak: boolean): LineCase {
  let n = 0;
  const oldLines = c.old.map((s) => lineOf(s, `⟦${++n}⟧`));
  const join = (lines: string[]) => (finalBreak ? lines.map((l) => l + '\n').join('') : lines.join('\n'));
  const starts: number[] = [];
  let offset = 0;
  for (const l of oldLines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const a = join(oldLines);
  starts.push(offset);
  const ops = c.ops
    .map((o) => ({ ...o, at: o.at % (oldLines.length + 1) }))
    .filter((o) => o.remove > 0 || o.add.length > 0)
    .sort((x, y) => x.at - y.at);
  const newLines: string[] = [];
  const touched = new Set<number>();
  const spans: [number, number][] = [];
  const kept: string[] = [];
  let cursor = 0;
  for (const o of ops) {
    const start = Math.max(cursor, o.at);
    const end = Math.min(oldLines.length, start + o.remove);
    const keep = o.keepToken && end > start && o.add.length > 0 ? tokenOf(oldLines[start]!) : null;
    if (keep) kept.push(keep);
    const added = o.add.map((s, k) => lineOf(s, k === 0 && keep ? keep : `⟦${++n}⟧`));
    newLines.push(...oldLines.slice(cursor, start), ...added);
    for (let i = start; i < end; i++) touched.add(i);
    // One character of slack before: a line break may go with either of the lines it separates.
    // With no final line break, the last line's span ends at the end of the text.
    const from = Math.max(0, starts[start]! - 1);
    const to = Math.min(a.length, starts[end]!);
    const last = spans[spans.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else spans.push([from, to]);
    cursor = end;
  }
  newLines.push(...oldLines.slice(cursor));
  const untouched = oldLines.filter((_, i) => !touched.has(i)).map(tokenOf);
  return { a, b: join(newLines), spans, untouched, kept };
}
