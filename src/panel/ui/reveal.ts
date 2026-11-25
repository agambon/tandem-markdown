// The panel command `revealHeading` (`args: { from }`, the offset of a heading line), called
// by the outline tree in the Explorer (through the host) and by `#heading` links.
//
// It scrolls that line to the top of the panel; in Rich editor it also puts the cursor at the
// start of the heading's text (after the `#` marks), which shows the marks by the reveal rule.
// In Rich view the selection is left alone.

import type { EditorState, TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isSpaceOrTab } from '../../core/markdownText';
import type { Feature } from '../features';
import { isAtxHeading, isSetextHeading } from '../markdown/nodes';
import { treeForLine } from '../markdown/tree';
import { getMode } from '../modes';
import { redrawFeatureEffect } from '../render/framework';
import { foldedHeadings, unfoldHeadingAtEffect } from '../render/headingFolds';

/**
 * Where the text of the heading on the line holding `pos` starts: after the `#` marks and the
 * spaces after them, or at the first character of a Setext heading. For a line that is not a
 * heading, its first character that is not a space or a container mark.
 */
export function headingTextStart(state: EditorState, pos: number): number {
  const doc = state.doc;
  const line = doc.lineAt(Math.max(0, Math.min(doc.length, pos)));
  const tree = treeForLine(state, line.from);
  let start = -1;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (start >= 0) return false;
      if (isAtxHeading(node.name)) {
        let at = node.from;
        const mark = node.node.firstChild;
        if (mark && mark.name === 'HeaderMark' && mark.from === node.from) at = mark.to;
        while (at < node.to && isSpaceOrTab(doc.sliceString(at, at + 1).charCodeAt(0))) at++;
        start = Math.min(at, node.to);
        return false;
      }
      if (isSetextHeading(node.name) && node.from >= line.from) {
        start = node.from;
        return false;
      }
      return undefined;
    },
  });
  if (start >= 0) return start;
  // Not a heading: the line's own text, past spaces, quote marks and `#`s.
  const match = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}(?=[ \t]|$))?[ \t]*/.exec(line.text);
  return line.from + (match ? match[0].length : 0);
}

/** The transaction for revealing the heading on the line holding `from`. */
export function revealHeadingSpec(state: EditorState, from: number): TransactionSpec {
  const pos = Math.max(0, Math.min(state.doc.length, Math.floor(from)));
  const line = state.doc.lineAt(pos);
  // Headings carry an 8px transparent top border (--tm-gap-h) plus font half-leading; 14px keeps
  // the full line box below the top of the scroll area across OS font metrics without scrolling past
  // the 16px blank gap line above it.
  const scroll = EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 14 });
  const hasFolds = (state.field(foldedHeadings, false)?.size ?? 0) > 0;
  const effects = hasFolds
    ? [scroll, unfoldHeadingAtEffect.of(line.from), redrawFeatureEffect.of('headingFolds')]
    : scroll;
  if (getMode(state) !== 'edit') return { effects };
  return { selection: { anchor: headingTextStart(state, line.from) }, effects, userEvent: 'select.reveal' };
}

export const reveal: Feature = {
  id: 'reveal',
  commands: {
    revealHeading: (view, args) => {
      const from = (args as { from?: unknown } | undefined)?.from;
      if (typeof from !== 'number' || !Number.isFinite(from)) return false;
      view.dispatch(revealHeadingSpec(view.state, from));
      return true;
    },
  },
};
