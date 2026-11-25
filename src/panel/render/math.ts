// Math, drawn by KaTeX (render/katex.ts), which loads the first time a formula is drawn.
//
// In a line (`$a^2$`, GitHub's `` $`a^2`$ ``, `$$a$$` among other text): the formula in place
// of its source, unless a selection touches it, when the source shows with its dollars faded.
// A formula written over more than one line, or longer than INLINE_LIMIT, shows as typed.
//
// As a block (a paragraph that is one `$$…$$`, or a ```` ```math ```` code block): a drawn
// block (render/drawnBlock.ts), which opens to its source with the pencil or the cursor.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { NO_INLINE } from '../markdown/nodes';
import { codeText, fenceLanguage } from './code';
import { drawBlock, drawnBlockKeys, drawnBlockTheme, type DrawnKind } from './drawnBlock';
import { blockFeature, inlineFeature, RichWidget, type BlockDraw, type InlineDraw } from './framework';
import { drawFormula, katex } from './katex';

/** A formula in a line longer than this shows as typed. */
const INLINE_LIMIT = 2000;
/** A math block longer than this shows as code with a "Draw anyway" button. */
const BLOCK_LIMIT = 10_000;
/** The height kept for a math block never measured. */
const BLOCK_ESTIMATE = 48;

const MATH: DrawnKind = {
  name: 'Math',
  sentenceName: 'a math block',
  editLabel: 'Edit the math',
  doneLabel: 'Done editing the math',
  limit: BLOCK_LIMIT,
  estimate: BLOCK_ESTIMATE,
  library: katex,
  draw: (source) => drawFormula(source, true) ?? { error: 'Math could not be drawn.' },
};

/** The text of a formula node: what lies between its marks, stripping quote prefixes on inner lines. */
function formulaText(
  d: { doc: { sliceString(from: number, to: number): string } },
  node: SyntaxNode,
  quoteDepth = 0,
): string {
  const text = node.getChild('MathText');
  const raw = text ? d.doc.sliceString(text.from, text.to) : '';
  if (quoteDepth <= 0 || !raw.includes('\n')) return raw;
  return raw
    .split('\n')
    .map((line, i) => {
      if (i === 0) return line;
      let rest = line;
      for (let q = 0; q < quoteDepth; q++) {
        const stripped = rest.replace(/^ {0,3}> ?/, '');
        if (stripped === rest) break;
        rest = stripped;
      }
      return rest;
    })
    .join('\n');
}

/** The `$$…$$` that is the whole of `paragraph`, or null. */
function blockFormula(d: BlockDraw | InlineDraw, paragraph: SyntaxNode): SyntaxNode | null {
  const first = paragraph.firstChild;
  if (!first || first.name !== 'DisplayMath' || first.nextSibling) return null;
  const before = d.doc.sliceString(paragraph.from, first.from);
  const after = d.doc.sliceString(first.to, paragraph.to);
  return before.trim() === '' && after.trim() === '' ? first : null;
}

/** A formula in a line, drawn in place of its source. */
class InlineFormula extends RichWidget {
  constructor(
    source: string,
    readonly tex: string,
    readonly display: boolean,
  ) {
    super(source);
  }

  override sameAs(other: InlineFormula): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  override get plainText(): string {
    return this.tex;
  }

  draw(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = 'tm-math';
    span.setAttribute('role', 'math');
    span.setAttribute('aria-label', this.tex);
    // `$$…$$` in a line is display math at the size of the text around it.
    const tex = this.display ? `\\displaystyle ${this.tex}` : this.tex;
    const fill = () => {
      const formula = drawFormula(tex, false);
      if (!formula) return;
      if ('node' in formula) {
        span.replaceChildren(formula.node);
        span.removeAttribute('title');
        span.classList.remove('tm-math-error');
      } else {
        span.textContent = this.source;
        span.title = formula.error;
        span.classList.add('tm-math-error');
      }
      span.classList.remove('tm-math-waiting');
      view.requestMeasure();
    };
    if (katex.loaded()) {
      fill();
    } else {
      // The source, faded, until KaTeX has loaded.
      span.textContent = this.source;
      span.classList.add('tm-math-waiting');
      katex.load().then(fill, (error: unknown) => {
        view.state.facet(panelContext)?.log('error', 'Could not load what draws math', error);
        // The source stays, marked, and says why it is not drawn.
        span.title = 'Math could not be drawn: what draws it did not load.';
        span.classList.replace('tm-math-waiting', 'tm-math-error');
      });
    }
    return span;
  }

  /** A click places the cursor beside it, as on any character; the cursor then shows the source. */
  override ignores(): boolean {
    return false;
  }
}

function drawInline(d: InlineDraw, node: SyntaxNodeRef): void {
  if (d.revealed(node.from, node.to)) {
    for (const mark of node.node.getChildren('MathMark')) d.mark(mark.from, mark.to, 'tm-mark');
    return;
  }
  const tex = formulaText(d, node.node);
  if (d.lines.numberAt(node.from) !== d.lines.numberAt(node.to) || tex.length > INLINE_LIMIT) return;
  const source = d.doc.sliceString(node.from, node.to);
  d.replace(node.from, node.to, new InlineFormula(source, tex, node.name === 'DisplayMath'));
}

/** Whether `formula`'s two marks stand alone on their lines, as delimiters do in a block. */
function marksAlone(d: BlockDraw, formula: SyntaxNode): boolean {
  const marks = formula.getChildren('MathMark');
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (!open || !close || d.lines.numberAt(open.from) === d.lines.numberAt(close.from)) return false;
  return (
    d.doc.sliceString(open.to, d.lines.end(d.lines.numberAt(open.to))).trim() === '' &&
    d.doc
      .sliceString(d.lines.start(d.lines.numberAt(close.from)), close.from)
      .replace(/>/g, '')
      .trim() === ''
  );
}

export const math: Feature = {
  id: 'math',
  extension: () => [
    inlineFeature('math', (d) => {
      d.iterate((node) => {
        if (NO_INLINE.has(node.name)) return false;
        if (node.name === 'Paragraph' && blockFormula(d, node.node)) return false;
        if (node.name === 'InlineMath' || node.name === 'DisplayMath') {
          drawInline(d, node);
          return false;
        }
        return true;
      });
    }),
    blockFeature('math', (d) => {
      d.blocks((block) => {
        if (block.name === 'Paragraph') {
          const formula = blockFormula(d, block.node);
          if (formula) drawBlock(d, block, MATH, formulaText(d, formula, block.quoteDepth), marksAlone(d, formula));
        } else if (block.name === 'DisplayMathBlock') {
          drawBlock(d, block, MATH, formulaText(d, block.node, block.quoteDepth), true);
        } else if (block.name === 'FencedCode' && fenceLanguage(d, block.node) === 'math') {
          drawBlock(d, block, MATH, codeText(d.doc, block.node), true);
        }
      });
    }),
    drawnBlockKeys,
    drawnBlockTheme,
    EditorView.baseTheme({
      // Inline, with no overflow of its own: KaTeX's struts let parts of a formula reach a few
      // pixels past its box, so a box that scrolls or clips would show scroll bars or cut them
      // off. A formula wider than the line breaks between its terms, as KaTeX lays it out.
      '& .cm-content .tm-math': { display: 'inline' },
      '& .cm-content .tm-math-waiting, & .cm-content .tm-math-error': { color: 'var(--tm-faded)' },
      '& .cm-content .tm-math-error': { textDecoration: 'underline wavy var(--tm-error)' },
      '& .cm-content .tm-drawn .katex-display': { margin: '0' },
    }),
  ],
};
