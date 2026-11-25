import { EditorSelection, type EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorState } from '../../../src/panel/editor';
import { features, type Feature } from '../../../src/panel/features';
import { setModeEffect } from '../../../src/panel/modes';
import { faultedFeatures, FAULT_NOTICE_TEXT } from '../../../src/panel/render/faults';
import {
  blockFeature,
  inlineFeature,
  isBlockRevealed,
  isLineRevealed,
  isRevealed,
  freezeEffect,
  sizeLimitNotice,
  withFullTree,
} from '../../../src/panel/render/framework';
import { Lines, linesOf } from '../../../src/panel/render/lines';
import { Rng } from '../../sync/world';
import { drawHeadless } from '../headless';
import { fakeContext, moveTo, stateOf, visibleText } from '../helpers';

describe('reveal questions', () => {
  const text = '# Head\n\nSome **bold** text.\n';
  const bold = text.indexOf('**bold**');

  it('answer for a selection touching the node or its line, in Rich editor', () => {
    const state = stateOf(text.slice(0, bold + 3) + '‸' + text.slice(bold + 3));
    expect(isRevealed(state, bold, bold + 8)).toBe(true);
    expect(isRevealed(state, 0, 6)).toBe(false);
    expect(isLineRevealed(state, bold)).toBe(true);
    expect(isLineRevealed(state, 0)).toBe(false);
    expect(isBlockRevealed(state, bold - 2, bold)).toBe(true);
  });

  it('count both edges as touching', () => {
    const at = (pos: number) => moveTo(stateOf(text), pos);
    expect(isRevealed(at(bold), bold, bold + 8)).toBe(true);
    expect(isRevealed(at(bold + 8), bold, bold + 8)).toBe(true);
    expect(isRevealed(at(bold - 1), bold, bold + 8)).toBe(false);
  });

  it('nothing is revealed in Rich view', () => {
    let state = stateOf(text.slice(0, bold + 3) + '‸' + text.slice(bold + 3), { mode: 'view' });
    expect(isRevealed(state, bold, bold + 8)).toBe(false);
    expect(isLineRevealed(state, bold)).toBe(false);
    expect(isBlockRevealed(state, 0, text.length)).toBe(false);
    expect(visibleText(state)).not.toContain('**');
    expect(visibleText(state)).not.toContain('#');
    state = state.update({ effects: setModeEffect.of('edit') }).state;
    expect(isRevealed(state, bold, bold + 8)).toBe(true);
  });

  it('are frozen while a mouse button is down, and follow the selection after', () => {
    let state = stateOf('‸' + text);
    state = state.update({ effects: freezeEffect.of(state.selection) }).state;
    state = state.update({ selection: { anchor: bold + 3 } }).state;
    expect(isRevealed(state, bold, bold + 8)).toBe(false);
    state = state.update({ effects: freezeEffect.of(null) }).state;
    expect(isRevealed(state, bold, bold + 8)).toBe(true);
  });

  it('a range inside a child reveals the child only', () => {
    const t = 'a **b *c* d** e';
    const strong = t.indexOf('**b');
    const em = t.indexOf('*c*');
    const state = moveTo(stateOf(t), em + 1);
    const inner = [{ from: em, to: em + 3 }];
    expect(isRevealed(state, strong, strong + 12, inner)).toBe(false);
    expect(isRevealed(state, em, em + 3)).toBe(true);
    expect(isRevealed(moveTo(state, strong + 2), strong, strong + 12, inner)).toBe(true);
  });
});

describe('the line table', () => {
  it('follows every edit as a fresh read of the text would', () => {
    const rng = new Rng(5);
    const pieces = ['', 'a', 'xyz', '\n', '\n\n', 'ab\ncd', '\nq\n'];
    let state = stateOf('one\ntwo\n\nfour five\nsix\n');
    for (let step = 0; step < 300; step++) {
      // One to three changes in one transaction, in order and apart.
      const changes: { from: number; to: number; insert: string }[] = [];
      let pos = 0;
      for (let n = 1 + rng.int(3); n > 0 && pos <= state.doc.length; n--) {
        const from = pos + rng.int(state.doc.length - pos + 1);
        const to = Math.min(state.doc.length, from + rng.int(4));
        changes.push({ from, to, insert: rng.pick(pieces) });
        pos = to + 1;
      }
      state = state.update({ changes }).state;
      const kept = linesOf(state.doc);
      const fresh = Lines.of(state.doc);
      expect(kept.count).toBe(fresh.count);
      for (let line = 1; line <= fresh.count; line++) expect(kept.get(line)).toEqual(fresh.get(line));
    }
  });
});

describe('block features', () => {
  it('do not draw again on a cursor move that changes none of their answers', () => {
    const text = '# One\n\nPlain paragraph here.\n\nAnother paragraph.\n\n## Two\n';
    const headings = (s: EditorState) => drawHeadless(s).find((f) => f.feature === 'headings')!.decorations;
    const start = stateOf(text);
    const p1 = text.indexOf('Plain') + 2;
    const p2 = text.indexOf('Another') + 2;
    const a = moveTo(start, p1);
    const b = moveTo(a, p2);
    expect(headings(b)).toBe(headings(a));
    const c = moveTo(b, 2);
    expect(headings(c)).not.toBe(headings(b));
  });
});

describe('fault isolation', () => {
  const added: Feature[] = [];
  afterEach(() => {
    for (const f of added) features.splice(features.indexOf(f), 1);
    added.length = 0;
  });

  function addFeature(f: Feature): void {
    features.push(f);
    added.push(f);
  }

  it('a throwing feature leaves the others drawing, is logged once and raises one notice', () => {
    addFeature({
      id: 'boomBlock',
      extension: () =>
        blockFeature('boomBlock', () => {
          throw new Error('block boom');
        }),
    });
    addFeature({
      id: 'boomInline',
      extension: () =>
        inlineFeature('boomInline', () => {
          throw new Error('inline boom');
        }),
    });
    const { ctx, logs, notices } = fakeContext();
    let state = withFullTree(
      createEditorState({ ctx, text: '# Title\n\nSome **bold**.\n', mode: 'view', selection: { anchor: 0, head: 0 } }),
    );
    drawHeadless(state);
    // The parse an edit runs stops after CodeMirror's 20 ms, short of the text on a busy machine,
    // and a headless state has no view to carry it on: the test finishes it.
    state = withFullTree(state.update({ changes: { from: state.doc.length, insert: 'more' } }).state);
    const drawnNow = drawHeadless(state);

    expect(faultedFeatures(ctx).sort()).toEqual(['boomBlock', 'boomInline']);
    expect(drawnNow.find((f) => f.feature === 'boomBlock')!.decorations.size).toBe(0);
    expect(drawnNow.find((f) => f.feature === 'boomInline')!.decorations.size).toBe(0);
    expect(drawnNow.find((f) => f.feature === 'headings')!.decorations.size).toBeGreaterThan(0);
    expect(visibleText(state)).not.toContain('**');
    expect(logs.filter((l) => l.level === 'error').length).toBe(2);
    expect(notices.filter((n) => n.text === FAULT_NOTICE_TEXT).length).toBe(2);
    expect(notices[0]!.actions?.map((a) => a.label)).toEqual(['Reload tab']);
  });
});

describe('the editor state', () => {
  it('gives back exactly the text it was loaded with', () => {
    const texts = [
      '',
      'no final newline',
      'trailing spaces   \n\ttabs\t\n\n\n',
      '---\ntitle: x\n---\n# H\n\n- [ ] a\n  - [x] b\n\n```js\nlet x = 1;\n```\n',
      'unicode: é中😀 ​ zero width\n',
      '> quote\n>\n> > nested\n\n| a | b |\n|---|---|\n| [[x\\|y]] | 2 |\n',
    ];
    const { ctx } = fakeContext();
    for (const text of texts) {
      for (const mode of ['view', 'edit'] as const) {
        const state = withFullTree(createEditorState({ ctx, text, mode }));
        drawHeadless(state);
        expect(state.doc.toString()).toBe(text);
      }
    }
  });

  it('binds no undo or redo key', () => {
    const state = stateOf('x');
    const keys = state
      .facet(keymap)
      .flat()
      .flatMap((b) => [b.key, b.mac, b.win, b.linux]);
    for (const key of ['Mod-z', 'Mod-y', 'Mod-Shift-z', 'Mod-u', 'Alt-u']) expect(keys).not.toContain(key);
  });

  it('draws nothing over the size limit, and draws again under it', () => {
    const { ctx } = fakeContext({ settings: { maxRichFileSizeKb: 1 } });
    const big = '# Title\n\n' + '**bold** '.repeat(200);
    const state = withFullTree(createEditorState({ ctx, text: big, mode: 'view', selection: { anchor: 0, head: 0 } }));
    expect(drawHeadless(state).every((f) => f.decorations.size === 0)).toBe(true);
    const smaller = state.update({ changes: { from: 20, to: state.doc.length } }).state;
    expect(drawHeadless(smaller).some((f) => f.decorations.size > 0)).toBe(true);
  });

  it('says a note over the size limit is shown as plain markdown, and offers to change the limit', () => {
    const { ctx, posted } = fakeContext({ settings: { maxRichFileSizeKb: 2048 } });
    const notice = sizeLimitNotice(ctx);
    expect(notice.text).toBe('test.md is over 2048 KB, so it is shown as plain markdown.');
    expect(notice.actions?.map((a) => a.label)).toEqual(['Change limit']);
    void notice.actions![0]!.run();
    expect(posted).toEqual([{ type: 'openSetting', id: 'tandemMarkdown.maxRichFileSizeKb' }]);
  });

  it('keeps a given selection', () => {
    const { ctx } = fakeContext();
    const state = createEditorState({ ctx, text: 'abcdef', mode: 'edit', selection: { anchor: 1, head: 4 } });
    expect(state.selection.main).toEqual(EditorSelection.range(1, 4));
  });
});
