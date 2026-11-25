// Containers that fold: callouts (callouts.ts), boxes (boxes.ts) and HTML's <details>
// (htmlBlocks.ts). Here are the folds the user has turned, by the start of their first line; the
// chevron that turns one; and what callouts and boxes draw alike: each line's look, a fold's
// state in a build, the bodies folded away, and the head that stands in for a marker.

import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { iconButton } from '../ui/dom';
import { posOf, redrawFeatureEffect, RichWidget, type BlockDraw } from './framework';
import type { BlockEntry } from './lines';

// ---------------------------------------------------------------------------
// The folds the user has turned

const toggleFold = StateEffect.define<number>();

/** The folds the user has turned; every feature that draws a fold adds it. */
export const turnedFolds = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) next = new Set([...value].map((pos) => tr.changes.mapPos(pos, 1)));
    for (const effect of tr.effects) {
      if (!effect.is(toggleFold)) continue;
      const copy = new Set(next);
      if (copy.has(effect.value)) copy.delete(effect.value);
      else copy.add(effect.value);
      next = copy;
    }
    return next;
  },
});

/** Whether the user has turned the fold whose first line starts at `lineStart`. */
export function foldTurned(state: EditorState, lineStart: number): boolean {
  return state.field(turnedFolds, false)?.has(lineStart) ?? false;
}

/** Turns the fold whose first line starts at `lineStart`, and has `feature` draw again. */
export function turnFold(view: EditorView, lineStart: number, feature: string): void {
  view.dispatch({ effects: [toggleFold.of(lineStart), redrawFeatureEffect.of(feature)] });
}

/** Whether the fold whose first line starts at `lineStart` is closed: `-` starts closed, `+` open, until turned. */
function isFolded(state: EditorState, fold: '' | '+' | '-', lineStart: number): boolean {
  return fold !== '' && (fold === '-') !== foldTurned(state, lineStart);
}

// ---------------------------------------------------------------------------
// The chevron

/** The chevron of a fold that is `open` or not; `className` names whose it is. */
export function chevron(doc: Document, open: boolean, className: string): HTMLButtonElement {
  const button = iconButton(doc, {
    icon: open ? 'chevron-down' : 'chevron-right',
    label: open ? 'Fold' : 'Unfold',
    className: `tm-fold ${className}`,
    keepFocus: true,
  });
  button.setAttribute('aria-expanded', String(open));
  return button;
}

/** The chevron that opens and closes the fold whose head is `head`, which the drawing `feature` draws. */
function foldButton(view: EditorView, head: HTMLElement, fold: 'open' | 'closed', feature: string): HTMLElement {
  const button = chevron(view.dom.ownerDocument, fold === 'open', 'tm-callout-fold');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const at = posOf(view, head);
    if (at === null) return;
    turnFold(view, view.state.doc.lineAt(at).from, feature);
  });
  return button;
}

// ---------------------------------------------------------------------------
// Drawing a callout or a box

/** Each line's look: the innermost of `holders` (parents before children) that holds it. */
export function innermostLooks<T>(holders: readonly { block: BlockEntry; look: T }[]): Map<number, T> {
  const looks = new Map<number, T>();
  for (const h of holders) for (let n = h.block.firstLine; n <= h.block.lastLine; n++) looks.set(n, h.look);
  return looks;
}

/** A fold in a build: where its body starts (-1 when it has none), and whether it shows open. */
export interface FoldState {
  bodyFrom: number;
  open: boolean;
  /** The chevron's state; null when the container does not fold or has no body. */
  chevron: 'open' | 'closed' | null;
}

/**
 * The fold of `block`, whose head is line `headLine` and whose sign is `sign` (`-` closed, `+`
 * open, '' for none): closed as the sign and the user's turns say, but open while the cursor is
 * in its body.
 */
export function foldState(d: BlockDraw, block: BlockEntry, headLine: number, sign: '' | '+' | '-'): FoldState {
  const bodyFrom = headLine < block.lastLine ? d.lines.start(headLine + 1) : -1;
  const closed = isFolded(d.state, sign, d.lines.start(headLine));
  const open = !closed || (bodyFrom >= 0 && d.blockRevealed(bodyFrom, block.to));
  return { bodyFrom, open, chevron: sign && bodyFrom >= 0 ? (open ? 'open' : 'closed') : null };
}

/** The bodies a build has folded away; a container inside one is not drawn. */
export class FoldedBodies {
  private readonly spans: { from: number; to: number }[] = [];

  holds(pos: number): boolean {
    return this.spans.some((s) => pos >= s.from && pos <= s.to);
  }

  /** Hides the body of `block` when `fold` is closed. */
  hideClosed(d: BlockDraw, block: BlockEntry, fold: FoldState): void {
    if (fold.open || fold.bodyFrom < 0) return;
    d.hideLines(fold.bodyFrom, block.to);
    this.spans.push({ from: fold.bodyFrom, to: block.to });
  }
}

/**
 * What stands in for a callout's or a box's marker: the chevron when it folds, its mark (a
 * callout's icon, a box's label), and its title when the file gives none.
 */
export abstract class ContainerHead extends RichWidget {
  constructor(
    source: string,
    /** What tells two heads of one class apart: a callout's type, a box's label. */
    readonly kind: string,
    readonly title: string | null,
    readonly fold: 'open' | 'closed' | null,
  ) {
    super(source);
  }

  protected abstract readonly headClass: string;
  protected abstract readonly titleClass: string;
  /** What stands between the chevron and the title, or null for nothing. */
  protected abstract mark(doc: Document): HTMLElement | null;

  override sameAs(other: this): boolean {
    return other.kind === this.kind && other.title === this.title && other.fold === this.fold;
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const head = doc.createElement('span');
    head.className = this.headClass;
    if (this.fold) head.appendChild(foldButton(view, head, this.fold, this.feature));
    const mark = this.mark(doc);
    if (mark) head.appendChild(mark);
    if (this.title !== null) {
      const title = doc.createElement('span');
      title.className = this.titleClass;
      title.textContent = this.title;
      head.appendChild(title);
    }
    return head;
  }

  override ignores(): boolean {
    return true;
  }
}

/** The chevron's and the heads' styles; every feature that draws a fold or a head adds it. */
export const foldTheme = EditorView.baseTheme({
  '& .cm-content .tm-callout-head, & .cm-content .tm-box-head': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4em',
    marginRight: '0.4em',
    verticalAlign: 'top',
  },
  '& .cm-content .tm-fold': {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0',
    border: 'none',
    background: 'none',
    color: 'inherit',
    cursor: 'pointer',
  },
  '& .cm-content .tm-fold:focus-visible': { outline: '1px solid var(--tm-focus)' },
});
