// Table editing without a browser: reading a table from the editor state, a cell commit,
// the check before a commit, structure edits through the model, and a new table.

import { syntaxTree } from '@codemirror/language';
import { ChangeSet, type EditorState, type ChangeSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { countCells, toData, writeTable } from '../../../src/core/tableModel';
import { createEditorState } from '../../../src/panel/editor';
import { withFullTree } from '../../../src/panel/render/framework';
import {
  applyAction,
  checkCell,
  commitPlan,
  mapTarget,
  newTable,
  overlongRow,
  structureEdit,
  type CellTarget,
  type TableAction,
} from '../../../src/panel/tables/edits';
import { readTableAt, tableNodeAt } from '../../../src/panel/tables/model';
import { fakeContext, stateOf } from '../helpers';

/** Applies a plan's changes. */
function apply(state: EditorState, changes: ChangeSpec[] | ChangeSpec): string {
  return state.update({ changes }).state.doc.toString();
}

/** The target a field opened on cell (row, col) of the table holding `pos` would have. */
function target(state: EditorState, pos: number, row: number, col: number): CellTarget {
  const info = readTableAt(state, pos)!;
  const cell = row === 0 ? info.table.header[col]! : info.table.rows[row - 1]![col]!;
  return { from: cell.from, to: cell.to, touched: false, col };
}

function commit(state: EditorState, t: CellTarget, typed: string, options: { align?: boolean; addRow?: boolean } = {}) {
  const checked = checkCell(state, t);
  if (!checked) return null;
  return commitPlan(state, checked, typed, { align: options.align ?? false, addRow: options.addRow });
}

const TABLE = 'Intro\n\n| Name | Qty |\n| :--- | --: |\n| apple | 3 |\n| pear | 10 |\n\nAfter\n';

describe('reading a table', () => {
  it('gives every cell its span in the document', () => {
    const state = stateOf(TABLE);
    const info = readTableAt(state, TABLE.indexOf('apple'))!;
    expect(info.width).toBe(2);
    expect(info.table.align).toEqual(['left', 'right']);
    const doc = state.doc.toString();
    for (const cell of [...info.table.header, ...info.table.rows.flat()])
      expect(doc.slice(cell.from, cell.to)).toBe(cell.text);
    expect(doc.slice(info.from, info.to)).toBe('| Name | Qty |\n| :--- | --: |\n| apple | 3 |\n| pear | 10 |');
    expect(info.overlong).toBe(false);
    expect(info.drawable).toBe(true);
  });

  it('reads a table inside a quote, keeping each line prefix', () => {
    const text = '> | a | b |\n> | - | - |\n> | **x** | y |\n';
    const state = stateOf(text);
    const info = readTableAt(state, 3)!;
    expect(info.lines.map((l) => l.prefix)).toEqual(['> ', '> ', '> ']);
    expect(info.table.rows[0]!.map((c) => c.text)).toEqual(['**x**', 'y']);
    expect(text.slice(info.table.rows[0]![1]!.from, info.table.rows[0]![1]!.to)).toBe('y');
    expect(info.drawable).toBe(true);
  });

  it('marks a table on a list item marker line as not drawable', () => {
    expect(readTableAt(stateOf('- | a | b |\n  | - | - |\n'), 3)!.drawable).toBe(false);
    expect(readTableAt(stateOf('- item\n\n  | a | b |\n  | - | - |\n'), 12)!.drawable).toBe(true);
  });

  it('counts the cells of a row as written, and sees a row longer than the header', () => {
    expect(countCells('| a | b |')).toBe(2);
    expect(countCells('a | b')).toBe(2);
    expect(countCells('| a \\| b |')).toBe(1);
    expect(countCells('|  |  |')).toBe(2);
    expect(countCells('| a |')).toBe(1);
    expect(readTableAt(stateOf('| a | b |\n| - | - |\n| 1 | 2 | 3 |\n'), 0)!.overlong).toBe(true);
  });

  it('finds no table where a --- line under it made a Setext heading', () => {
    const state = stateOf('| a | b |\n| - | - |\n| 1 | 2 |\n---\n');
    expect(tableNodeAt(state, 0)).toBeNull();
  });
});

describe('a cell commit', () => {
  it("changes only that cell's characters when alignment is off", () => {
    const state = stateOf(TABLE);
    const t = target(state, TABLE.indexOf('apple'), 1, 0);
    const plan = commit(state, t, 'green apple')!;
    const after = apply(state, plan.changes);
    expect(after).toBe(TABLE.replace('| apple |', '| green apple |'));
    // Everything outside the cell's span is the same text.
    expect(after.slice(0, t.from)).toBe(TABLE.slice(0, t.from));
    expect(after.slice(t.from + 'green apple'.length)).toBe(TABLE.slice(t.to));
  });

  it('writes a typed pipe as \\| and a line break as <br>', () => {
    const state = stateOf(TABLE);
    const plan = commit(state, target(state, TABLE.indexOf('pear'), 2, 0), 'a|b\nc')!;
    expect(apply(state, plan.changes)).toContain('| a\\|b<br>c | 10 |');
  });

  it('writes nothing when the text did not change', () => {
    const state = stateOf(TABLE);
    expect(commit(state, target(state, TABLE.indexOf('pear'), 2, 0), 'pear')!.changes).toEqual([]);
  });

  it('rewrites only its row for a cell the row does not have', () => {
    const text = '| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 | 4 |\n';
    const state = stateOf(text);
    const plan = commit(state, target(state, 0, 1, 2), 'x')!;
    expect(apply(state, plan.changes)).toBe('| a | b | c |\n| - | - | - |\n| 1 |  | x |\n| 2 | 3 | 4 |\n');
    // A short row with no closing pipe gets one first.
    const open = '| a | b |\n| - | - |\n| 1\n';
    const s2 = stateOf(open);
    expect(apply(s2, commit(s2, target(s2, 0, 1, 1), 'y')!.changes)).toBe('| a | b |\n| - | - |\n| 1 | y |\n');
  });

  it('pads the whole table with alignment on', () => {
    const state = stateOf(TABLE);
    const plan = commit(state, target(state, TABLE.indexOf('apple'), 1, 0), 'kiwi', { align: true })!;
    // writeTable pads each column to its widest cell, a right-aligned delimiter to at least `---:`.
    expect(apply(state, plan.changes)).toBe(
      'Intro\n\n| Name |  Qty |\n| :--- | ---: |\n| kiwi |    3 |\n| pear |   10 |\n\nAfter\n',
    );
  });

  it('with alignment on and a row longer than the header, writes the cell alone and says so', () => {
    const text = '| a | b |\n| - | - |\n| 1 | 2 | extra |\n';
    const state = stateOf(text);
    const plan = commit(state, target(state, 0, 1, 0), 'one', { align: true })!;
    expect(plan.overlong).toBe(true);
    expect(apply(state, plan.changes)).toBe('| a | b |\n| - | - |\n| one | 2 | extra |\n');
  });

  it('adds an empty row at the end when asked', () => {
    const state = stateOf(TABLE);
    const plan = commit(state, target(state, TABLE.indexOf('pear'), 2, 1), '11', { addRow: true })!;
    expect(apply(state, plan.changes)).toBe(
      'Intro\n\n| Name | Qty |\n| :--- | --: |\n| apple | 3 |\n| pear | 11 |\n|  |  |\n\nAfter\n',
    );
  });
});

describe('the check before a commit', () => {
  it('refuses a commit after the table changed underneath', () => {
    const state = stateOf(TABLE);
    const t = target(state, TABLE.indexOf('apple'), 1, 0);
    // Someone else edits the same cell.
    const inCell = state.update({ changes: { from: t.from, insert: 'red ' } });
    const t1 = { ...t };
    mapTarget(t1, inCell.changes);
    expect(t1.touched).toBe(true);
    expect(checkCell(inCell.state, t1)).toBeNull();
    // Someone removes the delimiter row: it is not a table any more.
    const delim = TABLE.indexOf('| :---');
    const broken = state.update({ changes: { from: delim, to: delim + '| :--- | --: |\n'.length } });
    const t2 = { ...t };
    mapTarget(t2, broken.changes);
    expect(t2.touched).toBe(false);
    expect(checkCell(broken.state, t2)).toBeNull();
    // Someone merges the cell with its neighbor: its span is not a cell's span any more.
    const pipe = TABLE.indexOf('| 3 |');
    const merged = state.update({ changes: { from: pipe, to: pipe + 1 } });
    const t3 = { ...t };
    mapTarget(t3, merged.changes);
    expect(checkCell(merged.state, t3)).toBeNull();
  });

  it('refuses a cell whose row was deleted, even where an empty cell now sits', () => {
    const text = '| a | b |\n| - | - |\n| 1 |\n| 2 |\n';
    const state = stateOf(text);
    const t = target(state, 0, 2, 1); // the missing cell at the end of "| 2 |"
    const row = text.indexOf('\n| 2 |');
    const tr = state.update({ changes: { from: row, to: row + '\n| 2 |'.length } });
    mapTarget(t, tr.changes);
    expect(checkCell(tr.state, t)).toBeNull();
  });

  it('follows its cell when rows are added above it', () => {
    const state = stateOf(TABLE);
    const t = target(state, TABLE.indexOf('pear'), 2, 0);
    const at = TABLE.indexOf('| apple');
    const tr = state.update({ changes: { from: at, insert: '| fig | 1 |\n' } });
    mapTarget(t, tr.changes);
    const checked = checkCell(tr.state, t)!;
    expect(checked).not.toBeNull();
    expect([checked.row, checked.col]).toEqual([3, 0]);
    expect(apply(tr.state, commitPlan(tr.state, checked, 'plum', { align: false }).changes)).toContain('| plum | 10 |');
  });
});

describe('structure edits', () => {
  const actions: TableAction[] = [
    'insertRowAbove',
    'insertRowBelow',
    'insertColumnLeft',
    'insertColumnRight',
    'deleteRow',
    'deleteColumn',
    'alignLeft',
    'alignCenter',
    'alignRight',
    'moveRowUp',
    'moveRowDown',
    'moveColumnLeft',
    'moveColumnRight',
    'alignTable',
  ];
  const text =
    'Before\n\n| h1 | h2 | h3 |\n| --- | :---: | ---: |\n| a | **b** | c |\n| d | e | f |\n| g | h | i |\n\nAfter\n';

  for (const action of actions) {
    it(`${action} round-trips through the model`, () => {
      const state = stateOf(text);
      const pos = text.indexOf('| d |');
      const ref = { row: 2, col: 1 };
      const result = structureEdit(state, action, { pos, ref }, { alignOnEdit: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const after = state.update({ changes: result.changes }).state;
      const want = applyAction(toData(readTableAt(state, pos)!.table), action, ref)!;
      const got = readTableAt(after, after.doc.toString().indexOf('| h1') + 2)!;
      expect(toData(got.table)).toEqual(want.data);
      // Nothing outside the table changes.
      expect(after.doc.toString().startsWith('Before\n\n|')).toBe(true);
      expect(after.doc.toString().endsWith('|\n\nAfter\n')).toBe(true);
    });
  }

  it('changes only the lines it has to in a compact table', () => {
    const state = stateOf(text);
    const result = structureEdit(
      state,
      'insertRowBelow',
      { pos: text.indexOf('| d |'), ref: { row: 2, col: 0 } },
      { alignOnEdit: false },
    );
    expect(result.ok && result.changes).toEqual([
      { from: text.indexOf('| g |'), to: text.indexOf('| g |'), insert: '|  |  |  |\n' },
    ]);
  });

  it('keeps an aligned table aligned', () => {
    const write = (rows: string[][]) =>
      writeTable({ header: ['Name', 'Qty'], align: ['none', 'right'], rows }, { align: true }) + '\n';
    const state = stateOf(write([['apple', '3']]));
    const result = structureEdit(state, 'insertRowBelow', { pos: 0, ref: { row: 1, col: 0 } }, { alignOnEdit: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(apply(state, result.changes)).toBe(
      write([
        ['apple', '3'],
        ['', ''],
      ]),
    );
    expect(apply(state, result.changes)).toBe(
      '| Name  |  Qty |\n| ----- | ---: |\n| apple |    3 |\n|       |      |\n',
    );
  });

  it("puts an open field's text into the same change", () => {
    const state = stateOf(text);
    const pending = target(state, text.indexOf('| d |'), 2, 0);
    const result = structureEdit(state, 'insertRowAbove', { pending, typed: 'D' }, { alignOnEdit: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.active).toEqual({ row: 2, col: 0 });
    expect(apply(state, result.changes)).toContain('| a | **b** | c |\n|  |  |  |\n| D | e | f |');
  });

  it('refuses a table with a row longer than its header, and gives the table so the row can be named', () => {
    const state = stateOf('| a | b |\n| - | - |\n| 1 | 2 | 3 |\n');
    for (const action of ['insertRowBelow', 'alignTable'] as const) {
      const result = structureEdit(state, action, { pos: 0, ref: { row: 1, col: 0 } }, { alignOnEdit: false });
      expect(result).toMatchObject({ ok: false, reason: 'overlong' });
      if (result.ok || result.reason !== 'overlong') continue;
      expect(overlongRow(result.info, state.doc)).toEqual({ from: state.doc.line(3).from, start: '1' });
    }
  });

  it('names the first over-long row by its first cell, or by its text when that cell is empty', () => {
    const named = (text: string) => {
      const state = stateOf(text);
      return overlongRow(readTableAt(state, 0)!, state.doc);
    };
    expect(named('| a | b |\n| - | - |\n| ok | 2 |\n| Apples | 2 | 3 |\n| Pears | 2 | 3 |\n')?.start).toBe('Apples');
    expect(named('| a | b |\n| - | - |\n|  | 2 | 3 |\n')?.start).toBe('|  | 2 | 3 |');
    expect(named('| a | b |\n| - | - |\n| 1 | 2 |\n')).toBeNull();
    const long = named(`| a | b |\n| - | - |\n| ${'word '.repeat(20)}| 2 | 3 |\n`)!.start;
    expect(Array.from(long).length).toBe(40);
    expect(long.endsWith('…')).toBe(true);
  });

  it('does not apply where it cannot: above the header, the last column, past the edges', () => {
    const data = { header: ['a'], align: ['none' as const], rows: [['1']] };
    expect(applyAction(data, 'insertRowAbove', { row: 0, col: 0 })).toBeNull();
    expect(applyAction(data, 'deleteRow', { row: 0, col: 0 })).toBeNull();
    expect(applyAction(data, 'deleteColumn', { row: 1, col: 0 })).toBeNull();
    expect(applyAction(data, 'moveRowUp', { row: 1, col: 0 })).toBeNull();
    expect(applyAction(data, 'moveRowDown', { row: 1, col: 0 })).toBeNull();
    expect(applyAction(data, 'moveColumnLeft', { row: 1, col: 0 })).toBeNull();
  });

  it("takes a column's alignment off when its own button is pressed again", () => {
    const data = { header: ['a'], align: ['center' as const], rows: [] };
    expect(applyAction(data, 'alignCenter', { row: 0, col: 0 })!.data.align).toEqual(['none']);
    expect(applyAction(data, 'alignLeft', { row: 0, col: 0 })!.data.align).toEqual(['left']);
  });

  it('rewrites a table inside a quote with its markers', () => {
    const quoted = '> | a | b |\n> | - | - |\n> | 1 | 2 |\n';
    const state = stateOf(quoted);
    const result = structureEdit(state, 'insertRowBelow', { pos: 3, ref: { row: 1, col: 0 } }, { alignOnEdit: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(apply(state, result.changes)).toBe('> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n> |  |  |\n');
  });
});

describe('a new table', () => {
  // `^` marks the cursor.
  const cases: [string, string][] = [
    ['^', '|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n'],
    ['Text^', 'Text\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n'],
    [
      'One^\ntwo\n\nNext\n',
      'One\ntwo\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n\nNext\n',
    ],
    [
      'Above\n^\nBelow\n',
      'Above\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n\nBelow\n',
    ],
    [
      'Above\n\n^\n\nBelow\n',
      'Above\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n\nBelow\n',
    ],
    // Inside a list item or a quote, the table stays in it.
    [
      '- it^em one\n- item two\n',
      '- item one\n\n  |     |     |     |\n  | --- | --- | --- |\n  |     |     |     |\n  |     |     |     |\n\n- item two\n',
    ],
    [
      '1. one\n2. t^wo\n3. three\n',
      '1. one\n2. two\n\n   |     |     |     |\n   | --- | --- | --- |\n   |     |     |     |\n   |     |     |     |\n\n3. three\n',
    ],
    [
      '> pa^ra\n>\n> second\n',
      '> para\n>\n> |     |     |     |\n> | --- | --- | --- |\n> |     |     |     |\n> |     |     |     |\n>\n> second\n',
    ],
    // A blank line inside a code block is code: the table goes after the block.
    [
      '```\na\n^\nb\n```\n',
      '```\na\n\nb\n```\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n',
    ],
  ];
  for (const [before, after] of cases) {
    it(`is inserted as its own block: ${JSON.stringify(before)}`, () => {
      const at = before.indexOf('^');
      const text = before.replace('^', '');
      const state = withFullTree(
        createEditorState({ ctx: fakeContext().ctx, text, mode: 'edit', selection: { anchor: at, head: at } }),
      );
      const plan = newTable(state);
      const next = state.update({ changes: plan.changes, selection: { anchor: plan.cursor } }).state;
      expect(next.doc.toString()).toBe(after);
      const info = readTableAt(next, plan.tableFrom)!;
      expect(info.from).toBe(plan.tableFrom);
      expect([info.width, info.table.rows.length]).toEqual([3, 2]);
      // The cursor is on the line after the table, so the table draws as a grid.
      expect(next.doc.lineAt(plan.cursor).number).toBe(next.doc.lineAt(info.to).number + 1);
    });
  }

  it('a table inserted into a list item or a quote leaves one list or one quote', () => {
    for (const [before, container] of [
      ['1. one\n2. t^wo\n3. three\n', 'OrderedList'],
      ['> pa^ra\n>\n> second\n', 'Blockquote'],
    ] as const) {
      const at = before.indexOf('^');
      const state = withFullTree(
        createEditorState({
          ctx: fakeContext().ctx,
          text: before.replace('^', ''),
          mode: 'edit',
          selection: { anchor: at, head: at },
        }),
      );
      const next = withFullTree(state.update({ changes: newTable(state).changes }).state);
      const top: string[] = [];
      for (let n = syntaxTree(next).topNode.firstChild; n; n = n.nextSibling) top.push(n.name);
      expect(top).toEqual([container]);
      expect(tableNodeAt(next, next.doc.toString().indexOf('|'))?.parent?.name).toBe(
        container === 'OrderedList' ? 'ListItem' : 'Blockquote',
      );
    }
  });
});

describe('mapping a target', () => {
  it("counts text put at an empty cell's spot as touching it", () => {
    const t: CellTarget = { from: 5, to: 5, touched: false };
    mapTarget(t, ChangeSet.of({ from: 5, insert: 'x' }, 20));
    expect(t).toEqual({ from: 5, to: 6, touched: true });
    const u: CellTarget = { from: 5, to: 7, touched: false };
    mapTarget(u, ChangeSet.of({ from: 0, insert: 'ab' }, 20));
    expect(u).toEqual({ from: 7, to: 9, touched: false });
  });
});
