// Block commands: setHeading (`args.level` 0 to 6; 0 is a paragraph), headingUp, headingDown,
// toggleQuote, insertCodeBlock, insertRule, insertImage. Where a new block goes is placeBlock.ts's.
//
// They act on every line the selection touches; blank lines inside a multi-line selection
// are skipped (a quote also marks the blank lines between its lines, so it stays one quote).
// A Setext heading is rewritten in `#` form when its level changes. A heading that becomes a
// paragraph gets a blank line between it and a neighboring paragraph it would otherwise run
// into, so it stays a paragraph of its own.

import { EditorSelection, type ChangeSpec, type EditorState, type Line } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { codeAt, treeForLine } from '../markdown/tree';
import { linkDestination, longestRun } from '../markdown/writing';
import { canEdit } from '../modes';
import { asPanelCommand, COMMAND_EVENT, type StateCommand } from './base';
import { containerPrefix, cutsRawBlock, lineInfo, marksHold, touchedLines, type LineMarks } from './lineInfo';
import { blankLinesAround, blockAtLine, containerAt, lineOfItsOwn } from './placeBlock';
import type { PanelCommand } from './registry';

// ---------------------------------------------------------------------------
// Headings

/** A blank line beside `info`'s line in the same quotes and list items (`containerPrefix`, trimmed). */
function blankPrefix(state: EditorState, tree: Tree, info: LineMarks): string {
  return containerPrefix(state, tree, info).trimEnd();
}

/** The line's text will run on from the line before it, if that line is paragraph text. */
function isParagraphText(state: EditorState, tree: Tree, line: Line): boolean {
  const info = lineInfo(state, tree, line);
  if (info.blank || info.code || info.table || info.rule || info.heading) return false;
  for (let n: SyntaxNode | null = tree.resolveInner(info.contentFrom, 1); n; n = n.parent) {
    if (n.name === 'Paragraph') return true;
    if (/^(Document|ListItem|Blockquote|BulletList|OrderedList)$/.test(n.name)) return false;
  }
  return false;
}

/**
 * The changes that give each heading or text line in `lines` the level `levelFor` asks for
 * (null leaves it). Exported for typing.ts, whose Backspace at a heading's start uses it.
 */
export function headingChanges(
  state: EditorState,
  tree: Tree,
  lines: LineMarks[],
  levelFor: (current: number) => number | null,
): ChangeSpec[] {
  const doc = state.doc;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  /** Lines that end up paragraph text: first and last line number of each. */
  const paragraphs: { first: number; last: number; prefix: string }[] = [];
  /** Lines that end up headings. */
  const headings = new Set<number>();
  for (const info of lines) {
    if (info.blank || info.code || info.table || info.rule) continue;
    const heading = info.heading;
    if (heading && heading.setext && heading.underline) {
      if (seen.has(heading.node.from)) continue;
      seen.add(heading.node.from);
      const target = levelFor(heading.level);
      if (target === null || target === heading.level) continue;
      const firstText = doc.lineAt(heading.node.from);
      const underline = heading.underline;
      const lastText = doc.line(underline.number - 1);
      const firstInfo = lineInfo(state, tree, firstText);
      if (target === 0) {
        const next = underline.number < doc.lines ? doc.line(underline.number + 1) : null;
        if (next && isParagraphText(state, tree, next)) {
          changes.push({
            from: underline.from,
            to: underline.to,
            insert: blankPrefix(state, tree, lineInfo(state, tree, underline)),
          });
        } else {
          changes.push({ from: lastText.to, to: underline.to });
        }
        paragraphs.push({
          first: firstText.number,
          last: lastText.number,
          prefix: blankPrefix(state, tree, firstInfo),
        });
      } else {
        // `#` form is one line: the text lines join with a space and the underline goes. The
        // text itself is not rewritten, so the cursor stays where it was in it.
        changes.push({ from: firstInfo.contentFrom, insert: `${'#'.repeat(target)} ` });
        let prev = firstInfo;
        for (let n = firstText.number + 1; n < underline.number; n++) {
          const next = lineInfo(state, tree, doc.line(n));
          changes.push({ from: prev.contentTo, to: next.contentFrom, insert: ' ' });
          prev = next;
        }
        changes.push({ from: prev.contentTo, to: underline.to });
        headings.add(firstText.number);
      }
    } else if (heading && !heading.setext) {
      const target = levelFor(heading.level);
      if (target === null || target === heading.level) continue;
      if (target === 0) {
        changes.push({ from: heading.markFrom, to: heading.contentFrom });
        if (heading.close) changes.push({ from: heading.contentTo, to: heading.close.to });
        paragraphs.push({ first: info.line.number, last: info.line.number, prefix: blankPrefix(state, tree, info) });
      } else {
        const marks = '#'.repeat(target);
        const space = heading.contentFrom === heading.markTo && heading.contentFrom < heading.contentTo ? ' ' : '';
        changes.push({ from: heading.markFrom, to: heading.markTo, insert: marks + space });
        if (heading.close) changes.push({ from: heading.close.from, to: heading.close.to, insert: marks });
        headings.add(info.line.number);
      }
    } else {
      const target = levelFor(0);
      if (!target) continue;
      changes.push({ from: info.contentFrom, insert: `${'#'.repeat(target)} ` });
      headings.add(info.line.number);
    }
  }

  // Keep a new paragraph from running into the paragraph text beside it.
  const becomesParagraph = (n: number) => paragraphs.some((p) => p.first <= n && n <= p.last);
  const blankAfter = new Map<number, string>();
  for (const p of paragraphs) {
    const before = p.first > 1 ? doc.line(p.first - 1) : null;
    if (
      before &&
      !headings.has(before.number) &&
      !becomesParagraph(before.number) &&
      isParagraphText(state, tree, before)
    ) {
      blankAfter.set(before.number, p.prefix);
    }
    const after = p.last < doc.lines ? doc.line(p.last + 1) : null;
    if (
      after &&
      !headings.has(after.number) &&
      (becomesParagraph(after.number) || isParagraphText(state, tree, after))
    ) {
      const afterInfo = lineInfo(state, tree, after);
      if (
        !afterInfo.setextUnderline &&
        !afterInfo.marker &&
        afterInfo.quoteMarks.length <= lineInfo(state, tree, doc.line(p.last)).quoteMarks.length
      ) {
        blankAfter.set(p.last, p.prefix);
      }
    }
  }
  for (const [n, prefix] of blankAfter) changes.push({ from: doc.line(n).to, insert: `\n${prefix}` });
  return changes;
}

function headingCommand(levelFor: (current: number) => number | null): StateCommand {
  return (state) => {
    if (!canEdit(state)) return null;
    const { tree, lines } = touchedLines(state);
    if (cutsRawBlock(state, lines)) return null;
    const changes = headingChanges(state, tree, lines, levelFor);
    if (!changes.length) return null;
    return state.update({ changes, userEvent: COMMAND_EVENT, scrollIntoView: true });
  };
}

/** `args.level`: 0 makes a paragraph, 1 to 6 a heading of that level. */
export const setHeading: StateCommand = (state, args) => {
  const level = (args as { level?: unknown } | undefined)?.level;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 6) return null;
  return headingCommand(() => level)(state);
};

/**
 * headingUp and headingDown follow the bindings they come from (Ctrl+Shift+] and Ctrl+Shift+[
 * in Markdown All in One): up adds a `#` (paragraph to Heading 1, Heading 1 to Heading 2, up
 * to 6); down removes one (Heading 1 back to a paragraph).
 */
export const headingUp: StateCommand = headingCommand((current) => (current >= 6 ? null : current + 1));
export const headingDown: StateCommand = headingCommand((current) => (current <= 0 ? null : current - 1));

/** The heading level of the main selection's line: 0 for a paragraph. */
export function headingLevelAt(state: EditorState, tree: Tree): number {
  return lineInfo(state, tree, state.doc.lineAt(state.selection.main.head)).heading?.level ?? 0;
}

// ---------------------------------------------------------------------------
// Quotes

/**
 * Quote: when every touched line with text is already in a quote, one level of `>` comes
 * off each touched line; otherwise `> ` goes in front of each line not yet quoted, and `>`
 * on the blank lines between them, so they make one quote. On a blank line alone it starts
 * an empty quote there. Nothing when the lines take in only part of a code block.
 */
export const toggleQuote: StateCommand = (state) => {
  if (!canEdit(state)) return null;
  const { lines } = touchedLines(state);
  if (cutsRawBlock(state, lines)) return null;
  const usable = lines.filter((l) => !(l.code && l.code.name === 'Frontmatter'));
  if (!usable.length) return null;
  const withText = usable.filter((l) => !l.blank);
  const changes: ChangeSpec[] = [];
  const doc = state.doc;
  const removeOne = (l: LineMarks) => {
    const mark = l.quoteMarks[0];
    if (!mark) return;
    const space = doc.sliceString(mark.to, mark.to + 1) === ' ' ? 1 : 0;
    changes.push({ from: mark.from, to: mark.to + space });
  };
  if (!withText.length) {
    // Blank lines only: toggle a quote mark on them.
    for (const l of usable) {
      if (l.quoteMarks.length) removeOne(l);
      else changes.push({ from: l.line.from, insert: '> ' });
    }
  } else if (withText.every((l) => l.inQuote)) {
    for (const l of usable) removeOne(l);
  } else {
    const firstText = withText[0]!.line.number;
    const lastText = withText[withText.length - 1]!.line.number;
    for (const l of usable) {
      if (l.line.number < firstText || l.line.number > lastText) continue;
      if (l.blank) {
        if (!l.quoteMarks.length) changes.push({ from: l.line.from, insert: '>' });
      } else if (!l.inQuote) {
        changes.push({ from: l.line.from, insert: '> ' });
      }
    }
  }
  if (!changes.length) return null;
  const tr = state.update({ changes, userEvent: COMMAND_EVENT, scrollIntoView: true });
  // On an empty line the cursor goes after the new mark.
  const main = state.selection.main;
  if (main.empty && !withText.length && usable.length === 1 && !usable[0]!.quoteMarks.length) {
    return state.update({
      changes,
      selection: EditorSelection.cursor(tr.changes.mapPos(main.head, 1)),
      userEvent: COMMAND_EVENT,
      scrollIntoView: true,
    });
  }
  return tr;
};

// ---------------------------------------------------------------------------
// Code blocks, rules, images

/** The same node of two trees: a container read on two lines. */
function sameNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.name === b.name && a.from === b.from;
}

/**
 * The lines a code block wraps, from `first` to `last` or further, and the containers its fences
 * sit in. A list item whose marker line is wrapped goes in whole: its later lines line up with
 * that marker, so any left out would read as something else. The fences sit in the containers
 * that hold every wrapped line (outermost first), short of any list item that starts there.
 * With each wrapped line read (`infos`).
 */
function wrappedLines(
  state: EditorState,
  first: Line,
  last: Line,
): { last: Line; held: SyntaxNode[]; tree: Tree; infos: LineMarks[] } {
  const doc = state.doc;
  for (;;) {
    const tree = treeForLine(state, last.to);
    const infos: LineMarks[] = [];
    let end = last;
    for (let n = first.number; n <= last.number; n++) {
      const info = lineInfo(state, tree, doc.line(n));
      infos.push(info);
      for (const c of info.containers)
        if (c.name === 'ListItem' && c.from >= first.from && c.to > end.to) end = doc.lineAt(c.to);
    }
    if (end.number > last.number) {
      last = end;
      continue;
    }
    const firstInfo = infos[0]!;
    const startsInside = firstInfo.containers.findIndex((c) => c.name === 'ListItem' && c.from >= first.from);
    let held = startsInside >= 0 ? firstInfo.containers.slice(0, startsInside) : firstInfo.containers;
    for (const info of infos) {
      let shared = 0;
      while (shared < held.length && info.containers[shared] && sameNode(held[shared]!, info.containers[shared]!))
        shared++;
      held = held.slice(0, shared);
    }
    return { last, held, tree, infos };
  }
}

/**
 * Code block: wraps the selected lines (with the rest of any list item whose marker line is
 * among them, `wrappedLines`) in a fence longer than any run of backticks in them,
 * or inserts an empty block with the cursor inside (on a blank line, there; else below the
 * line). Blank lines go around the block where its neighbors have text, but not in a list
 * item (`takesBlankLines`).
 */
export const insertCodeBlock: StateCommand = (state) => {
  if (!canEdit(state)) return null;
  const doc = state.doc;
  const range = state.selection.main;
  const tree = treeForLine(state, range.to);
  if (codeAt(tree, range.from)?.kind === 'block' || codeAt(tree, range.to)?.kind === 'block') return null;
  if (!range.empty) {
    const first = doc.lineAt(range.from);
    let selected = doc.lineAt(range.to);
    if (selected.number > first.number && range.to === selected.from) selected = doc.line(selected.number - 1);
    const { last, held, tree: whole, infos } = wrappedLines(state, first, selected);
    const firstInfo = infos[0]!;
    // The fences take the first line's own marks while those hold it where every wrapped line is.
    const prefix =
      held.length === firstInfo.containers.length && marksHold(state, whole, firstInfo, held)
        ? doc.sliceString(first.from, firstInfo.textFrom)
        : containerPrefix(state, whole, firstInfo, held);
    // A lazy line runs on a paragraph without the marks of what holds it; in code it needs them.
    const lazy = infos.filter((info) => !info.blank && !marksHold(state, whole, info, held));
    const added = lazy.reduce((sum, info) => sum + prefix.length - (info.textFrom - info.line.from), 0);
    const content = doc.sliceString(first.from, last.to);
    const fence = '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
    const block = `${fence}\n${content}\n${fence}`;
    const { before, after } = blankLinesAround(state, held, block, first.number, last.number, prefix.trimEnd());
    return state.update({
      changes: [
        { from: first.from, insert: `${before}${prefix}${fence}\n` },
        ...lazy.map((info) => ({ from: info.line.from, to: info.textFrom, insert: prefix })),
        { from: last.to, insert: `\n${prefix}${fence}${after}` },
      ],
      selection: EditorSelection.range(
        first.from + before.length + prefix.length + fence.length + 1,
        last.to + before.length + prefix.length + fence.length + 1 + added,
      ),
      userEvent: COMMAND_EVENT,
      scrollIntoView: true,
    });
  }
  return blockAtLine(state, ['```', '', '```'], { line: 1, column: 0 });
};

/**
 * Horizontal rule: `---` on its own line, with a blank line before it so it cannot become a
 * Setext underline, and the cursor on the line after it. Straight below a list item's text it is
 * `***`, which underlines nothing, so it takes no blank line there (`lineOfItsOwn`).
 */
export const insertRule: StateCommand = (state) => {
  if (!canEdit(state)) return null;
  const pos = state.selection.main.head;
  const tree = treeForLine(state, pos);
  if (codeAt(tree, pos)?.kind === 'block') return null;
  const place = containerAt(state, tree, state.doc.lineAt(pos));
  const inItem = place.info.containers[place.info.containers.length - 1]?.name === 'ListItem';
  return lineOfItsOwn(state, !place.empty && inItem ? '***' : '---');
};

/**
 * The transaction that inserts `![](path)` at the main selection, the cursor in the alt text.
 * Selected text on one line becomes the alt text.
 */
export function insertImageText(state: EditorState, markdownPath: string): ReturnType<StateCommand> {
  if (!canEdit(state) || !markdownPath) return null;
  const range = state.selection.main;
  const doc = state.doc;
  const oneLine = doc.lineAt(range.from).number === doc.lineAt(range.to).number;
  const alt = oneLine ? doc.sliceString(range.from, range.to).replace(/[[\]]/g, '\\$&') : '';
  const from = oneLine ? range.from : range.head;
  const to = oneLine ? range.to : range.head;
  const insert = `![${alt}](${linkDestination(markdownPath)})`;
  return state.update({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + 2 + alt.length),
    userEvent: COMMAND_EVENT,
    scrollIntoView: true,
  });
}

/** Image: asks the host for a file (`pickImage`) and inserts it; nothing when the dialog is canceled. */
const insertImage: PanelCommand = (view) => {
  const state = view.state;
  if (!canEdit(state)) return false;
  const ctx = state.facet(panelContext);
  if (!ctx) return false;
  const tree = treeForLine(state, state.selection.main.head);
  if (codeAt(tree, state.selection.main.head)?.kind === 'block') return false;
  // No time limit: the host answers when the file dialog closes.
  ctx.request<{ markdownPath?: unknown } | null>({ type: 'pickImage' }, { timeoutMs: null }).then(
    (result) => {
      const path = result && typeof result.markdownPath === 'string' ? result.markdownPath : '';
      if (!path || !view.dom.isConnected) return;
      const tr = insertImageText(view.state, path);
      if (!tr) return;
      view.dispatch(tr);
      view.focus();
    },
    (error) => ctx.log('warn', 'The image picker gave no answer', error),
  );
  return true;
};

// ---------------------------------------------------------------------------
// The commands

export const blockCommands: Feature = {
  id: 'blockCommands',
  commands: {
    setHeading: asPanelCommand(setHeading),
    headingUp: asPanelCommand(headingUp),
    headingDown: asPanelCommand(headingDown),
    toggleQuote: asPanelCommand(toggleQuote),
    insertCodeBlock: asPanelCommand(insertCodeBlock),
    insertRule: asPanelCommand(insertRule),
    insertImage,
  },
};
