// Boxes: `:::` blocks and `!!!` and `???` admonitions (markdown/boxes.ts), each drawn as a
// level of quote (render/quotes.ts draws the bar) with a head in place of its opening marks.
//
// A name that means a callout (`note`, `danger`, Quarto's `callout-tip`, and the aliases)
// takes that callout's look, icon and default title (render/callouts.ts); an admonition of a
// type no program knows takes the note's look, as Material does; any other `:::` name draws a
// plain box labeled with the name; a content tab a plain box under its title; a quote between
// `>>>` lines a quote. Marks show, faded, while the cursor is on their line. `???` folds closed
// and `???+` open, and so do VitePress's `details` and a Quarto callout with `collapse`. The
// four spaces before each line of an indented body are hidden.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { attribute, readAttributes } from '../../core/attributes';
import { isSpaceOrTab } from '../../core/markdownText';
import type { Feature } from '../features';
import { ADMONITION_INDENT } from '../markdown/boxes';
import { isAtxHeading } from '../markdown/nodes';
import { syntaxOn } from '../syntax';
import { calloutClasses, calloutTheme, calloutType, CalloutHead, defaultTitle, isCallout } from './callouts';
import { ContainerHead, FoldedBodies, foldState, foldTheme, innermostLooks, turnedFolds } from './folds';
import { blockFeature, type BlockDraw } from './framework';
import { containerBase, hideContainerIndent, listLinesIn } from './layout';
import type { BlockEntry } from './lines';

/** Material's aliases where they differ from Obsidian's reading of GitHub's types. */
const ADMONITION_ALIASES: Record<string, string> = { important: 'tip', caution: 'warning' };

/** What a box is drawn as, read from its first line's nodes. */
interface Box {
  block: BlockEntry;
  indented: boolean;
  /** The callout look it takes, or null for a plain box. */
  look: string | null;
  /** A plain box's label: its name as written. */
  label: string;
  /** The title shown when the file gives none; null for none. */
  fallback: string | null;
  fold: '' | '+' | '-';
  /** The head stands in for [headFrom, headTo): the marks before the title, or the whole line. */
  headFrom: number;
  headTo: number;
  /** The title as written, [titleFrom, titleTo); empty when there is none. */
  titleFrom: number;
  titleTo: number;
  /** An admonition whose title is written empty (`""`), which has no head at all. */
  untitled: boolean;
  /** A heading that opens a Quarto callout, which is its title and takes its head. */
  heading: SyntaxNode | null;
  /** The closing line's marks, or null. */
  close: SyntaxNode | null;
  /** A quote between `>>>` lines, drawn as a quote. */
  quote: boolean;
}

function firstBlock(node: SyntaxNode): SyntaxNode | null {
  let child = node.firstChild;
  while (child && !child.type.is('Block')) child = child.nextSibling;
  return child;
}

function readBox(d: BlockDraw, block: BlockEntry): Box | null {
  const first = block.node.firstChild;
  if (!first || first.name !== 'BoxMark') return null;
  const lineEnd = d.lines.end(block.firstLine);
  const opening = d.doc.sliceString(first.from, first.to);
  // `!!!` and `???` admonitions and `===` content tabs have an indented body.
  const indented = /^[!?=]/.test(opening);
  const quote = opening === '>>>';
  let written = '';
  let titleFrom = lineEnd;
  let titleTo = lineEnd;
  let quotes = 0;
  let attributes = null;
  for (let child = first.nextSibling; child && child.from <= lineEnd; child = child.nextSibling) {
    const text = d.doc.sliceString(child.from, child.to);
    if (child.name === 'BoxName') written = text;
    else if (child.name === 'Attributes') attributes = readAttributes(text);
    else if (child.name === 'BoxTitle') [titleFrom, titleTo] = [child.from, child.to];
    else if (child.name === 'BoxMark' && text === '"') quotes++;
  }
  if (attributes) written = attributes.classes[0] ?? '';
  const last = block.node.lastChild;
  const close = last && last !== first && last.name === 'BoxMark' && last.from > lineEnd ? last : null;
  let fold: Box['fold'] = opening.startsWith('???') ? (opening.endsWith('+') ? '+' : '-') : '';
  let look: string | null;
  let fallback: string | null;
  let label = '';
  let heading: SyntaxNode | null = null;
  if (quote || opening.startsWith('=')) {
    // A quote between `>>>` lines keeps a quote's look; a content tab is a plain box under its title.
    look = null;
    fallback = null;
  } else if (indented) {
    const lower = written.toLowerCase();
    look = calloutType(ADMONITION_ALIASES[lower] ?? lower) ?? 'note';
    fallback = written ? defaultTitle(written) : null;
  } else {
    const name = written.replace(/^callout-/i, '');
    look = calloutType(name);
    fallback = look ? defaultTitle(name) : null;
    if (!look) label = written;
    if (name.toLowerCase() === 'details') [fold, fallback, label] = ['-', 'Details', ''];
    const collapse = attributes && attribute(attributes, 'collapse');
    if (collapse === 'true' || collapse === 'false') fold = collapse === 'true' ? '-' : '+';
    const titled = attributes && attribute(attributes, 'title');
    const inside = firstBlock(block.node);
    if (titled) fallback = titled;
    // Quarto takes a heading that opens a callout as its title.
    else if (look && name !== written && inside && isAtxHeading(inside.name)) heading = inside;
  }
  const hasTitle = titleTo > titleFrom;
  return {
    block,
    indented,
    look,
    label,
    fallback: hasTitle ? null : fallback,
    fold,
    headFrom: first.from,
    headTo: hasTitle ? titleFrom : lineEnd,
    titleFrom,
    titleTo,
    untitled: (!hasTitle && quotes === 2) || heading !== null || quote,
    heading,
    close,
    quote,
  };
}

/** A plain box's head: its label between the chevron and the title. */
class BoxHead extends ContainerHead {
  protected readonly headClass = 'tm-box-head';
  protected readonly titleClass = 'tm-box-title';

  protected mark(doc: Document): HTMLElement | null {
    if (!this.kind) return null;
    const label = doc.createElement('span');
    label.className = 'tm-box-label';
    label.textContent = this.kind;
    return label;
  }
}

function drawBoxes(d: BlockDraw): void {
  const boxes: Box[] = [];
  const callouts = syntaxOn(d.ctx.settings, 'callouts');
  // The boxes and the callouts (render/callouts.ts colors those), parents before children,
  // so a line ends with the look of the innermost one holding it.
  const holders: { block: BlockEntry; look: string | null }[] = [];
  const items: BlockEntry[] = [];
  d.blocks((block) => {
    if (block.name === 'Box') {
      const box = readBox(d, block);
      if (!box) return;
      boxes.push(box);
      holders.push({ block, look: box.quote ? null : box.look ? calloutClasses(box.look) : 'tm-box-plain' });
    } else if (block.name === 'Blockquote' && callouts && isCallout(d, block)) {
      holders.push({ block, look: null });
    } else if (block.name === 'ListItem') {
      items.push(block);
    }
  });
  if (!boxes.length) return;
  const folded = new FoldedBodies();
  for (const box of boxes) {
    const { block } = box;
    if (folded.holds(block.from)) continue;
    // The head's line: the opening line, or the heading that is a Quarto callout's title. A
    // fold is known by the start of its head's line, where its chevron is.
    const headLine = box.heading ? d.lines.numberAt(box.heading.from) : block.firstLine;
    const fold = foldState(d, block, headLine, box.fold);
    drawHead(d, box, box.heading ? null : fold.chevron);
    if (box.heading) drawHeadingTitle(d, box, box.heading, fold.chevron);
    if (box.close) {
      d.line(box.close.from, 'tm-quote-gap');
      if (d.lineRevealed(box.close.from)) d.mark(box.close.from, box.close.to, 'tm-mark');
      else d.hide(box.close.from, box.close.to);
    }
    // A list in an admonition hides its lines' indentation from their start, the box's included.
    if (box.indented) {
      const base = containerBase(d, block, box.headFrom);
      hideContainerIndent(d, block, base, ADMONITION_INDENT, listLinesIn(block, items));
    }
    folded.hideClosed(d, block, fold);
  }
  for (const [n, classes] of innermostLooks(holders)) if (classes) d.line(d.lines.start(n), classes);
}

function drawHead(d: BlockDraw, box: Box, fold: 'open' | 'closed' | null): void {
  const hasTitle = box.titleTo > box.titleFrom;
  const lineEnd = d.lines.end(box.block.firstLine);
  if (box.untitled && !fold) {
    d.line(box.headFrom, 'tm-quote-gap');
  } else {
    d.line(box.headFrom, box.look ? 'tm-callout-title-line' : 'tm-box-head-line');
  }
  if (hasTitle) d.mark(box.titleFrom, box.titleTo, box.look ? 'tm-callout-title' : 'tm-box-title');
  if (d.lineRevealed(box.headFrom)) {
    d.mark(box.headFrom, box.headTo, 'tm-mark');
    if (hasTitle) d.mark(box.titleTo, lineEnd, 'tm-mark');
    return;
  }
  const source = d.doc.sliceString(box.headFrom, box.headTo);
  const title = box.untitled ? null : box.fallback;
  if (box.untitled && !fold) d.hide(box.headFrom, box.headTo);
  else if (box.look) d.replace(box.headFrom, box.headTo, new CalloutHead(source, box.look, title, fold));
  else d.replace(box.headFrom, box.headTo, new BoxHead(source, box.label, title, fold));
  if (hasTitle) d.hide(box.titleTo, lineEnd);
}

/** A Quarto callout's opening heading drawn as its title: the head before its text, at a title's size. */
function drawHeadingTitle(d: BlockDraw, box: Box, heading: SyntaxNode, fold: 'open' | 'closed' | null): void {
  d.line(heading.from, 'tm-callout-title-line tm-box-heading');
  const marks = heading.getChildren('HeaderMark');
  const lineText = d.lines.text(d.lines.numberAt(heading.from));
  const lineFrom = d.lines.start(d.lines.numberAt(heading.from));
  let textFrom = marks[0]?.to ?? heading.from;
  while (textFrom < heading.to && isSpaceOrTab(lineText.charCodeAt(textFrom - lineFrom))) textFrom++;
  const textTo = marks.length > 1 ? marks[marks.length - 1]!.from : heading.to;
  d.mark(textFrom, textTo, 'tm-callout-title');
  if (!d.lineRevealed(heading.from)) d.widget(textFrom, new CalloutHead('', box.look!, null, fold), -1);
}

const theme = EditorView.baseTheme({
  '& .cm-content .tm-quote.tm-box-plain': {
    '--tm-quote-border': 'var(--tm-border)',
    '--tm-quote-bg': 'transparent',
    color: 'var(--tm-fg)',
  },
  '& .cm-content .tm-box-head-line': { fontWeight: '600' },
  '& .cm-content .tm-h.tm-box-heading': {
    fontSize: '1em',
    lineHeight: 'inherit',
    paddingBottom: '0',
    '--tm-gap-h': '0px',
  },
  '& .cm-content .tm-box-label': {
    color: 'var(--tm-faded)',
    fontFamily: 'var(--tm-ui-font)',
    fontSize: '0.85em',
    fontWeight: 'normal',
  },
});

export const boxes: Feature = {
  id: 'boxes',
  extension: () => [turnedFolds, blockFeature('boxes', drawBoxes), calloutTheme, foldTheme, theme],
};
