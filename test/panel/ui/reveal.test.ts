// Revealing a heading: where revealHeading puts the cursor, and its panel command.

import { describe, expect, it } from 'vitest';
import { runCommand } from '../../../src/panel/commands/registry';
import { headingTextStart, revealHeadingSpec } from '../../../src/panel/ui/reveal';
import { standInView, stateOf } from '../helpers';

describe('revealHeading', () => {
  it("puts the cursor at the start of an ATX heading's text and scrolls its line to the top", () => {
    const text = 'Intro\n\n## Second heading\n\nBody\n';
    const state = stateOf(`${text}‸`);
    const lineFrom = text.indexOf('##');
    const spec = revealHeadingSpec(state, lineFrom);
    expect(spec.selection).toEqual({ anchor: lineFrom + 3 });
    const effect = [spec.effects].flat()[0] as { value: { range: { head: number }; y: string } };
    expect(effect.value.y).toBe('start');
    expect(effect.value.range.head).toBe(lineFrom);
  });

  it('only scrolls in Rich view', () => {
    const state = stateOf('# One\n\n# Two\n‸', { mode: 'view' });
    const spec = revealHeadingSpec(state, 7);
    expect(spec.selection).toBeUndefined();
    expect([spec.effects].flat()).toHaveLength(1);
  });

  it('finds the text in quoted, empty, Setext and indented headings', () => {
    const start = (text: string, line: number) => {
      const state = stateOf(`${text}‸`);
      return headingTextStart(state, state.doc.line(line).from) - state.doc.line(line).from;
    };
    expect(start('> ### Quoted\n', 1)).toBe(6);
    expect(start('#\n', 1)).toBe(1);
    expect(start('Title\n=====\n', 1)).toBe(0);
    expect(start('   #   Spaced  ##\n', 1)).toBe(7);
    expect(start('Not a heading\n', 1)).toBe(0);
  });

  it('finds a heading far down a long document', () => {
    const body = Array.from({ length: 4000 }, (_, i) => `Line ${i} of filler text.`).join('\n\n');
    const text = `${body}\n\n#### Deep\n`;
    const state = stateOf(`${text}‸`);
    const lineFrom = text.indexOf('#### Deep');
    expect(headingTextStart(state, lineFrom)).toBe(lineFrom + 5);
  });

  it('runs as a panel command and refuses an argument that is not an offset', () => {
    const view = standInView(stateOf('# Top\n\nText\n'));
    expect(runCommand(view, 'revealHeading', { from: 0 })).toBe(true);
    expect(view.state.selection.main.head).toBe(2);
    expect(runCommand(view, 'revealHeading', {})).toBe(false);
    expect(runCommand(view, 'revealHeading', { from: 'x' })).toBe(false);
  });
});
