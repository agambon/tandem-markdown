// How tables are drawn, without a browser: which lines the widget replaces, when the source
// shows instead, what each cell draws, and that a partial redraw agrees with a full one.

import type { EditorState } from '@codemirror/state';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PanelSettings } from '../../../src/core/protocol';
import { createEditorState } from '../../../src/panel/editor';
import { setModeEffect } from '../../../src/panel/modes';
import { redrawFeatureEffect, withFullTree } from '../../../src/panel/render/framework';
import { yamlReader } from '../../../src/panel/render/frontmatter';
import type { TableWidget } from '../../../src/panel/tables/widget';
import { Rng } from '../../sync/world';
import { drawHeadless } from '../headless';
import {
  cellReadings,
  drawn,
  drawnLines,
  expectSameAsFresh,
  fakeContext,
  freshState,
  gridsOf,
  randomEdit,
  readInline,
  stateOf,
} from '../helpers';

function tableDrawing(state: EditorState) {
  return drawn(state).filter((d) => d.feature === 'tables');
}

function widgets(state: EditorState): TableWidget[] {
  const out: TableWidget[] = [];
  for (const f of drawHeadless(state)) {
    if (f.feature !== 'tables') continue;
    f.decorations.between(0, state.doc.length, (_from, _to, deco) => {
      if (deco.spec.widget) out.push(deco.spec.widget as TableWidget);
    });
  }
  return out;
}

/** Each cell's drawn text, by row and column. */
const texts = (widget: TableWidget) => cellReadings(widget.grid).map((row) => row.map((cell) => cell.text));

const DOC = 'Intro\n\n| A | B |\n| - | :-: |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter\n';

describe('a cell draws what a line draws', () => {
  // Each stands between words, so nothing in it is a block of its own; the text after it is
  // the rest of the note.
  const examples: [string, string, PanelSettings['syntax']?][] = [
    ['**bold**, *italic* and ~~gone~~', ''],
    ['H~2~O and x^2^', ''],
    ['==marked== and ==🔴red==', ''],
    ['`code` and `a b`', ''],
    ['[link](https://example.com), <https://example.com> and www.example.com', ''],
    ['[ref][r]', '\n\n[r]: https://example.com'],
    ['[[Note]] and [[Note#Part]]', ''],
    ['![chart](chart.png){width=50%} and ![[pic.png]]', ''],
    ['#project/sub', ''],
    ['$x^2$', ''],
    ['a note[^1] and one in place^[here]', '\n\n[^1]: The note.'],
    ['[under]{.underline}', ''],
    ['{++added++} and {--gone--}', '', { criticMarkup: true }],
    ['%%hidden%%', ''],
    ['&amp; and \\*', ''],
    ['<kbd>K</kbd>, H<sub>2</sub>O and one<br>two', ''],
    ['HTML', '\n\n*[HTML]: Hyper Text Markup Language'],
  ];

  for (const [example, rest, syntax] of examples) {
    it(`draws ${example} in a cell as in a line`, () => {
      const { ctx } = fakeContext({ settings: { syntax: syntax ?? {} } });
      const inLine = `a ${example} z`;
      const paragraph = withFullTree(createEditorState({ ctx, text: inLine + rest, mode: 'view' }));
      const inline = drawHeadless(paragraph)
        .filter((f) => f.channel === 'inline')
        .map((f) => f.decorations);
      const want = readInline(inline, inLine, 0, inLine.length);
      const table = withFullTree(
        createEditorState({ ctx, text: `| Head |\n| --- |\n| ${inLine} |${rest}`, mode: 'view' }),
      );
      const got = cellReadings(gridsOf(table)[0]!)[1]![0]!;
      expect({ text: got.text, classes: got.classes }).toEqual({ text: want.text, classes: want.classes });
    });
  }

  it('draws a list written as HTML in a cell as that list, each element by its name', () => {
    const state = stateOf('| a |\n| - |\n| <ul><li>one</li><li>two</li></ul> |\n');
    const cell = cellReadings(gridsOf(state)[0]!)[1]![0]!;
    expect(cell.text).toBe('onetwo');
    expect(cell.classes).toEqual(['tm-html-li', 'tm-html-ul']);
  });

  it('reads `\\|` as a pipe in code and after the alt text of a picture, as GFM does', () => {
    const state = stateOf('| a |\n| - |\n| `x\\|y` ![alt\\|300](p.png) |\n');
    const [code, picture] = cellReadings(gridsOf(state)[0]!)[1]![0]!.text.split(' ');
    expect(code).toBe('x|y');
    expect(picture).toBe('[ImageWidget]');
    const image = cellReadings(gridsOf(state)[0]!)[1]![0]!.widgets[0] as unknown as { spec: object };
    expect(image.spec).toMatchObject({ alt: 'alt', width: 300 });
  });
});

describe('the table widget', () => {
  it("replaces exactly the table's lines", () => {
    const state = stateOf(DOC);
    const from = DOC.indexOf('| A');
    const to = DOC.indexOf('| 4 |') + '| 4 |'.length;
    expect(tableDrawing(state).map((d) => [d.kind, d.from, d.to, d.widget])).toEqual([
      ['replaceLines', from, to, 'TableWidget'],
    ]);
  });

  it('shows the source lines while the selection is in the table, in Rich editor only', () => {
    const inside = DOC.replace('| 1 |', '| 1‸ |');
    const state = stateOf(inside);
    const items = tableDrawing(state);
    expect(items.every((d) => d.kind === 'line')).toBe(true);
    expect(items.length).toBe(4);
    expect(tableDrawing(stateOf(inside, { mode: 'view' })).map((d) => d.kind)).toEqual(['replaceLines']);
  });

  it("draws the grid from the delimiter row and the cells' inline nodes", () => {
    const text =
      '| **Bold** | `a\\|b` | [link](https://x.y) |\n| :-- | --: | :-: |\n| *em* ~~gone~~ | [[Note\\|Alias]] | one<br>two \\* |\n| short |\n';
    const [widget] = widgets(stateOf(text));
    expect(widget!.grid.align).toEqual(['left', 'right', 'center']);
    expect(texts(widget!)).toEqual([
      ['Bold', 'a|b', 'link'],
      ['em gone', 'Alias', 'one[LineBreak]two *'],
      ['short', '', ''],
    ]);
  });

  it('draws a reference link as a link only when its label is defined, and follows a changed definition', () => {
    const text = '| a | b |\n| - | - |\n| [x] | [y][z] |\n\nFar below.\n\n[x]: https://one.example\n';
    // How far a new state is parsed depends on CodeMirror's 20 ms budget for its first parse, so
    // the definition can be parsed after the table is drawn. The panel then redraws the tables
    // when the definitions change, as here.
    let state = stateOf(text);
    state = state.update({ effects: redrawFeatureEffect.of('tables') }).state;
    // A link shows its text alone; a label nothing defines stays as typed.
    const cells = () => cellReadings(widgets(state)[0]!.grid)[1]!;
    expect(cells()[0]).toMatchObject({ text: 'x' });
    expect(cells()[1]).toMatchObject({ text: '[y][z]', classes: [] });
    // Defining `z` far from the table draws it as a link.
    state = withFullTree(
      state.update({ changes: { from: state.doc.length, insert: '[z]: https://two.example\n' } }).state,
    );
    expect(cells()[1]!.text).toBe('y');
    expect(cells()[1]!.classes).toEqual(cells()[0]!.classes);
  });

  it('numbers notes written in place in two equal rows by where each stands, when drawn again too', () => {
    const text = '| a |\n| - |\n| x^[note] |\n| x^[note] |\n\nAfter\n';
    let state = withFullTree(createEditorState({ ctx: fakeContext().ctx, text, mode: 'view' }));
    const numbers = () =>
      cellReadings(widgets(state)[0]!.grid)
        .slice(1)
        .map((row) => (row[0]!.widgets[0] as unknown as { text: string }).text);
    expect(numbers()).toEqual(['1', '2']);
    // Typing beside the table draws it again from the rows it keeps.
    state = state.update({ changes: { from: state.doc.length, insert: 'x' } }).state;
    expect(numbers()).toEqual(['1', '2']);
  });

  it('numbers its notes again when a note far from it is added, and when its definition comes', () => {
    // The changes are more than a block from the table, so only the notes' numbers draw it again.
    const text = 'One.\n\nTwo.\n\nThree.\n\n| a |\n| - |\n| x^[here] y[^m] |\n\nFour.\n\nFive.\n';
    let state = withFullTree(createEditorState({ ctx: fakeContext().ctx, text, mode: 'view' }));
    const numbers = () =>
      (cellReadings(widgets(state)[0]!.grid)[1]![0]!.widgets as unknown as { text: string }[]).map((w) => w.text);
    expect(numbers()).toEqual(['1']);
    state = withFullTree(state.update({ changes: { from: 0, insert: 'Zero^[top].\n\n' } }).state);
    expect(numbers()).toEqual(['2']);
    state = withFullTree(state.update({ changes: { from: state.doc.length, insert: '\n[^m]: The note.\n' } }).state);
    expect(numbers()).toEqual(['2', '3']);
  });

  it('draws its cells again for the mode it is switched to', () => {
    // The link has a row of its own: only its attributes differ between the modes.
    let state = stateOf('| a |\n| - |\n| x %%hidden%% y |\n| [link](https://y.example) |\n\nAfter\n');
    const cell = () => cellReadings(widgets(state)[0]!.grid)[1]![0]!;
    /** The attributes of the link's text: in Rich view it can take focus. */
    const linkAttributes = () => {
      const row = widgets(state)[0]!.grid.rows[2]!;
      let found: unknown = null;
      for (const set of row.drawing)
        set.between(0, row.source.length, (_from, _to, deco) => {
          if (deco.spec.class === 'tm-link') found = deco.spec.attributes ?? null;
        });
      return found;
    };
    expect(cell().text).toBe('x %%hidden%% y');
    expect(linkAttributes()).toBeNull();
    state = state.update({ effects: setModeEffect.of('view') }).state;
    expect(cell().text).toBe('x  y');
    expect(linkAttributes()).toEqual({ tabindex: '-1', role: 'link' });
    state = state.update({ effects: setModeEffect.of('edit') }).state;
    expect(cell().text).toBe('x %%hidden%% y');
    expect(linkAttributes()).toBeNull();
  });

  it("does not draw the cells past the header's width", () => {
    const [widget] = widgets(stateOf('| a | b |\n| - | - |\n| 1 | 2 | 3 |\n'));
    expect(texts(widget!)[1]).toEqual(['1', '2']);
  });

  it('draws a table in a list item and in a quote, but not one on a list marker line', () => {
    expect(widgets(stateOf('- item\n\n  | a | b |\n  | - | - |\n')).length).toBe(1);
    expect(widgets(stateOf('> | a | b |\n> | - | - |\n')).length).toBe(1);
    expect(tableDrawing(stateOf('- | a | b |\n  | - | - |\n'))).toEqual([]);
  });

  it('draws nothing of its own for a table the parser read as a Setext heading', () => {
    const state = stateOf('| a | b |\n| - | - |\n| 1 | 2 |\n---\n\nEnd');
    expect(tableDrawing(state)).toEqual([]);
    expect(drawn(state).some((d) => d.feature === 'headings')).toBe(true);
  });
});

// A block feature's partial redraw must give what a full redraw gives.

const start = `---
title: x
tags: [a, b]
---

Text before.
| a | b |
| - | - |
| 1 | 2 |

| c | d |
| :-: | -: |
| 3 | 4 | 5 |

- item

  | e | f |
  | - | - |

> | g | h |
> | - | - |
`;

const snippets = ['\n', '\n\n', '| x |', '| - |\n', ' | ', '|', '---\n', 'text ', '**b** ', '- ', '> ', '\\|', '`c`'];

function blockDrawing(state: EditorState): string[] {
  return drawnLines(state, (d) => d.feature === 'tables' || d.feature === 'frontmatter');
}

describe('a partial redraw of tables and front matter', () => {
  beforeAll(() => yamlReader.load());

  for (const mode of ['edit', 'view'] as const) {
    it(`gives what a full redraw gives, over random edits and cursor moves (${mode})`, () => {
      const { ctx } = fakeContext();
      const rng = new Rng(mode === 'edit' ? 3 : 5);
      expectSameAsFresh({
        start: withFullTree(createEditorState({ ctx, text: start, mode, selection: { anchor: 0, head: 0 } })),
        steps: 150,
        edit: (state) => randomEdit(state, rng, snippets),
        fresh: (state) => freshState(state, ctx, mode),
        read: blockDrawing,
      });
    });
  }
});

describe('tables inside aligned HTML wrappers', () => {
  it('applies wrapper alignment class to GFM tables in trusted workspaces', () => {
    const t = '<div align="center">\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n</div>\n';
    const state = stateOf('‸' + t, { mode: 'view' });
    const list = widgets(state);
    expect(list).toHaveLength(1);
    expect(list[0]!.layout.split(' ')).toContain('tm-table-align-center');
  });

  it('ignores wrapper alignment in untrusted workspaces', () => {
    const t = '<div align="center">\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n</div>\n';
    const state = stateOf('‸' + t, { mode: 'view', ctx: fakeContext({ settings: { workspaceTrusted: false } }).ctx });
    const list = widgets(state);
    expect(list).toHaveLength(1);
    expect(list[0]!.layout.split(' ')).not.toContain('tm-table-align-center');
  });
});
