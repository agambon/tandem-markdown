// Headless helpers for the editing command tests.
//
// A state here has the panel's parser (with our syntax extensions), the modes, the panel
// context and the typing feature (its keymap, filters and the empty-pair field), and nothing
// from other features, so a fault in another feature cannot fail these tests.
//
// Selections are written into the text as test/panel/helpers.ts reads them (`parseMarked`).

import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { expect } from 'vitest';
import type { Mode, PanelSettings } from '../../../src/core/protocol';
import type { StateCommand } from '../../../src/panel/commands/base';
import { typing } from '../../../src/panel/commands/typing';
import { panelContext, type PanelContext } from '../../../src/panel/context';
import { settingsExtensions } from '../../../src/panel/editor';
import { markdownLanguage } from '../../../src/panel/markdown';
import { modes } from '../../../src/panel/modes';
import { withFullTree } from '../../../src/panel/render/framework';
import { fakeContext, parseMarked } from '../helpers';

export interface StateOptions {
  mode?: Mode;
  readOnly?: boolean;
  settings?: Partial<PanelSettings>;
  /** False keeps the tree the state is made with, which may stop short; the default parses to the end. */
  fullTree?: boolean;
}

function contextFor(options: StateOptions = {}): PanelContext {
  return fakeContext({ readOnly: options.readOnly, settings: options.settings }).ctx;
}

/** A state over the marked text, parsed to the end unless `fullTree` is false. */
export function stateWith(marked: string, options: StateOptions = {}): EditorState {
  const { doc, ranges } = parseMarked(marked);
  const ctx = contextFor(options);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges, ranges.length - 1),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      modes(options.mode ?? 'edit'),
      markdownLanguage(),
      panelContext.of(ctx),
      settingsExtensions(ctx.settings),
      typing.extension!(ctx),
    ],
  });
  return options.fullTree === false ? state : withFullTree(state);
}

/** The document with its selection written back in. */
export function marked(state: EditorState): string {
  const marks: { pos: number; text: string; order: number }[] = [];
  state.selection.ranges.forEach((r, i) => {
    if (r.empty) marks.push({ pos: r.head, text: '‸', order: i * 2 });
    else {
      marks.push({ pos: r.anchor, text: '«', order: i * 2 });
      marks.push({ pos: r.head, text: '»', order: i * 2 + 1 });
    }
  });
  marks.sort((a, b) => b.pos - a.pos || b.order - a.order);
  let text = state.doc.toString();
  for (const m of marks) text = text.slice(0, m.pos) + m.text + text.slice(m.pos);
  return text;
}

/** The state after `tr`, parsed to the end. */
export function after(tr: Transaction): EditorState {
  return withFullTree(tr.state);
}

/** Runs a command on the marked text: the marked result, or null when the command does not apply. */
export function run(command: StateCommand, text: string, args?: unknown, options: StateOptions = {}): string | null {
  const tr = command(stateWith(text, options), args);
  return tr ? marked(tr.state) : null;
}

/** Runs several commands in turn; a command that does not apply leaves the state as it is. */
export function runAll(
  commands: (StateCommand | ((s: EditorState) => Transaction | null))[],
  text: string,
  options: StateOptions = {},
): string {
  let state = stateWith(text, options);
  for (const command of commands) {
    const tr = command(state);
    if (tr) state = after(tr);
  }
  return marked(state);
}

const ABOVE = 'Line above.\n\n';
const BELOW = '\n\nLine below.';

/**
 * Checks a case twice: on its own, and with a paragraph above and below it, which must come
 * through byte for byte (the command touches only the lines it should).
 */
export function expectCase(
  command: StateCommand,
  before: string,
  expected: string | null,
  args?: unknown,
  options: StateOptions & { alone?: boolean } = {},
): void {
  expect(run(command, before, args, options)).toBe(expected);
  if (options.alone) return;
  const framed = run(command, ABOVE + before + BELOW, args, options);
  expect(framed).toBe(expected === null ? null : ABOVE + expected + BELOW);
}

/** A cursor moved to `pos` by the user (a selection-only transaction). */
export function moveCursor(pos: number | ((state: EditorState) => number)): (state: EditorState) => Transaction {
  return (state) =>
    state.update({ selection: { anchor: typeof pos === 'number' ? pos : pos(state) }, userEvent: 'select' });
}

/** Text typed at the cursor, as the editor does it. */
export function typeText(text: string): (state: EditorState) => Transaction {
  return (state) => state.update(state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
}
