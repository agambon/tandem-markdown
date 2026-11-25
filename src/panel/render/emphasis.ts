// Inline styles: bold, italic, bold-italic, strikethrough, highlight, subscript, superscript,
// inline code, backslash escapes and character entities.
//
// The styled span keeps its class whether or not its marks show. The marks (`**`, `_`,
// `~~`, `==`, `~`, `^`, backticks) are hidden unless a selection touches the span; then they show
// faded. A selection inside a nested span (`*it*` in `**bold *it***`, or a link) reveals
// that span only. An escape (`\*`) shows the character without the backslash unless
// touched, and so does a backslash hard break at the end of a line. An entity (`&amp;`)
// shows the character it stands for unless touched, when it shows as typed, faded; one
// CommonMark does not recognize (`&nosuch;`) is text. A highlight starting with one of
// Obsidian's color emoji (`==🔴Important==`) takes that color, the emoji hidden with the marks.
// In a table cell `\|` in code is a pipe, its backslash hidden.

import type { EditorView } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
import type { Feature } from '../features';
import { entityChar } from '../markdown/entities';
import { inTableCell, NO_INLINE, selfRevealingChildren } from '../markdown/nodes';
import { syntaxOn } from '../syntax';
import { CharWidget } from './charWidget';
import { inlineFeature, type InlineDraw } from './framework';

/** The styled spans, by node: the class each is drawn with and its marks' node. */
const STYLED: Readonly<Record<string, { className: string; mark: string }>> = {
  Emphasis: { className: 'tm-em', mark: 'EmphasisMark' },
  StrongEmphasis: { className: 'tm-strong', mark: 'EmphasisMark' },
  Strikethrough: { className: 'tm-strike', mark: 'StrikethroughMark' },
  Highlight: { className: 'tm-highlight', mark: 'HighlightMark' },
  Subscript: { className: 'tm-sub', mark: 'SubscriptMark' },
  Superscript: { className: 'tm-sup', mark: 'SuperscriptMark' },
  InlineCode: { className: 'tm-code', mark: 'CodeMark' },
};

/** Obsidian's six highlight colors, by the emoji that names each; Bear writes five of them. */
const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
  '\u{1F534}': 'red',
  '\u{1F7E0}': 'orange',
  '\u{1F7E1}': 'yellow',
  '\u{1F7E2}': 'green',
  '\u{1F535}': 'blue',
  '\u{1F7E3}': 'purple',
};

/** The color emoji just after a highlight's opening `==`, and the color it names, or null. */
function highlightColor(d: InlineDraw, node: SyntaxNodeRef): { from: number; to: number; name: string } | null {
  const open = node.node.firstChild;
  if (!open || open.name !== 'HighlightMark') return null;
  // Each of the six lies outside the Basic Multilingual Plane: two UTF-16 units.
  const name = HIGHLIGHT_COLORS[d.doc.sliceString(open.to, open.to + 2)];
  return name ? { from: open.to, to: open.to + 2, name } : null;
}

/** Draws a styled span and its marks; true when a selection touching it shows the marks. */
function styled(d: InlineDraw, node: SyntaxNodeRef, className: string, markName: string): boolean {
  d.mark(node.from, node.to, className);
  const revealed = d.revealed(node.from, node.to, selfRevealingChildren(node.node));
  for (let mark = node.node.firstChild; mark; mark = mark.nextSibling) {
    if (mark.name !== markName) continue;
    if (revealed) d.mark(mark.from, mark.to, 'tm-mark');
    else d.hide(mark.from, mark.to);
  }
  return revealed;
}

/** In a table cell `\|` in a code span is a pipe (GFM): its backslash hides as an escape's does. */
function pipesInCell(d: InlineDraw, code: SyntaxNodeRef): void {
  if (!inTableCell(code.node)) return;
  const text = d.doc.sliceString(code.from, code.to);
  for (let i = text.indexOf('\\|'); i >= 0; i = text.indexOf('\\|', i + 2)) d.hide(code.from + i, code.from + i + 1);
}

function backslash(d: InlineDraw, node: SyntaxNodeRef): void {
  if (d.doc.sliceString(node.from, node.from + 1) !== '\\') return;
  if (d.revealed(node.from, node.to)) d.mark(node.from, node.from + 1, 'tm-mark');
  else d.hide(node.from, node.from + 1);
}

/** The character an entity stands for, drawn in its place. */
class EntityChar extends CharWidget {
  draw(view: EditorView): HTMLElement {
    return this.charSpan(view, 'tm-entity');
  }
}

function entity(d: InlineDraw, node: SyntaxNodeRef): void {
  const source = d.doc.sliceString(node.from, node.to);
  const char = entityChar(source);
  if (char === null) return;
  if (d.revealed(node.from, node.to)) d.mark(node.from, node.to, 'tm-mark');
  else d.replace(node.from, node.to, new EntityChar(source, char));
}

export const emphasis: Feature = {
  id: 'emphasis',
  extension: () =>
    inlineFeature('emphasis', (d) => {
      const colors = syntaxOn(d.ctx.settings, 'highlightColors');
      d.iterate((node) => {
        if (NO_INLINE.has(node.name)) return false;
        const style = STYLED[node.name];
        if (style) {
          const color = colors && node.name === 'Highlight' ? highlightColor(d, node) : null;
          const className = color ? `${style.className} tm-highlight-${color.name}` : style.className;
          const revealed = styled(d, node, className, style.mark);
          if (!revealed && color) d.hide(color.from, color.to);
          if (node.name !== 'InlineCode') return true;
          if (!revealed) pipesInCell(d, node);
          return false;
        }
        if (node.name === 'Escape' || node.name === 'HardBreak') {
          backslash(d, node);
          return false;
        }
        if (node.name === 'Entity') {
          entity(d, node);
          return false;
        }
        return true;
      });
    }),
};
