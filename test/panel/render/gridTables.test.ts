// Reading Pandoc's grid tables, where the parser finds one, and what a cell reads of the file.
import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { panelContext } from '../../../src/panel/context';
import { linkAt } from '../../../src/panel/links/read';
import { inlineDrawing } from '../../../src/panel/render/framework';
import { gridCellState } from '../../../src/panel/render/gridTables';
import { inlineText } from '../../../src/panel/render/inlineDom';
import { fileGrid, readGridTable, type GridTable } from '../../../src/panel/tables/gridCells';
import { stateOf } from '../helpers';
import { find, topLevel } from '../markdown/treeHelpers';

const table = [
  '+---------------+---------------+--------------------+',
  '| Fruit         | Price         | Advantages         |',
  '+===============+==============:+:==================:+',
  '| Bananas       | $1.34         | - built-in wrapper |',
  '|               |               | - bright color     |',
  '+---------------+---------------+--------------------+',
  '| Oranges       | $2.10         | - cures scurvy     |',
  '|               |               | - tasty            |',
  '+---------------+---------------+--------------------+',
];

/** A reading's cells as their markdown. */
function texts(read: GridTable | null) {
  return (
    read && {
      align: read.align,
      head: read.head.map((row) => row.cells.map((cell) => cell.text)),
      body: read.body.map((row) => row.cells.map((cell) => cell.text)),
    }
  );
}

describe('readGridTable', () => {
  it("reads Pandoc's example: header, cells over several lines, alignment from the header's border", () => {
    expect(texts(readGridTable(table))).toEqual({
      align: [null, 'right', 'center'],
      head: [['Fruit', 'Price', 'Advantages']],
      body: [
        ['Bananas', '$1.34', '- built-in wrapper\n- bright color'],
        ['Oranges', '$2.10', '- cures scurvy\n- tasty'],
      ],
    });
  });

  it('reads a table with no header', () => {
    expect(texts(readGridTable(['+---+---+', '| a | b |', '+---+---+']))).toEqual({
      align: [null, null],
      head: [],
      body: [['a', 'b']],
    });
  });

  it('gives null for borders out of line, spans, and a missing last border', () => {
    expect(readGridTable(['+---+---+', '| a  | b |', '+---+---+'])).toBeNull();
    expect(readGridTable(['+---+---+', '| a     |', '+---+---+'])).toBeNull();
    expect(readGridTable(['+---+---+', '| a | b |'])).toBeNull();
    expect(readGridTable(['+---+---+', '| a | b |', '+===+===+', '| c | d |', '+===+===+'])).toBeNull();
  });
});

describe('the grid table parser', () => {
  it('takes the border line and the lines of | and + after it, and reads nothing inside as markdown', () => {
    const text = `${table.join('\n')}\n\nAfter`;
    expect(topLevel(text)).toEqual(['GridTable', 'Paragraph']);
    expect(find(text, 'GridTable')[0]!.text).toBe(table.join('\n'));
    expect(find(text, 'Highlight', 'BulletList')).toEqual([]);
  });

  it('does not interrupt a paragraph, and needs a whole border line', () => {
    expect(topLevel('Text\n+---+\n| a |\n+---+')).toEqual(['Paragraph']);
    expect(find('+--- not a border\n| a |', 'GridTable')).toEqual([]);
  });
});

describe("a grid table's cell", () => {
  const grid = [
    '> +-----------+-----------+',
    '> | [docs][d] | b^[two]   |',
    '> | more      | x [^n]    |',
    '> +-----------+-----------+',
  ];
  const text = `One^[one]\n\n${grid.join('\n')}\n\nThree^[three]\n\n[d]: https://example.com/docs\n\n[^n]: The note.\n`;

  it('follows a reference link the file defines elsewhere, found at its place in the file', () => {
    const at = text.indexOf('[docs]');
    expect(linkAt(stateOf(text), at + 2, 1, true)).toMatchObject({
      href: 'https://example.com/docs',
      from: at,
      to: at + '[docs][d]'.length,
    });
  });

  it("draws its notes with their numbers in the file's sequence", () => {
    const file = stateOf(text);
    let node = syntaxTree(file).resolveInner(text.indexOf('b^[two]'), 1);
    while (node.name !== 'GridTable') node = node.parent!;
    const read = fileGrid(file, node)!;
    const cell = read.table.body[0]!.cells[1]!;
    const state = gridCellState(file.facet(panelContext)!, 'view', file, read.start, cell);
    const paragraph = syntaxTree(state).topNode.firstChild!;
    const drawing = inlineDrawing(state, 'gridTables', [paragraph]);
    expect(inlineText(drawing, state.doc, paragraph.from, paragraph.to)).toBe('b2\nx 3');
  });

  it('resolves links inside task items in grid table cells', () => {
    const taskGrid = [
      '+-----------------------+',
      '| - [ ] check [docs][d] |',
      '+-----------------------+',
      '',
      '[d]: https://example.com/docs',
    ].join('\n');
    const at = taskGrid.indexOf('[docs]');
    expect(linkAt(stateOf(taskGrid), at + 2, 1, true)).toMatchObject({
      href: 'https://example.com/docs',
      from: at,
      to: at + '[docs][d]'.length,
    });
  });
});
