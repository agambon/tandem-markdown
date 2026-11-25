// Footnotes, numbered as GitHub numbers them (links/footnotes.ts). A reference `[^id]`, and a
// note written in place, `^[text]`, draw as the note's number in superscript (`tm-footnote-ref`);
// a definition's `[^id]:` as its number, hanging in the margin as a list's numbers do
// (`tm-footnote-number`). Each shows its source while the selection touches it. A reference to
// a label the file does not define is text, and so is the label of a note nothing refers to.
// Following and hovering one is as for links (docs/ARCHITECTURE.md, "Tables, links, images and
// front matter").
//
// A definition's further lines, paragraphs included, are indented by four spaces
// (markdown/footnote.ts), which are hidden; every line of it is drawn one list step in
// (`tm-footnote-cont`). A list, quote or code block inside a definition, and a definition inside
// a list item or a quote, keep their source indentation.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { Feature } from '../features';
import {
  footnoteIndex,
  footnoteIndexField,
  footnoteLabel,
  footnotesKey,
  noteTextStart,
  type FootnoteIndex,
} from '../links/footnotes';
import { DEFINITION_INDENT } from '../markdown/footnote';
import { NO_INLINE } from '../markdown/nodes';
import { blockFeature, inlineFeature, RichWidget, type InlineDraw } from './framework';
import { hideIndent, markerWidthClass } from './layout';

const SKIP = new Set([...NO_INLINE, 'InlineCode']);

/** A note's number in place of its source: a reference's superscript, or a definition's number. */
class FootnoteNumber extends RichWidget {
  constructor(
    source: string,
    readonly text: string,
    readonly className: string,
    readonly label: string,
    readonly view: boolean,
  ) {
    super(source);
  }

  override sameAs(other: FootnoteNumber): boolean {
    return (
      other.text === this.text &&
      other.className === this.className &&
      other.label === this.label &&
      other.view === this.view
    );
  }

  override get plainText(): string {
    return this.text;
  }

  draw(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = `${this.className} tm-link`;
    span.textContent = this.text;
    span.setAttribute('aria-label', this.label);
    // In Rich view it can take focus (ui/viewKeys.ts), as a link's text does.
    if (this.view) {
      span.tabIndex = -1;
      span.setAttribute('role', 'link');
    }
    return span;
  }

  /** A click places the cursor, which shows the source; the link keys follow it (render/links.ts). */
  override ignores(): boolean {
    return false;
  }
}

function drawReference(d: InlineDraw, node: SyntaxNode, number: number | null): void {
  if (number === null) return;
  if (d.revealed(node.from, node.to)) {
    // A reference's label stays small; a note written in place reads as the text it is.
    if (node.name === 'FootnoteRef') d.mark(node.from, node.to, 'tm-footnote-ref');
    d.mark(node.from, node.from + 2, 'tm-mark');
    d.mark(node.to - 1, node.to, 'tm-mark');
    return;
  }
  const source = d.doc.sliceString(node.from, node.to);
  const label = node.name === 'InlineFootnote' ? `Footnote ${number}, written in place` : `Footnote ${number}`;
  d.replace(
    node.from,
    node.to,
    new FootnoteNumber(source, String(number), 'tm-footnote-ref', label, d.mode === 'view'),
  );
}

function drawDefinitionLabel(d: InlineDraw, node: SyntaxNode, number: number | null): void {
  const textFrom = noteTextStart(d.doc, node);
  if (number === null || d.revealed(node.from, node.to)) {
    d.mark(node.from, textFrom, `tm-footnote-label ${markerWidthClass(textFrom - node.from)}`.trim());
    return;
  }
  const source = d.doc.sliceString(node.from, textFrom);
  const label = `Footnote ${number}, back to the reference`;
  d.replace(
    node.from,
    textFrom,
    new FootnoteNumber(source, `${number}. `, 'tm-footnote-number', label, d.mode === 'view'),
  );
}

export const footnotes: Feature = {
  id: 'footnotes',
  extension: () => [
    footnoteIndexField,
    inlineFeature(
      'footnotes',
      (d) => {
        // Built the first time a footnote is in view, so a file with none never reads its notes.
        let index: FootnoteIndex | null | undefined;
        const notes = () => (index === undefined ? (index = footnoteIndex(d.state)) : index);
        d.iterate((node) => {
          if (SKIP.has(node.name)) return false;
          if (node.name === 'FootnoteLabel') {
            drawDefinitionLabel(d, node.node, notes()?.number(footnoteLabel(d.doc, node.node)) ?? null);
            return false;
          }
          if (node.name === 'FootnoteRef') {
            drawReference(d, node.node, notes()?.number(footnoteLabel(d.doc, node.node)) ?? null);
            return false;
          }
          if (node.name === 'InlineFootnote') {
            drawReference(d, node.node, notes()?.inPlaceNumber(node.from) ?? null);
            // Its text shows while the selection is in it: what is inside draws as usual.
            return d.revealed(node.from, node.to);
          }
          return true;
        });
      },
      {
        reads: footnotesKey,
        // A reference's number is all it draws that its text does not say.
        placed: (state, node) => footnoteIndex(state)?.numbersIn(node.from, node.to) ?? '',
      },
    ),
    blockFeature('footnotes', (d) => {
      d.blocks((block) => {
        if (block.name !== 'FootnoteDef' || block.listDepth > 0 || block.quoteDepth > 0) return;
        d.line(d.lines.start(block.firstLine), 'tm-footnote-cont tm-footnote-first');
        for (let child = block.node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'Paragraph') continue;
          const last = d.lines.numberAt(child.to);
          for (let n = Math.max(d.lines.numberAt(child.from), block.firstLine + 1); n <= last; n++) {
            const lineFrom = d.lines.start(n);
            d.line(lineFrom, 'tm-footnote-cont');
            // A lazy continuation line has no indent, and nothing is hidden.
            hideIndent(d, lineFrom, d.lines.text(n), 0, DEFINITION_INDENT);
          }
        }
      });
    }),
    EditorView.baseTheme({
      // On a definition's first line the number, or the label shown as typed, hangs in the
      // margin one list step wide (wider for a long label, tm-mw<n>), so the text starts
      // where its further lines start.
      '& .cm-content .tm-footnote-first .tm-footnote-number, & .cm-content .tm-footnote-first .tm-footnote-label': {
        display: 'inline-block',
        boxSizing: 'border-box',
        width: 'var(--tm-mw, var(--tm-list-step))',
        marginLeft: 'calc(-1 * var(--tm-mw, var(--tm-list-step)))',
        textAlign: 'right',
        whiteSpace: 'pre',
        verticalAlign: 'top',
      },
    }),
  ],
};
