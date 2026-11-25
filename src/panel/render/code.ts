// Code blocks, fenced and indented. Every line of a block gets `tm-code-line`; the first and
// last lines also get `tm-code-first` and `tm-code-last`, so the stylesheet can draw one rounded
// box with its padding. Syntax colors come from the nested language parse (theme/highlight.ts).
//
// Unless the cursor is in the block, the opening fence line shows a header in place of the
// fence (`tm-code-header-line`: a title the fence gives, the language as markdown/fenceInfo.ts
// reads it, and a "Copy" button) and the closing fence line is removed. With the cursor in the
// block, both fences show as typed, faded (`tm-code-fence`).
//
// An indented block keeps its four spaces; `tm-code-indented` pulls each line back by them. A
// fenced block in a language an optional syntax draws (```` ```math ````) is left to that
// syntax's feature while the syntax is on (src/panel/syntax/, `fences`).

import { syntaxTree } from '@codemirror/language';
import type { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { fenceInfo, type FenceInfo } from '../markdown/fenceInfo';
import { fenceDrawn, syntaxOn } from '../syntax';
import { keyName } from '../ui/keys';
import { blockFeature, posOf, RichWidget, type BlockDraw } from './framework';
import type { BlockEntry } from './lines';

/** The code inside a fenced or indented block, without fences or container markers. */
export function codeText(doc: Text, block: SyntaxNode): string {
  let text = '';
  for (let child = block.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeText') text += doc.sliceString(child.from, child.to);
  }
  return text;
}

function blockAt(view: EditorView, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return node;
  }
  return null;
}

const COPIED_MS = 1500;

class CodeHeader extends RichWidget {
  constructor(
    source: string,
    readonly language: string,
    readonly title: string | null,
  ) {
    super(source);
  }

  override sameAs(other: CodeHeader): boolean {
    return other.language === this.language && other.title === this.title;
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const header = doc.createElement('span');
    header.className = 'tm-code-header';
    const label = doc.createElement('span');
    label.className = 'tm-code-lang';
    label.textContent = this.language;
    if (this.title !== null) {
      const title = doc.createElement('span');
      title.className = 'tm-code-title';
      title.textContent = this.title;
      label.prepend(title);
    }
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'tm-code-copy';
    button.textContent = 'Copy';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      void this.copy(view, header, button);
    });
    header.append(label, button);
    return header;
  }

  private async copy(view: EditorView, header: HTMLElement, button: HTMLButtonElement): Promise<void> {
    const at = posOf(view, header);
    const block = at === null ? null : blockAt(view, at);
    if (!block) return;
    const ctx = view.state.facet(panelContext);
    try {
      await navigator.clipboard.writeText(codeText(view.state.doc, block));
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), COPIED_MS);
    } catch (error) {
      ctx?.log('warn', 'Copying a code block failed', error);
      const copyKey = keyName({ key: 'ctrl+c', mac: 'cmd+c' });
      ctx?.notify({ kind: 'error', text: `Could not copy the code. Select it and press ${copyKey}.` });
    }
  }

  override ignores(): boolean {
    return true;
  }
}

/**
 * The language a fenced block names, and its title: the first word after its fence; or, while
 * that setting is on, the language and title as the program that wrote the fence means them.
 */
function fenceLabel(d: BlockDraw, block: SyntaxNode): FenceInfo {
  const node = block.getChild('CodeInfo');
  const info = node ? d.doc.sliceString(node.from, node.to) : '';
  if (syntaxOn(d.ctx.settings, 'codeFenceLabels')) return fenceInfo(info);
  return { language: info.split(/\s+/)[0]!, title: null };
}

/** A fenced block's language as its header shows it, lower case, or ''. */
export function fenceLanguage(d: BlockDraw, block: SyntaxNode): string {
  return fenceLabel(d, block).language.toLowerCase();
}

/**
 * Lines `first` to `last` drawn as one code box: `also` is added to every line's classes, and
 * the lines numbered in `fences` are fence lines, shown faded.
 */
export function codeLines(d: BlockDraw, first: number, last: number, also = '', fences: readonly number[] = []): void {
  for (let n = first; n <= last; n++) {
    let classes = also ? `tm-code-line ${also}` : 'tm-code-line';
    if (n === first) classes += ' tm-code-first';
    if (n === last) classes += ' tm-code-last';
    if (fences.includes(n)) classes += ' tm-code-fence';
    d.line(d.lines.start(n), classes);
  }
}

function fenced(d: BlockDraw, block: BlockEntry): void {
  const open = block.node.firstChild;
  if (!open || open.name !== 'CodeMark') return;
  const last = block.node.lastChild;
  const closeLine = last && last !== open && last.name === 'CodeMark' ? d.lines.numberAt(last.from) : 0;
  const openLine = block.firstLine;
  const endLine = block.lastLine;

  if (d.blockRevealed(block.from, block.to)) {
    codeLines(d, openLine, endLine, '', [openLine, closeLine]);
    return;
  }

  const firstCode = openLine + 1;
  const lastCode = closeLine ? closeLine - 1 : endLine;
  const { language, title } = fenceLabel(d, block.node);
  const empty = lastCode < firstCode;
  const openEnd = d.lines.end(openLine);
  d.line(open.from, `tm-code-line tm-code-first tm-code-header-line${empty ? ' tm-code-last' : ''}`);
  d.replace(open.from, openEnd, new CodeHeader(d.doc.sliceString(open.from, openEnd), language, title));
  for (let n = firstCode; n <= lastCode; n++) {
    d.line(d.lines.start(n), n === lastCode ? 'tm-code-line tm-code-last' : 'tm-code-line');
  }
  if (closeLine) d.hideLines(d.lines.start(closeLine), d.lines.end(closeLine));
}

function indented(d: BlockDraw, block: BlockEntry): void {
  codeLines(d, block.firstLine, block.lastLine, 'tm-code-indented');
}

const theme = EditorView.baseTheme({
  // inline-flex, not flex: a block box would sit between CodeMirror's inline widget buffers and
  // add an empty line box above and below it.
  '& .cm-content .tm-code-header': {
    display: 'inline-flex',
    boxSizing: 'border-box',
    width: '100%',
    verticalAlign: 'top',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    textIndent: '0',
    fontFamily: 'var(--tm-ui-font)',
  },
  '& .cm-content .tm-code-lang': { color: 'var(--tm-faded)', fontSize: '0.9em' },
  '& .cm-content .tm-code-title': { color: 'var(--tm-fg)', marginRight: '0.8em' },
  '& .cm-content .tm-code-copy': {
    font: 'inherit',
    fontSize: '0.9em',
    lineHeight: '1.4',
    padding: '1px 8px',
    border: 'none',
    borderRadius: '2px',
    background: 'var(--tm-button2-bg)',
    color: 'var(--tm-button2-fg)',
    cursor: 'pointer',
  },
  '& .cm-content .tm-code-copy:hover': { background: 'var(--tm-button2-hover-bg)' },
  '& .cm-content .tm-code-copy:focus-visible': { outline: '1px solid var(--tm-focus)', outlineOffset: '1px' },
});

export const code: Feature = {
  id: 'code',
  extension: () => [
    blockFeature('code', (d) => {
      d.blocks((block) => {
        if (block.name === 'FencedCode') {
          if (!fenceDrawn(d.ctx.settings, fenceLanguage(d, block.node))) fenced(d, block);
        } else if (block.name === 'CodeBlock') {
          indented(d, block);
        }
      });
    }),
    theme,
  ],
};
