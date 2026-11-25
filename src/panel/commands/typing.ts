// Typing rules: a keymap, an input handler and a transaction filter.
//
// Enter      continues a list item, task or quote, and ends an empty one (`enter`).
// Backspace  at the start of a heading, task, list item or quote, removes its mark (`backspace`).
// Tab        indents list items, code lines or text; Shift+Tab outdents them (`tab`).
// Typing a mark character with text selected wraps the selection in it (`wrapSelection`).
// After an edit, numbered lists are renumbered, an emptied phrase loses its marks, and an empty
// pair a command left goes when the cursor leaves it (`afterEdit`).
// None of this applies inside code blocks, code spans or front matter, nor to changes that
// arrive from the host.

import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { getIndentUnit, indentUnit } from '@codemirror/language';
import {
  countColumn,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type ChangeSpec,
  type Extension,
  type StateCommand as CMStateCommand,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { codeAt, PARSE_PAST, treeFor, treeForLine } from '../markdown/tree';
import { canEdit } from '../modes';
import { parsedTo } from './base';
import { headingChanges } from './blocks';
import { pairField, removePairMember, setPairsEffect } from './inline';
import { columnOf, lineInfo, touchedLines, type LineMarks } from './lineInfo';
import { indentListItems, listItemAt, renumberAfter } from './lists';

/**
 * Runs one of lang-markdown's `{ state, dispatch }` commands, which read the tree stored in the
 * state, on `state` parsed to `upto`, and gives what it does as a transaction on `state`.
 */
function capture(command: CMStateCommand, state: EditorState, upto: number): Transaction | null {
  const made: Transaction[] = [];
  command({ state: parsedTo(state, upto), dispatch: (tr) => made.push(tr) });
  const tr = made[0];
  if (!tr) return null;
  const userEvent = tr.annotation(Transaction.userEvent);
  return state.update({
    changes: tr.changes,
    selection: tr.selection,
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent === undefined ? {} : { userEvent }),
  });
}

/**
 * lang-markdown's insertNewlineContinueMarkup with `nonTightLists: false`: its default turns an
 * Enter on an empty second item into a loose list instead of ending it. It needs two empty
 * quote lines in a row to end a quote, so `endEmptyQuote` is tried first.
 */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** The main cursor, when the selection is one or more cursors (no selected text). */
function cursorOnly(state: EditorState): number | null {
  return state.selection.ranges.every((r) => r.empty) ? state.selection.main.head : null;
}

// ---------------------------------------------------------------------------
// Enter

/** Enter on a quote line with no text ends that quote level there. */
function endEmptyQuote(state: EditorState, info: LineMarks, pos: number): Transaction | null {
  if (!info.blank || !info.quoteMarks.length || info.marker || pos < info.quoteMarks[info.quoteMarks.length - 1]!.to)
    return null;
  const last = info.quoteMarks[info.quoteMarks.length - 1]!;
  return state.update({
    changes: { from: last.from, to: info.line.to },
    selection: EditorSelection.cursor(last.from),
    userEvent: 'input',
    scrollIntoView: true,
  });
}

/**
 * On a later line of a numbered item, not its marker's line, Enter only continues the item, but
 * lang-markdown renumbers the items after it as though it had started one. There, what it changes
 * below the cursor's line is left out, so the numbers after it stay as they were. Those changes
 * all come after the cursor, so the selection it gives still holds.
 */
function continuesItemOnly(state: EditorState, info: LineMarks, tr: Transaction): Transaction {
  if (info.marker || info.owner?.parent?.name !== 'OrderedList') return tr;
  const kept: ChangeSpec[] = [];
  let below = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > info.line.to) below = true;
    else kept.push({ from: fromA, to: toA, insert: inserted });
  });
  if (!below) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  return state.update({
    changes: kept,
    selection: tr.selection,
    scrollIntoView: tr.scrollIntoView,
    ...(userEvent === undefined ? {} : { userEvent }),
  });
}

/**
 * What Enter does, or null for a plain new line: in a list item, task or quote, continues it;
 * on an empty one, ends it.
 */
export function enter(state: EditorState): Transaction | null {
  if (!canEdit(state)) return null;
  const pos = cursorOnly(state);
  if (pos === null) return null;
  const upto = state.doc.lineAt(pos).to + PARSE_PAST;
  const tree = treeFor(state, upto);
  if (codeAt(tree, pos)) return null;
  if (state.selection.ranges.length !== 1) return capture(continueMarkup, state, upto);
  const info = lineInfo(state, tree, state.doc.lineAt(pos));
  const quoteEnd = endEmptyQuote(state, info, pos);
  if (quoteEnd) return quoteEnd;
  const tr = capture(continueMarkup, state, upto);
  return tr && continuesItemOnly(state, info, tr);
}

// ---------------------------------------------------------------------------
// Backspace

/**
 * What Backspace does, or null for a plain deletion. At the start of a heading's text it
 * removes the heading mark (the line stays a paragraph of its own); at the start of a task's
 * text, `[ ]` (it stays a list item); at the start of a list item or quote, lang-markdown's
 * deleteMarkupBackward removes the marker. In an empty pair a command left, it removes the pair.
 */
export function backspace(state: EditorState): Transaction | null {
  if (!canEdit(state)) return null;
  const pos = cursorOnly(state);
  if (pos === null) return null;
  const stack = state.field(pairField, false);
  if (stack && stack.cursor === pos && state.selection.ranges.length === 1) {
    const removed = removePairMember(stack, stack.members.length - 1);
    return state.update({
      changes: removed.changes,
      selection: EditorSelection.cursor(removed.cursor),
      effects: setPairsEffect.of(removed.stack),
      userEvent: 'delete.backward',
    });
  }
  const upto = state.doc.lineAt(pos).to + PARSE_PAST;
  const tree = treeFor(state, upto);
  if (codeAt(tree, pos)) return null;
  if (state.selection.ranges.length === 1) {
    const info = lineInfo(state, tree, state.doc.lineAt(pos));
    const heading = info.heading;
    const atHeadingStart =
      heading &&
      ((!heading.setext && pos === heading.contentFrom && pos > heading.markFrom) ||
        (heading.setext &&
          !info.setextUnderline &&
          info.line.from === state.doc.lineAt(heading.node.from).from &&
          pos === info.contentFrom));
    if (atHeadingStart) {
      const changes = headingChanges(state, tree, [info], () => 0);
      if (changes.length) return state.update({ changes, userEvent: 'delete.backward', scrollIntoView: true });
    }
    const task = info.marker?.task;
    if (task && pos === info.marker!.to) {
      return state.update({
        changes: { from: task.from, to: info.marker!.to },
        userEvent: 'delete.backward',
        scrollIntoView: true,
      });
    }
  }
  return capture(deleteMarkupBackward, state, upto);
}

// ---------------------------------------------------------------------------
// Tab

/** The indent Tab inserts at `pos`: a tab, or spaces to the next tab stop. */
function indentAt(state: EditorState, pos: number): string {
  const unit = state.facet(indentUnit);
  if (unit === '\t') return '\t';
  const line = state.doc.lineAt(pos);
  const column = countColumn(line.text.slice(0, pos - line.from), state.tabSize);
  const width = getIndentUnit(state);
  return ' '.repeat(width - (column % width));
}

function singleLines(state: EditorState): boolean {
  return state.selection.ranges.every((r) => state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number);
}

/** Tab with only cursors or one-line selections: the indent replaces each. */
function insertIndent(state: EditorState): Transaction {
  return state.update(
    state.changeByRange((range) => {
      const insert = indentAt(state, range.from);
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    }),
    { userEvent: 'input.indent', scrollIntoView: true },
  );
}

/**
 * Indents (`dir` 1) or outdents (-1) the touched lines by one indent unit, each after its
 * quote marks, never taking a line's indent below `floor(line)` columns.
 */
function shiftLines(
  state: EditorState,
  lines: LineMarks[],
  dir: 1 | -1,
  floor: (info: LineMarks) => number,
): Transaction | null {
  const unit = state.facet(indentUnit);
  const width = getIndentUnit(state);
  const changes: ChangeSpec[] = [];
  for (const info of lines) {
    if (info.blank) continue;
    if (dir > 0) {
      changes.push({ from: info.quoteEnd, insert: unit });
      continue;
    }
    const lead = state.doc.sliceString(info.quoteEnd, info.textFrom);
    const leadColumns = countColumn(lead, state.tabSize);
    const room = Math.min(width, leadColumns - floor(info));
    if (room <= 0) continue;
    // Take whole characters from the end of the leading whitespace until `room` columns are gone.
    let cut = lead.length;
    while (cut > 0 && leadColumns - countColumn(lead.slice(0, cut), state.tabSize) < room) cut--;
    if (cut < lead.length) changes.push({ from: info.quoteEnd + cut, to: info.textFrom });
  }
  if (!changes.length) return null;
  return state.update({ changes, userEvent: dir > 0 ? 'indent.more' : 'indent.less', scrollIntoView: true });
}

/** Tab in a fenced or indented code block. */
function codeTab(state: EditorState, code: SyntaxNode, dir: 1 | -1): Transaction | null {
  if (dir > 0 && singleLines(state)) return insertIndent(state);
  const { lines } = touchedLines(state);
  const doc = state.doc;
  const fenceLines = new Set<number>();
  if (code.name === 'FencedCode') {
    fenceLines.add(doc.lineAt(code.from).number);
    const close = code.lastChild;
    if (close && close.name === 'CodeMark' && close.from > code.from) fenceLines.add(doc.lineAt(close.from).number);
  }
  const inBlock = lines.filter(
    (l) => l.line.from >= doc.lineAt(code.from).from && l.line.from <= code.to && !fenceLines.has(l.line.number),
  );
  // Code never moves left of where its block starts.
  const blockColumn = columnOf(state, code.from);
  return shiftLines(state, inBlock, dir, (info) => Math.max(0, blockColumn - (info.quoteEnd - info.line.from)));
}

/**
 * What Tab (`dir` 1) or Shift+Tab (-1) does: in a list, indents or outdents the items touched
 * with their children (`indentListItems`); in a code block, the selected lines by the tab
 * setting; elsewhere Tab inserts that indent (a selection over several lines is indented).
 * Null means nothing changes, and Rich editor still takes the key, so focus stays in the
 * editor. With Tab Moves Focus on (`ui/tabFocus.ts`) CodeMirror leaves Tab and Shift+Tab to the
 * browser and none of this runs.
 */
export function tab(state: EditorState, dir: 1 | -1): Transaction | null {
  if (!canEdit(state)) return null;
  const head = state.selection.main.head;
  const tree = treeForLine(state, head);
  const code = codeAt(tree, head);
  if (code?.kind === 'block' && (code.node.name === 'FencedCode' || code.node.name === 'CodeBlock'))
    return codeTab(state, code.node, dir);
  if (!code && listItemAt(state)) return indentListItems(state, dir);
  if (dir > 0 && singleLines(state)) return insertIndent(state);
  return shiftLines(state, touchedLines(state).lines, dir, () => 0);
}

// ---------------------------------------------------------------------------
// Typing a mark over a selection

const WRAPS: Record<string, [string, string]> = {
  '*': ['*', '*'],
  _: ['_', '_'],
  '`': ['`', '`'],
  '~': ['~', '~'],
  '=': ['=', '='],
  '[': ['[', ']'],
  '(': ['(', ')'],
  '"': ['"', '"'],
};

/** Typing `char` with text selected: wraps each selection in it, the text still selected. Null when the rule does not apply. */
export function wrapSelection(state: EditorState, char: string): Transaction | null {
  const pair = WRAPS[char];
  if (!pair || !canEdit(state)) return null;
  const ranges = state.selection.ranges;
  if (ranges.every((r) => r.empty)) return null;
  const tree = treeForLine(state, ranges[ranges.length - 1]!.to);
  for (const r of ranges) if (!r.empty && (codeAt(tree, r.from) || codeAt(tree, r.to))) return null;
  const [open, close] = pair;
  return state.update(
    state.changeByRange((range) => {
      if (range.empty)
        return { changes: { from: range.from, insert: char }, range: EditorSelection.cursor(range.from + char.length) };
      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: close },
        ],
        range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
      };
    }),
    { userEvent: 'input.type', scrollIntoView: true },
  );
}

// ---------------------------------------------------------------------------
// After an edit

/** Phrases whose marks go when all their text is deleted. */
const PHRASES = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'Highlight', 'InlineCode']);

/** Deletions that empty a phrase: its marks too, in the coordinates of the edit's result. */
function emptiedMarks(tr: Transaction): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  let end = 0;
  tr.changes.iterChangedRanges((_fromA, toA) => (end = toA));
  const tree = treeForLine(tr.startState, end);
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length || fromA === toA) return;
    tree.iterate({
      from: fromA,
      to: toA,
      enter: (ref) => {
        if (!PHRASES.has(ref.name)) return true;
        const open = ref.node.firstChild;
        const close = ref.node.lastChild;
        if (!open || !close || open.from === close.from) return true;
        if (open.to >= close.from) return true;
        if (fromA < ref.from || toA > ref.to || fromA > open.to || toA < close.from) return true;
        if (fromA === ref.from && toA === ref.to) return false;
        if (fromA > ref.from) out.push({ from: tr.changes.mapPos(ref.from, 1), to: tr.changes.mapPos(fromA, -1) });
        if (toA < ref.to) out.push({ from: tr.changes.mapPos(toA, 1), to: tr.changes.mapPos(ref.to, -1) });
        return false;
      },
    });
  });
  return out;
}

/** When the cursor leaves an empty pair a command left, without typing in it: its removal. */
function leftPair(tr: Transaction): ChangeSpec[] {
  const stack = tr.startState.field(pairField, false);
  if (!stack || tr.effects.some((e) => e.is(setPairsEffect))) return [];
  let inside = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < stack.to && toA > stack.from) inside = true;
  });
  if (inside) return [];
  const from = tr.changes.mapPos(stack.from, 1);
  const cursor = tr.changes.mapPos(stack.cursor, 1);
  const to = tr.changes.mapPos(stack.to, -1);
  const main = tr.newSelection.main;
  if (main.empty && main.head === cursor) return [];
  const opens = stack.members.map((m) => m.open).join('');
  const closes = [...stack.members]
    .reverse()
    .map((m) => m.close)
    .join('');
  if (tr.newDoc.sliceString(from, to) !== opens + closes) return [];
  return [{ from, to }];
}

let filterFaultLogged = false;

/**
 * After an edit: a numbered list is renumbered when it was numbered in sequence before it;
 * deleting all the text inside a phrase removes its marks; an empty pair a command left is
 * removed when the cursor leaves it without typing.
 */
const afterEdit = EditorState.transactionFilter.of((tr) => {
  if (tr.annotation(Transaction.userEvent) === undefined || tr.annotation(Transaction.remote)) return tr;
  if (!tr.docChanged && !tr.startState.field(pairField, false)) return tr;
  if (!canEdit(tr.startState)) return tr;
  try {
    const extra: ChangeSpec[] = [];
    if (tr.docChanged && tr.isUserEvent('delete')) extra.push(...emptiedMarks(tr));
    extra.push(...leftPair(tr));
    if (tr.docChanged) extra.push(...renumberAfter(tr));
    if (!extra.length) return tr;
    return [tr, { changes: extra, sequential: true }];
  } catch (error) {
    if (!filterFaultLogged) {
      filterFaultLogged = true;
      const ctx = tr.startState.facet(panelContext);
      if (ctx) ctx.log('error', 'An editing rule failed; the edit went through without it', error);
      else console.error('Tandem Markdown: an editing rule failed', error);
    }
    return tr;
  }
});

// ---------------------------------------------------------------------------
// The feature

function dispatched(view: EditorView, tr: Transaction | null): boolean {
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

const typingKeymap = Prec.high(
  keymap.of([
    { key: 'Enter', run: (view) => dispatched(view, enter(view.state)) },
    { key: 'Backspace', run: (view) => dispatched(view, backspace(view.state)) },
    {
      key: 'Tab',
      run: (view) => {
        if (!canEdit(view.state)) return false;
        const tr = tab(view.state, 1);
        if (tr) view.dispatch(tr);
        return true;
      },
    },
    {
      key: 'Shift-Tab',
      run: (view) => {
        if (!canEdit(view.state)) return false;
        const tr = tab(view.state, -1);
        if (tr) view.dispatch(tr);
        return true;
      },
    },
  ]),
);

const wrapOnType = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || text.length !== 1) return false;
  const main = view.state.selection.main;
  if (main.empty || main.from !== from || main.to !== to) return false;
  return dispatched(view, wrapSelection(view.state, text));
});

export const typing: Feature = {
  id: 'typing',
  extension: (): Extension => [pairField, typingKeymap, wrapOnType, afterEdit],
};
