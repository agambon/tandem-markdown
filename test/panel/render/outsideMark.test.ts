// Which lines an update from outside marks, through PanelSync as a panel receives it, and that
// the mark goes when its fade has run its steps.

import { EditorState, Text } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { PanelSettings } from '../../../src/core/protocol';
import { panelContext } from '../../../src/panel/context';
import { changedLineStarts } from '../../../src/panel/outsideChanges';
import {
  FADE_STEPS,
  markColor,
  outsideMarkField,
  fadeStep,
  type ThemeColors,
} from '../../../src/panel/render/outsideMark';
import { contrast, parseColor } from '../../../src/panel/theme/contrast';
import { fakeContext, SyncedPanel } from '../helpers';

/** A panel (PanelSync over a bare state with the outside-change mark) and a host log that sends it updates. */
class World extends SyncedPanel {
  constructor(text: string, settings: Partial<PanelSettings>) {
    const ctx = fakeContext({ settings }).ctx;
    super(text, (sync) =>
      EditorState.create({ doc: text, extensions: [sync, panelContext.of(ctx), outsideMarkField] }),
    );
  }
  /** One fade step, with the lines `from` to `to` on screen (all of them by default). */
  step(from = 0, to = this.state.doc.length): void {
    this.apply({ effects: fadeStep.of([{ from, to }]) });
  }
  /** The marked lines, by number, with the step class each shows. */
  marked(): { line: number; cls: string }[] {
    const out: { line: number; cls: string }[] = [];
    const doc = this.state.doc;
    this.state.field(outsideMarkField).decorations.between(0, doc.length, (from, _to, deco: Decoration) => {
      out.push({ line: doc.lineAt(from).number, cls: String(deco.spec.class) });
    });
    return out;
  }
  lines(): number[] {
    return this.marked().map((t) => t.line);
  }
}

const world = (text: string, settings: Partial<PanelSettings> = {}) => new World(text, settings);

const TEXT = 'one\ntwo words here\nthree\nfour\n';
const at = (needle: string) => TEXT.indexOf(needle);

describe('the lines an update from outside marks', () => {
  it('marks the line a replaced word is on, and nothing else', () => {
    const w = world(TEXT);
    w.receive(w.update([{ from: at('words'), to: at('words') + 5, insert: 'WORDS' }], 'outside'));
    expect(w.state.doc.toString()).toBe('one\ntwo WORDS here\nthree\nfour\n');
    expect(w.lines()).toEqual([2]);
  });

  it('marks a merge too, and never Source typing, undo or redo', () => {
    const w = world(TEXT);
    w.receive(w.update([{ from: at('three'), insert: 'x' }]));
    w.receive(w.update([{ from: at('four'), insert: 'y' }], 'undo'));
    w.receive(w.update([{ from: at('one'), insert: 'z' }], 'redo'));
    expect(w.lines()).toEqual([]);
    w.receive(w.update([{ from: 0, insert: 'm' }], 'merge'));
    expect(w.lines()).toEqual([1]);
  });

  it('marks only the new line when a line is added, wherever the change puts its line break', () => {
    const start = world(TEXT);
    start.receive(start.update([{ from: at('three'), insert: 'new line\n' }], 'outside'));
    expect(start.state.doc.line(3).text).toBe('new line');
    expect(start.lines()).toEqual([3]);

    const end = world(TEXT);
    end.receive(end.update([{ from: at('\nthree'), insert: '\nnew line' }], 'outside'));
    expect(end.state.doc.line(3).text).toBe('new line');
    expect(end.lines()).toEqual([3]);

    const blank = world(TEXT);
    blank.receive(blank.update([{ from: at('\nthree'), insert: '\n' }], 'outside'));
    expect(blank.state.doc.line(3).text).toBe('');
    expect(blank.lines()).toEqual([3]);
  });

  it('shows nothing for deleted text', () => {
    const w = world(TEXT);
    w.receive(w.update([{ from: at('three'), to: at('four') }], 'outside'));
    expect(w.state.doc.toString()).toBe('one\ntwo words here\nfour\n');
    expect(w.lines()).toEqual([]);
  });

  it('lands on the line the panel shows when the panel has typing the host has not seen', () => {
    const w = world(TEXT);
    w.type(0, 'typed above\n');
    w.receive(w.update([{ from: at('words'), to: at('words') + 5, insert: 'WORDS' }], 'outside'));
    expect(w.state.doc.toString()).toBe('typed above\none\ntwo WORDS here\nthree\nfour\n');
    expect(w.lines()).toEqual([3]);
  });

  it('follows the updates after it in the same message', () => {
    const w = world(TEXT);
    const outside = w.update([{ from: at('three'), insert: 'X' }], 'outside');
    const source = w.update([{ from: 0, insert: 'zero\n' }]);
    w.receive(outside, source);
    expect(w.state.doc.line(4).text).toBe('Xthree');
    expect(w.lines()).toEqual([4]);
  });

  it('stays on its line while the text around it changes', () => {
    const w = world(TEXT);
    w.receive(w.update([{ from: at('three'), insert: 'X' }], 'outside'));
    expect(w.lines()).toEqual([3]);
    w.type(0, 'above\n');
    expect(w.lines()).toEqual([4]);
  });

  it('is off with tandemMarkdown.outsideChanges.highlight false', () => {
    const w = world(TEXT, { outsideHighlight: false });
    w.receive(w.update([{ from: at('three'), insert: 'X' }], 'outside'));
    expect(w.state.doc.line(3).text).toBe('Xthree');
    expect(w.lines()).toEqual([]);
  });

  it('fades through its steps and holds no decoration once the fade is over', () => {
    const w = world(TEXT);
    w.receive(w.update([{ from: at('three'), insert: 'X' }], 'outside'));
    const seen = [w.marked()[0]!.cls];
    for (let step = 1; step < FADE_STEPS; step++) {
      w.step();
      expect(w.lines()).toEqual([3]);
      seen.push(w.marked()[0]!.cls);
    }
    // Each step draws the mark differently: it fades.
    expect(new Set(seen).size).toBe(FADE_STEPS);
    w.step();
    expect(w.marked()).toEqual([]);
    expect(w.state.field(outsideMarkField).lines).toEqual([]);
  });

  it('keeps the mark of a line off screen until the line has been on screen', () => {
    const w = world(TEXT);
    w.receive(
      w.update(
        [
          { from: at('three'), insert: 'X' },
          { from: at('one'), insert: 'Y' },
        ],
        'outside',
      ),
    );
    const fresh = w.marked()[0]!.cls;
    // Only the first line is on screen: line 3 does not fade.
    for (let step = 0; step < FADE_STEPS; step++) w.step(0, 1);
    expect(w.marked()).toEqual([{ line: 3, cls: fresh }]);
    for (let step = 0; step < FADE_STEPS; step++) w.step();
    expect(w.marked()).toEqual([]);
  });

  it('shows the newest mark on a line marked twice', () => {
    const w = world(TEXT);
    w.receive(w.update([{ from: at('three'), insert: 'X' }], 'outside'));
    const fresh = w.marked()[0]!.cls;
    w.step();
    w.step();
    w.receive(w.update([{ from: at('three') + 1, insert: 'Y' }], 'outside'));
    expect(w.marked()).toEqual([{ line: 3, cls: fresh }]);
  });
});

describe('changedLineStarts', () => {
  const doc = Text.of(['alpha', 'beta', '', 'gamma']);
  const start = (n: number) => doc.line(n).from;

  it('takes every line a range holds text on', () => {
    expect(changedLineStarts(doc, [{ from: start(1) + 1, to: start(2) + 2 }])).toEqual([start(1), start(2)]);
  });

  it('leaves out a line the range only starts at the end of, or only ends at the start of', () => {
    expect(changedLineStarts(doc, [{ from: doc.line(1).to, to: doc.line(2).to }])).toEqual([start(2)]);
    expect(changedLineStarts(doc, [{ from: start(2), to: start(4) }])).toEqual([start(2), start(3)]);
  });

  it('keeps an empty line that is the change itself', () => {
    expect(changedLineStarts(doc, [{ from: start(3), to: start(4) }])).toEqual([start(3)]);
  });
});

describe('the color an outline is drawn in', () => {
  /** A theme's colors, as VS Code gives them to a webview. */
  const theme = (page: string, text: string, inserted: string | null, border: string | null = null): ThemeColors => ({
    page: parseColor(page)!,
    text: parseColor(text)!,
    inserted: inserted === null ? null : parseColor(inserted),
    border: border === null ? null : parseColor(border),
  });
  const themes = {
    darkModern: theme('#1f1f1f', '#cccccc', 'rgba(155, 185, 85, 0.2)'),
    lightModern: theme('#ffffff', '#3b3b3b', 'rgba(155, 185, 85, 0.2)'),
    solarizedLight: theme('#fdf6e3', '#657b83', 'rgba(155, 185, 85, 0.2)'),
    pageOnly: theme('#ffffff', '#3b3b3b', null),
  };

  it("stands out from the page as far as body text must, starting from the theme's inserted color or text", () => {
    for (const colors of Object.values(themes)) {
      expect(contrast(markColor(colors), colors.page)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("takes the theme's border for inserted text where it gives one, as high contrast themes do", () => {
    const darkHighContrast = theme('#000000', '#ffffff', null, '#33ff2e');
    expect(markColor(darkHighContrast)).toEqual(darkHighContrast.border);
  });
});
