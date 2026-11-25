// The table model. Parsing must find the cells the panel's parser finds; writing must give
// back the same table.
import { GFM, parser as baseParser } from '@lezer/markdown';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type TableData,
  cellFromInput,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseTable,
  setAlign,
  toData,
  tsvToTable,
  writeTable,
} from '../../src/core/tableModel';
import { replaying, seeded } from '../random';

const gfm = baseParser.configure(GFM);

describe('parseTable', () => {
  it('reads header, alignment and rows', () => {
    const src = '| Name | Qty | Note |\n| :--- | ---: | :---: |\n| apple | 3 | red |\n| pear | 10 | green |';
    const t = parseTable(src)!;
    expect(toData(t)).toEqual({
      header: ['Name', 'Qty', 'Note'],
      align: ['left', 'right', 'center'],
      rows: [
        ['apple', '3', 'red'],
        ['pear', '10', 'green'],
      ],
    });
    for (const cell of [...t.header, ...t.rows.flat()]) expect(src.slice(cell.from, cell.to)).toBe(cell.text);
  });

  it('takes leading and trailing pipes as optional', () => {
    expect(toData(parseTable('a | b\n--- | ---\n1 | 2')!)).toEqual({
      header: ['a', 'b'],
      align: ['none', 'none'],
      rows: [['1', '2']],
    });
    expect(toData(parseTable('| a | b\n|---|---\n| 1 | 2')!).rows).toEqual([['1', '2']]);
    expect(toData(parseTable('a | b |\n---|---|\n1 | 2 |\n')!).rows).toEqual([['1', '2']]);
  });

  it('keeps an escaped pipe in its cell, and splits on a pipe inside code', () => {
    const t = toData(parseTable('| a | b |\n|---|---|\n| x \\| y | z |\n| `p|q` | r |')!);
    expect(t.rows[0]).toEqual(['x \\| y', 'z']);
    expect(t.rows[1]).toEqual(['`p', 'q`']); // GFM: the pipe inside the code span still divides; the rest is cut
  });

  it('pads short rows and cuts long ones', () => {
    const src = '| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |';
    const t = parseTable(src)!;
    expect(toData(t).rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
    const line3End = src.indexOf('\n', src.indexOf('| 1 |'));
    expect(t.rows[0]![1]).toEqual({ text: '', from: line3End, to: line3End });
  });

  it('places an empty cell zero-length one space in from its opening pipe', () => {
    const src = '| a |  | c |\n|---|---|---|\n|| x | |';
    const t = parseTable(src)!;
    const empty = t.header[1]!;
    expect(empty.from).toBe(empty.to);
    expect(src.slice(0, empty.from) + 'X' + src.slice(empty.to)).toBe('| a | X | c |\n|---|---|---|\n|| x | |');
    const row = t.rows[0]!;
    expect(row.map((c) => c.text)).toEqual(['', 'x', '']);
    expect(row[0]!.from).toBe(src.lastIndexOf('||') + 1);
    expect(src.slice(row[2]!.from)).toBe('|'); // "| |": after the one space, at the closing pipe
  });

  it('puts a missing cell, and only a missing cell, at the end of its line', () => {
    const src = '| a | b | c |\n|---|---|---|\n| 1 |  |\n| x | | z |';
    const t = parseTable(src)!;
    const atLineEnd = (pos: number) => pos === src.length || src[pos] === '\n';
    const flags = t.rows.map((r) => r.map((c) => c.from === c.to && atLineEnd(c.from)));
    expect(flags).toEqual([
      [false, false, true],
      [false, false, false],
    ]);
  });

  it('refuses what is not a table', () => {
    expect(parseTable('')).toBeNull();
    expect(parseTable('| a | b |')).toBeNull();
    expect(parseTable('a\n---')).toBeNull(); // no pipe in the header: a Setext heading
    expect(parseTable('| a | b |\n| --- |')).toBeNull(); // cell counts differ
    expect(parseTable('| a |\n| :: |')).toBeNull(); // a delimiter cell needs a dash
    expect(parseTable('a \\| b\n---|')).toBeNull(); // the header's only pipe is escaped
    expect(parseTable('| a |\n|---|\n| 1 |\n\n| 2 |')).toBeNull(); // a blank line ends a table
  });

  it('finds the same cells as the panel parser (@lezer/markdown with GFM)', () => {
    const cell = fc.constantFrom(
      '',
      'a',
      'b c',
      '`x`',
      '\\|',
      'x\\|y',
      '**b**',
      '`p|q`',
      ' ',
      '\\\\',
      'a\\ ',
      'é',
      '東京',
    );
    const row = (min: number, max: number) =>
      fc
        .array(cell, { minLength: min, maxLength: max })
        .chain((cells) =>
          fc
            .tuple(fc.boolean(), fc.boolean())
            .map(([lead, trail]) => (lead ? '| ' : '') + cells.join(' | ') + (trail ? ' |' : '')),
        );
    const source = fc
      .integer({ min: 1, max: 4 })
      .chain((cols) => fc.tuple(row(cols, cols), fc.array(row(1, 5), { maxLength: 4 }), fc.constant(cols)));
    let compared = 0;
    fc.assert(
      fc.property(source, ([header, body, cols]) => {
        const delimiter = '|' + Array.from({ length: cols }, () => ' --- |').join('');
        const src = [header, delimiter, ...body].join('\n');
        // The panel hands the table model the text of the parser's Table node.
        const tree = gfm.parse(src);
        let table: { from: number; to: number } | null = null;
        const lezerRows: string[][] = [];
        tree.iterate({
          enter(node) {
            if (node.name === 'Table' && !table) table = { from: node.from, to: node.to };
            if (node.name === 'TableHeader' || node.name === 'TableRow') lezerRows.push([]);
            if (node.name === 'TableCell') lezerRows[lezerRows.length - 1]!.push(`${node.from}-${node.to}`);
          },
        });
        if (!table) {
          expect(parseTable(src)).toBeNull(); // not a table to the panel, nor to us
          return;
        }
        const { from, to } = table as { from: number; to: number };
        const ours = parseTable(src.slice(from, to));
        expect(ours).not.toBeNull();
        compared++;
        const ourRows = [ours!.header, ...ours!.rows];
        expect(ourRows.length).toBe(lezerRows.length);
        ourRows.forEach((r, i) => {
          // lezer makes no node for an empty cell, and keeps cells past the header's width,
          // which GFM (and we) cut: so ours are the first of lezer's, and all of them in the header.
          const nonEmpty = r.filter((c) => c.to > c.from).map((c) => `${c.from + from}-${c.to + from}`);
          expect(lezerRows[i]!.slice(0, nonEmpty.length)).toEqual(nonEmpty);
          if (i === 0) expect(lezerRows[i]!).toEqual(nonEmpty);
        });
      }),
      seeded({ numRuns: 500 }),
    );
    // Most generated sources are tables, so the comparison ran.
    if (!replaying) expect(compared).toBeGreaterThan(150);
  });
});

describe('writeTable', () => {
  const data: TableData = {
    header: ['Item', 'Qty', '東京'],
    align: ['left', 'right', 'center'],
    rows: [
      ['apple', '3', 'x'],
      ['a longer item', '12', ''],
    ],
  };

  it('pads every cell to its column when aligning, counting wide characters as two', () => {
    const out = writeTable(data, { align: true });
    const lines = out.split('\n');
    const width = (s: string) => [...s].reduce((w, ch) => w + (/[\u3000-\u9fff]/.test(ch) ? 2 : 1), 0);
    expect(new Set(lines.map(width)).size).toBe(1);
    for (const line of lines) expect(line.startsWith('| ') && line.endsWith(' |')).toBe(true);
    expect(lines[1]).toMatch(/^\| :-{3,} \| -{3,}: \| :-{3,}: \|$/);
    expect(out.endsWith('\n')).toBe(false);
    expect(lines[2]).toBe('| apple         |    3 |   x   |'); // left, right and centered
  });

  it('writes one space either side when not aligning', () => {
    expect(writeTable(data, { align: false })).toBe(
      '| Item | Qty | 東京 |\n| :--- | ---: | :---: |\n| apple | 3 | x |\n| a longer item | 12 |  |',
    );
  });

  it('keeps the table whole when a cell holds a pipe or a line break, and fits rows to the header', () => {
    const out = writeTable(
      { header: ['a', 'b'], align: ['none'], rows: [['x|y', 'p\nq'], ['only']] },
      { align: false },
    );
    expect(toData(parseTable(out)!)).toEqual({
      header: ['a', 'b'],
      align: ['none', 'none'],
      rows: [
        ['x\\|y', 'p<br>q'],
        ['only', ''],
      ],
    });
  });

  it('refuses a table with no columns', () => {
    expect(() => writeTable({ header: [], align: [], rows: [] }, { align: true })).toThrow(RangeError);
  });

  it('round-trips: parsing what it wrote gives the same data, both ways', () => {
    const typed = fc.string({
      unit: fc.constantFrom('a', 'Z', ' ', '|', '\\', '`', '*', '\n', '東', 'é', '😀', '-', ':', '<', '\t'),
      maxLength: 12,
    });
    const align = fc.constantFrom('none', 'left', 'center', 'right') as fc.Arbitrary<
      'none' | 'left' | 'center' | 'right'
    >;
    const table = fc.integer({ min: 1, max: 4 }).chain((cols) =>
      fc.record({
        header: fc.array(typed.map(cellFromInput), { minLength: cols, maxLength: cols }),
        align: fc.array(align, { minLength: cols, maxLength: cols }),
        rows: fc.array(fc.array(typed.map(cellFromInput), { minLength: cols, maxLength: cols }), { maxLength: 4 }),
      }),
    );
    fc.assert(
      fc.property(table, fc.boolean(), (d, aligned) => {
        const parsed = parseTable(writeTable(d, { align: aligned }));
        expect(parsed).not.toBeNull();
        expect(toData(parsed!)).toEqual(d);
      }),
      seeded({ numRuns: 1000 }),
    );
  });

  it('round-trips data read from a source, cells written as they were', () => {
    const src = '| a\\ | `x\\|y` | b\\\\ |\n|---|---|---|\n| \u00a0nb\u00a0 | <br> | \\* |';
    const d = toData(parseTable(src)!);
    for (const aligned of [true, false]) expect(toData(parseTable(writeTable(d, { align: aligned }))!)).toEqual(d);
  });
});

describe('cellFromInput', () => {
  it('trims, writes line breaks as <br> and escapes unescaped pipes', () => {
    expect(cellFromInput('  hello  ')).toBe('hello');
    expect(cellFromInput('one\ntwo\r\nthree')).toBe('one<br>two<br>three');
    expect(cellFromInput('a|b')).toBe('a\\|b');
    expect(cellFromInput('a\\|b')).toBe('a\\|b');
    expect(cellFromInput('a\\\\|b')).toBe('a\\\\\\|b'); // an escaped backslash, then a pipe to escape
    expect(cellFromInput('C:\\dir\\')).toBe('C:\\dir\\\\'); // a trailing backslash is doubled
  });
});

describe('tsvToTable', () => {
  it('turns a spreadsheet paste into a table', () => {
    const out = tsvToTable('Name\tQty\r\napple\t3\r\n"pear, green"\t"1""2"\r\n');
    expect(toData(parseTable(out!)!)).toEqual({
      header: ['Name', 'Qty'],
      align: ['none', 'none'],
      rows: [
        ['apple', '3'],
        ['pear, green', '1"2'],
      ],
    });
  });

  it('keeps a quoted line break as <br> and escapes pipes', () => {
    const out = tsvToTable('a\tb\n"line one\nline two"\tx|y\n');
    expect(toData(parseTable(out!)!).rows).toEqual([['line one<br>line two', 'x\\|y']]);
  });

  it('refuses text that is not a spreadsheet paste', () => {
    expect(tsvToTable('')).toBeNull();
    expect(tsvToTable('just a line')).toBeNull();
    expect(tsvToTable('one\trow\n')).toBeNull(); // a single row
    expect(tsvToTable('a\tb\n1\t2')).not.toBeNull();
    expect(tsvToTable('\tindented code\n\t\tmore code\n')).toBeNull();
    expect(tsvToTable('a\tb\nc\n')).toBeNull(); // rows of different lengths
  });
});

describe('structure edits', () => {
  const d: TableData = {
    header: ['A', 'B', 'C'],
    align: ['left', 'none', 'right'],
    rows: [
      ['1', '2', '3'],
      ['4', '5', '6'],
    ],
  };

  it('insert, delete and move rows (body rows only)', () => {
    expect(insertRow(d, 1).rows).toEqual([
      ['1', '2', '3'],
      ['', '', ''],
      ['4', '5', '6'],
    ]);
    expect(insertRow(d, 2).rows[2]).toEqual(['', '', '']);
    expect(deleteRow(d, 0).rows).toEqual([['4', '5', '6']]);
    expect(deleteRow(deleteRow(d, 0), 0)).toEqual({ ...d, rows: [] });
    expect(moveRow(d, 0, 1).rows).toEqual([
      ['4', '5', '6'],
      ['1', '2', '3'],
    ]);
    expect(deleteRow(d, 5)).toBe(d);
    expect(insertRow(d, -1)).toBe(d);
  });

  it('insert, delete and move columns, never the last one', () => {
    expect(insertColumn(d, 1)).toEqual({
      header: ['A', '', 'B', 'C'],
      align: ['left', 'none', 'none', 'right'],
      rows: [
        ['1', '', '2', '3'],
        ['4', '', '5', '6'],
      ],
    });
    expect(deleteColumn(d, 0)).toEqual({
      header: ['B', 'C'],
      align: ['none', 'right'],
      rows: [
        ['2', '3'],
        ['5', '6'],
      ],
    });
    expect(moveColumn(d, 2, 0)).toEqual({
      header: ['C', 'A', 'B'],
      align: ['right', 'left', 'none'],
      rows: [
        ['3', '1', '2'],
        ['6', '4', '5'],
      ],
    });
    const one: TableData = { header: ['only'], align: ['none'], rows: [['x']] };
    expect(deleteColumn(one, 0)).toBe(one);
  });

  it('sets a column alignment', () => {
    expect(setAlign(d, 1, 'center').align).toEqual(['left', 'center', 'right']);
    expect(setAlign(d, 7, 'center')).toBe(d);
  });

  it('never changes the data it was given', () => {
    const copy = JSON.parse(JSON.stringify(d));
    insertRow(d, 0);
    deleteRow(d, 0);
    moveRow(d, 0, 1);
    insertColumn(d, 0);
    deleteColumn(d, 0);
    moveColumn(d, 0, 2);
    setAlign(d, 0, 'right');
    expect(d).toEqual(copy);
  });
});
