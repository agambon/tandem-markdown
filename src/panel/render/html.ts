// HTML in a line, and the comments and processing instructions between blocks
// (docs/ARCHITECTURE.md, "HTML through one door"); HTML blocks are render/htmlBlocks.ts's.
//
// A comment block is removed in Rich view with one blank line after it, and so is a paragraph
// of tags a browser shows nothing for (`<a name="top"></a>`); both show faded in Rich editor.
// In a line, the elements GitHub keeps for text (`INLINE`) are drawn as bold and italic are:
// tags hidden, content styled (`tm-html-<name>`), tags shown faded while a selection touches
// them. `<a href>` is a link, `<a name>` is hidden, `<br>` breaks the line, `<img>` is the
// picture, and a `<picture>` (or, under `tandemMarkdown.syntax.media`, a `<video>` or `<audio>`)
// on one line is drawn whole; in a table cell, `<ul>`, `<ol>` and `<li>` are a list. Any other
// tag of an element shows faded; tag-shaped text that names no element is text. In a workspace
// VS Code does not trust, every tag shows faded.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { readHtmlBlock } from '../html/blocks';
import { INLINE, isHtmlElement, VOID_ELEMENTS } from '../html/elements';
import { htmlLinksIn } from '../html/links';
import { door } from '../html/load';
import { NO_INLINE, selfRevealingChildren } from '../markdown/nodes';
import { syntaxOn } from '../syntax';
import { blockFeature, inlineFeature, RichWidget, type BlockDraw, type InlineDraw } from './framework';
import { bringToLife, drawingOptions } from './htmlDrawing';
import { htmlPicture } from './images';
import { drawComment, hideWithGap, markRange } from './layout';
import type { BlockEntry, Span } from './lines';
import { linkTextAttrs } from './links';

interface Tag {
  node: SyntaxNode;
  name: string;
  closing: boolean;
  /** `<x/>`, or an element that has no closing tag. */
  alone: boolean;
}

function readTag(d: InlineDraw, node: SyntaxNode): Tag | null {
  const text = d.doc.sliceString(node.from, node.to);
  const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(text);
  if (!match) return null;
  const name = match[2]!.toLowerCase();
  return { node, name, closing: match[1] === '/', alone: VOID_ELEMENTS.has(name) || text.endsWith('/>') };
}

/** A line break drawn where `<br>` stands. */
class LineBreak extends RichWidget {
  override get plainText(): string {
    return '\n';
  }
  draw(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = 'tm-html-br';
    span.appendChild(view.dom.ownerDocument.createElement('br'));
    return span;
  }
}

function faded(d: InlineDraw, tag: Tag): void {
  d.mark(tag.node.from, tag.node.to, 'tm-html-inline');
}

/**
 * A `<picture>`, `<video>` or `<audio>` written on one line, drawn through the door as the
 * picture for the theme or a player (render/htmlDrawing.ts).
 */
class InlineElement extends RichWidget {
  constructor(
    source: string,
    /** A player, whose clicks are its own. */
    readonly player: boolean,
  ) {
    super(source);
  }

  override sameAs(other: InlineElement): boolean {
    return other.player === this.player;
  }

  /** A picture or a player has no text to read. */
  override get plainText(): string {
    return '';
  }

  draw(view: EditorView): HTMLElement {
    const ctx = this.ctx ?? view.state.facet(panelContext);
    const module = door.loaded();
    if (!ctx || !module) throw new Error('HTML in a line needs the panel context and the HTML door');
    const span = view.dom.ownerDocument.createElement('span');
    span.className = 'tm-html-element';
    span.append(module.sanitizeHtml(this.source, drawingOptions(ctx)));
    stops.set(span, bringToLife(view, ctx, span));
    return span;
  }

  override destroy(dom: HTMLElement): void {
    stops.get(dom)?.();
    stops.delete(dom);
  }

  /** Clicks reach the editor, where one places the cursor and shows the source; a player's are its own. */
  override ignores(event: Event): boolean {
    return this.player || !(event.type.startsWith('mouse') || event.type === 'click');
  }
}

const stops = new WeakMap<HTMLElement, () => void>();

/** Elements drawn whole from one line: a picture, and players under `tandemMarkdown.syntax.media`. */
function drawnWhole(d: InlineDraw, name: string): boolean {
  return name === 'picture' || ((name === 'video' || name === 'audio') && syntaxOn(d.ctx.settings, 'media'));
}

/** Draws an element of `drawnWhole` written from `opener` to `closer`; false when it is shown as typed. */
function drawWhole(d: InlineDraw, opener: Tag, closer: Tag): boolean {
  const { from } = opener.node;
  const { to } = closer.node;
  if (d.lines.numberAt(from) !== d.lines.numberAt(to) || d.revealed(from, to)) return false;
  if (!door.loaded()) {
    d.drawWhenLoaded(door);
    return false;
  }
  d.replace(from, to, new InlineElement(d.doc.sliceString(from, to), opener.name !== 'picture'));
  return true;
}

/**
 * The lists a table cell draws: GFM's cells hold one line, so chat assistants and converters
 * write a list in a cell as HTML, and GitHub shows it as a list.
 */
const CELL_LISTS: ReadonlySet<string> = new Set(['ul', 'ol', 'li']);

/** Draws the tags among one inline content: `tags` in document order, siblings of one parent. */
function drawTags(d: InlineDraw, tags: Tag[], content: SyntaxNode): void {
  const lists = content.name === 'TableCell';
  const open: Tag[] = [];
  const paired = new Set<Tag>();
  const links = new Set(htmlLinksIn(d.doc, content).map((link) => link.from));
  /** What an element drawn whole covers: the tags inside it are drawn with it. */
  const covered: Span[] = [];
  for (const tag of tags) {
    if (drawnWhole(d, tag.name) && !tag.alone) {
      if (!tag.closing) open.push(tag);
      else {
        const at = open.map((t) => t.name).lastIndexOf(tag.name);
        if (at < 0) continue;
        const opener = open[at]!;
        open.length = at;
        if (drawWhole(d, opener, tag)) covered.push({ from: opener.node.from, to: tag.node.to });
      }
      continue;
    }
    if (tag.alone || !(INLINE.has(tag.name) || tag.name === 'a' || (lists && CELL_LISTS.has(tag.name)))) continue;
    if (!tag.closing) {
      open.push(tag);
      continue;
    }
    const at = open.map((t) => t.name).lastIndexOf(tag.name);
    if (at < 0) continue;
    const opener = open[at]!;
    open.length = at;
    paired.add(opener).add(tag);
    drawPair(d, opener, tag, content, links);
  }
  for (const tag of tags) {
    if (paired.has(tag) || !isHtmlElement(tag.name)) continue;
    if (covered.some((c) => tag.node.from >= c.from && tag.node.to <= c.to)) continue;
    if (tag.name === 'br' && !tag.closing) drawBreak(d, tag);
    else if (tag.name === 'img' && !tag.closing) drawPicture(d, tag);
    else faded(d, tag);
  }
}

function drawPair(d: InlineDraw, opener: Tag, closer: Tag, content: SyntaxNode, links: Set<number>): void {
  const from = opener.node.from;
  const to = closer.node.to;
  // An anchor with an address is a link, drawn as one; one without is a target, hidden.
  if (opener.name === 'a') {
    if (links.has(from)) markRange(d, opener.node.to, closer.node.from, 'tm-link', linkTextAttrs(d.mode));
  } else if (CELL_LISTS.has(opener.name)) {
    d.mark(opener.node.to, closer.node.from, `tm-html-${opener.name}`, undefined, opener.name);
  } else {
    markRange(d, opener.node.to, closer.node.from, `tm-html-${opener.name}`);
  }
  if (d.revealed(from, to, selfRevealingChildren(content, opener.node.to, closer.node.from))) {
    faded(d, opener);
    faded(d, closer);
  } else {
    d.hide(opener.node.from, opener.node.to);
    d.hide(closer.node.from, closer.node.to);
  }
}

function drawBreak(d: InlineDraw, tag: Tag): void {
  if (d.revealed(tag.node.from, tag.node.to)) faded(d, tag);
  else d.replace(tag.node.from, tag.node.to, new LineBreak(d.doc.sliceString(tag.node.from, tag.node.to)));
}

function drawPicture(d: InlineDraw, tag: Tag): void {
  const html = door.loaded();
  const { from, to } = tag.node;
  if (!html) {
    faded(d, tag);
    d.drawWhenLoaded(door);
    return;
  }
  const source = d.doc.sliceString(from, to);
  const picture = html.pictureAttributes(source, {
    allowRemote: d.ctx.settings.imagesAllowRemote,
    address: (_kind, value) => value,
  });
  if (!picture || d.revealed(from, to) || d.lines.numberAt(from) !== d.lines.numberAt(to)) faded(d, tag);
  else htmlPicture(d, from, to, picture);
}

/**
 * Whether `block`, a paragraph, is HTML tags alone that a browser shows nothing for, such as
 * `<a name="top"></a>`: Rich view then removes it, as it removes a comment.
 */
function showsNothing(d: BlockDraw, block: BlockEntry): boolean {
  for (let c = block.node.firstChild; c; c = c.nextSibling) if (c.name !== 'HTMLTag') return false;
  return block.node.firstChild !== null && readHtmlBlock(d.doc.sliceString(block.from, block.to)).kind === 'invisible';
}

/** Inline content: the nodes whose children are the inline nodes of one paragraph, heading or cell. */
const SKIP = new Set([...NO_INLINE, 'Table']);

export const html: Feature = {
  id: 'html',
  extension: () => [
    blockFeature('html', (d) => {
      d.blocks((block) => {
        if (block.name === 'ProcessingInstructionBlock') {
          for (let n = block.firstLine; n <= block.lastLine; n++) d.line(d.lines.start(n), 'tm-html');
        } else if (block.name === 'CommentBlock') {
          if (d.mode === 'view') {
            hideWithGap(d, block);
          } else {
            for (let n = block.firstLine; n <= block.lastLine; n++) d.line(d.lines.start(n), 'tm-html tm-html-comment');
          }
        } else if (
          block.name === 'Paragraph' &&
          d.mode === 'view' &&
          d.ctx.settings.workspaceTrusted &&
          showsNothing(d, block)
        ) {
          hideWithGap(d, block);
        }
      });
    }),
    inlineFeature('html', (d) => {
      const trusted = d.ctx.settings.workspaceTrusted;
      // Each parent's tags are drawn once, all together, even where the parent starts above the screen.
      const done = new Set<string>();
      d.iterate((node) => {
        if (SKIP.has(node.name)) return false;
        if (node.name === 'HTMLTag') {
          const parent = node.node.parent;
          const key = parent ? `${parent.name}:${parent.from}:${parent.to}` : '';
          if (!parent || done.has(key)) return false;
          done.add(key);
          const tags: Tag[] = [];
          for (let c = parent.firstChild; c; c = c.nextSibling) {
            const tag = c.name === 'HTMLTag' ? readTag(d, c) : null;
            if (tag) tags.push(tag);
          }
          if (trusted) drawTags(d, tags, parent);
          else for (const tag of tags) if (isHtmlElement(tag.name)) faded(d, tag);
          return false;
        }
        if (node.name === 'Comment') {
          drawComment(d, node.from, node.to, 'tm-html-inline tm-html-comment');
          return false;
        }
        return true;
      });
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-html-b, & .cm-content .tm-html-strong': { fontWeight: '600' },
      '& .cm-content .tm-html-i, & .cm-content .tm-html-em, & .cm-content .tm-html-cite, & .cm-content .tm-html-dfn, & .cm-content .tm-html-var':
        { fontStyle: 'italic' },
      '& .cm-content .tm-html-u, & .cm-content .tm-html-ins': { textDecoration: 'underline' },
      '& .cm-content .tm-html-s, & .cm-content .tm-html-strike, & .cm-content .tm-html-del': {
        textDecoration: 'line-through',
      },
      '& .cm-content .tm-html-mark': { background: 'var(--tm-highlight-bg)', borderRadius: '2px' },
      '& .cm-content .tm-html-sub': { verticalAlign: 'sub', fontSize: '0.75em', lineHeight: '0' },
      '& .cm-content .tm-html-sup': { verticalAlign: 'super', fontSize: '0.75em', lineHeight: '0' },
      '& .cm-content .tm-html-small': { fontSize: '0.85em' },
      '& .cm-content .tm-html-code, & .cm-content .tm-html-tt, & .cm-content .tm-html-samp, & .cm-content .tm-html-kbd':
        {
          fontFamily: 'var(--tm-mono)',
          fontSize: '0.85em',
        },
      '& .cm-content .tm-html-code, & .cm-content .tm-html-tt': {
        background: 'var(--tm-code-bg)',
        borderRadius: '3px',
        padding: '0.2em 0.4em',
      },
      // github-dark's kbd: a key cap with a heavier bottom edge.
      '& .cm-content .tm-html-kbd': {
        padding: '0.15em 0.35em',
        border: '1px solid var(--tm-border)',
        borderBottomWidth: '2px',
        borderRadius: '4px',
        background: 'var(--tm-widget-bg)',
        lineHeight: '1',
        boxDecorationBreak: 'clone',
      },
      '& .cm-content .tm-html-abbr': { textDecoration: 'underline dotted' },
    }),
  ],
};
