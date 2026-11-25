// Callouts and alerts, a quote whose first line is `[!type]`: a colored box, icon and title.
//
//   > [!NOTE]                      GitHub's five types (note, tip, important, warning, caution)
//   > [!faq]- Are they foldable?   Obsidian's: thirteen types with aliases, any letter case,
//   > Yes.                         a title after the marker, `+` or `-` to fold
//
// GitHub's five take GitHub's colors and icons, Obsidian's other types Obsidian's, and a type no
// program knows the note's look with its own name, as in Obsidian; with no title, the type's name
// is the title. The marker shows only with the cursor on its line in Rich editor. Only a callout
// whose file has the sign folds (`-` closed, `+` open); the chevron or the cursor opens it. A
// callout in a callout is a box in a box, a line colored by the innermost. The quote feature
// draws the quote (bars, hidden `>`); this one colors it, and render/boxes.ts takes its looks.

import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { Feature } from '../features';
import { icon } from '../ui/dom';
import { ContainerHead, FoldedBodies, foldState, foldTheme, innermostLooks, turnedFolds } from './folds';
import { blockFeature, type BlockDraw } from './framework';
import type { BlockEntry } from './lines';

/** Each type's look: GitHub's for its five, Obsidian's for the rest. */
const LOOKS: Record<string, { icon: string; github: boolean }> = {
  note: { icon: 'info', github: true },
  tip: { icon: 'lightbulb', github: true },
  important: { icon: 'report', github: true },
  warning: { icon: 'warning', github: true },
  caution: { icon: 'stop-circle', github: true },
  abstract: { icon: 'checklist', github: false },
  info: { icon: 'info', github: false },
  todo: { icon: 'pass', github: false },
  success: { icon: 'check', github: false },
  question: { icon: 'question', github: false },
  failure: { icon: 'close', github: false },
  danger: { icon: 'zap', github: false },
  bug: { icon: 'bug', github: false },
  example: { icon: 'list-ordered', github: false },
  quote: { icon: 'quote', github: false },
};

/** Obsidian's aliases, less `important` and `caution`, which are GitHub's own types. */
const ALIASES: Record<string, string> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

/** The codicon a callout of `type` (one `calloutType` gives) shows. */
export function calloutIcon(type: string): string {
  return LOOKS[type]!.icon;
}

/** The look a callout or box named `name` takes, in any letter case and through aliases; null for a name with none. */
export function calloutType(name: string): string | null {
  const lower = name.toLowerCase();
  return ALIASES[lower] ?? (LOOKS[lower] ? lower : null);
}

/** The line classes that give a line `type`'s look. */
export function calloutClasses(type: string): string {
  return `tm-callout tm-callout-${type}`;
}

const MARKER = /^\[!([\p{L}\p{N}_-]+)\]([+-]?)(?:[ \t]+(.*))?$/u;

interface Callout {
  block: BlockEntry;
  /** The type whose look it takes. */
  type: string;
  /** The type as written, for a title. */
  written: string;
  fold: '' | '+' | '-';
  /** The marker, the fold sign and the spaces after them. */
  markerFrom: number;
  markerTo: number;
  /** The title as written; empty when there is none. */
  titleFrom: number;
  titleTo: number;
}

/** The callout `block` is, or null when it is a plain quote. */
function readCallout(d: BlockDraw, block: BlockEntry): Callout | null {
  let first: SyntaxNode | null = block.node.firstChild;
  while (first && !first.type.is('Block')) first = first.nextSibling;
  if (!first || first.name !== 'Paragraph' || d.lines.numberAt(first.from) !== block.firstLine) return null;
  const line = d.lines.get(block.firstLine);
  const text = line.text.slice(first.from - line.from);
  const match = MARKER.exec(text);
  if (!match) return null;
  const written = match[1]!;
  const type = calloutType(written) ?? 'note';
  const title = (match[3] ?? '').trimEnd();
  const titleFrom = first.from + text.length - (match[3]?.length ?? 0);
  return {
    block,
    type,
    written,
    fold: match[2] as '' | '+' | '-',
    markerFrom: first.from,
    markerTo: title ? titleFrom : line.to,
    titleFrom: title ? titleFrom : line.to,
    titleTo: title ? titleFrom + title.length : line.to,
  };
}

/** A callout's title as Obsidian makes it from the type: its first letter in capitals. */
export function defaultTitle(written: string): string {
  const lower = written.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------------------------------------------------------------------------
// Drawing

/** A callout's head: its type's icon between the chevron and the title. */
export class CalloutHead extends ContainerHead {
  protected readonly headClass = 'tm-callout-head';
  protected readonly titleClass = 'tm-callout-title';

  protected mark(doc: Document): HTMLElement {
    const mark = icon(doc, calloutIcon(this.kind));
    mark.classList.add('tm-callout-icon');
    return mark;
  }
}

/** Whether `block`, a quote, is drawn as a callout. */
export function isCallout(d: BlockDraw, block: BlockEntry): boolean {
  return readCallout(d, block) !== null;
}

function drawCallouts(d: BlockDraw): void {
  const callouts: Callout[] = [];
  // The callouts and the boxes (render/boxes.ts colors those), parents before children, so
  // a line ends with the look of the innermost one holding it.
  const holders: { block: BlockEntry; look: string | null }[] = [];
  d.blocks((block) => {
    if (block.name === 'Box') holders.push({ block, look: null });
    if (block.name !== 'Blockquote') return;
    const callout = readCallout(d, block);
    if (!callout) return;
    callouts.push(callout);
    holders.push({ block, look: callout.type });
  });
  if (!callouts.length) return;
  const folded = new FoldedBodies();
  for (const c of callouts) {
    if (folded.holds(c.block.from)) continue;
    const fold = foldState(d, c.block, c.block.firstLine, c.fold);
    d.line(d.lines.start(c.block.firstLine), 'tm-callout-title-line');
    const hasTitle = c.titleTo > c.titleFrom;
    if (hasTitle) d.mark(c.titleFrom, c.titleTo, 'tm-callout-title');
    if (d.lineRevealed(c.markerFrom)) {
      d.mark(c.markerFrom, c.markerTo, 'tm-mark');
    } else {
      const source = d.doc.sliceString(c.markerFrom, c.markerTo);
      const title = hasTitle ? null : defaultTitle(c.written);
      d.replace(c.markerFrom, c.markerTo, new CalloutHead(source, c.type, title, fold.chevron));
    }
    folded.hideClosed(d, c.block, fold);
  }
  for (const [n, type] of innermostLooks(holders)) if (type) d.line(d.lines.start(n), calloutClasses(type));
}

/** Colors: GitHub's alert colors for its five types, Obsidian's callout colors for the rest, dark then light. */
const COLORS: Record<string, [string, string]> = {
  note: ['#4493f8', '#0969da'],
  tip: ['#3fb950', '#1a7f37'],
  important: ['#ab7df8', '#8250df'],
  warning: ['#d29922', '#9a6700'],
  caution: ['#f85149', '#d1242f'],
  abstract: ['rgb(0, 191, 188)', 'rgb(0, 150, 148)'],
  info: ['rgb(8, 109, 221)', 'rgb(8, 109, 221)'],
  todo: ['rgb(8, 109, 221)', 'rgb(8, 109, 221)'],
  success: ['rgb(8, 185, 78)', 'rgb(8, 150, 64)'],
  question: ['rgb(236, 117, 0)', 'rgb(200, 100, 0)'],
  failure: ['rgb(233, 49, 71)', 'rgb(210, 40, 60)'],
  danger: ['rgb(233, 49, 71)', 'rgb(210, 40, 60)'],
  bug: ['rgb(233, 49, 71)', 'rgb(210, 40, 60)'],
  example: ['rgb(120, 82, 238)', 'rgb(110, 70, 220)'],
  quote: ['rgb(158, 158, 158)', 'rgb(120, 120, 120)'],
};

function colorRules(): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  for (const [type, [dark, light]] of Object.entries(COLORS)) {
    const look = LOOKS[type]!;
    // GitHub's alerts have no tint behind them; Obsidian's callouts do.
    const tint = (color: string) => (look.github ? 'transparent' : `color-mix(in srgb, ${color} 10%, transparent)`);
    rules[`& .cm-content .tm-callout-${type}`] = { '--tm-callout': dark, '--tm-callout-bg': tint(dark) };
    rules[`.vscode-light & .cm-content .tm-callout-${type}`] = {
      '--tm-callout': light,
      '--tm-callout-bg': tint(light),
    };
  }
  return rules;
}

/** The looks' colors and the head's styles; every feature that draws a look adds it. */
export const calloutTheme = EditorView.baseTheme({
  ...colorRules(),
  '& .cm-content .tm-quote.tm-callout': {
    '--tm-quote-border': 'var(--tm-callout)',
    '--tm-quote-bg': 'var(--tm-callout-bg)',
    color: 'var(--tm-fg)',
  },
  '& .cm-content .tm-callout-title-line': { fontWeight: '600' },
  '& .cm-content .tm-callout-title, & .cm-content .tm-callout-head': { color: 'var(--tm-callout)' },
});

export const callouts: Feature = {
  id: 'callouts',
  extension: () => [turnedFolds, blockFeature('callouts', drawCallouts), calloutTheme, foldTheme],
};
