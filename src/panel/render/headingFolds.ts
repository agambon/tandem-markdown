// Heading section folding in Rich editor and Rich view: each foldable heading shows a margin
// chevron (hover-revealed while open, always visible with a clickable ellipsis pill while folded),
// hides its entire subtree up to the next heading of equal or higher level, and automatically
// unfolds whenever the cursor, Outline, TOC, or a `#heading` link navigates inside.

import { EditorState, RangeSet, StateEffect, StateField, type Range, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { allFoldableHeadings, headingSectionAtLine, type HeadingSection } from '../../core/headingSections';
import type { Feature } from '../features';
import { headingLevel } from '../markdown/nodes';
import { getMode } from '../modes';
import { iconButton } from '../ui/dom';
import { foldTheme } from './folds';
import { blockFeature, LinkedRun, posOf, redrawFeatureEffect, RichWidget, type BlockDraw } from './framework';
import type { BlockEntry } from './lines';

const FEATURE = 'headingFolds';

/** Toggles folding for the heading whose line starts at the given offset. */
export const toggleHeadingFoldEffect = StateEffect.define<number>();
/** Replaces the complete set of folded heading line-start offsets (Fold All / Unfold All). */
export const setHeadingFoldsEffect = StateEffect.define<ReadonlySet<number>>();
/** Unfolds every heading section whose folded body contains the given offset. */
export const unfoldHeadingAtEffect = StateEffect.define<number>();

const EMPTY_SET: ReadonlySet<number> = new Set();

function activeFoldedSections(state: EditorState, folded: ReadonlySet<number>): HeadingSection[] {
  if (folded.size === 0) return [];
  const starts = [...folded].sort((a, b) => a - b);
  const out: HeadingSection[] = [];
  let hiddenUntil = -1;
  for (const pos of starts) {
    if (pos < 0 || pos > state.doc.length) continue;
    if (pos <= hiddenUntil) continue;
    const line = state.doc.lineAt(pos);
    const sec = headingSectionAtLine(state.doc, line.number);
    if (!sec || !sec.hasBody) continue;
    out.push(sec);
    hiddenUntil = sec.sectionEnd;
  }
  return out;
}

/** Line-start offsets of currently folded headings. */
export const foldedHeadings = StateField.define<ReadonlySet<number>>({
  create: () => EMPTY_SET,
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.size > 0) {
      const mapped = new Set<number>();
      for (const pos of next) {
        const at = tr.changes.mapPos(pos, 1);
        if (at >= 0 && at <= tr.state.doc.length) {
          const line = tr.state.doc.lineAt(at);
          if (headingSectionAtLine(tr.state.doc, line.number)?.hasBody) mapped.add(line.from);
        }
      }
      next = mapped;
    }

    for (const effect of tr.effects) {
      if (effect.is(toggleHeadingFoldEffect)) {
        const pos = Math.max(0, Math.min(tr.state.doc.length, effect.value));
        const line = tr.state.doc.lineAt(pos);
        const copy = new Set(next);
        if (copy.has(line.from)) copy.delete(line.from);
        else if (headingSectionAtLine(tr.state.doc, line.number)?.hasBody) copy.add(line.from);
        next = copy;
      } else if (effect.is(setHeadingFoldsEffect)) {
        const copy = new Set<number>();
        for (const pos of effect.value) {
          if (pos < 0 || pos > tr.state.doc.length) continue;
          const line = tr.state.doc.lineAt(pos);
          if (headingSectionAtLine(tr.state.doc, line.number)?.hasBody) copy.add(line.from);
        }
        next = copy;
      } else if (effect.is(unfoldHeadingAtEffect) && next.size > 0) {
        const target = effect.value;
        let changed = false;
        const copy = new Set(next);
        for (const pos of next) {
          const line = tr.state.doc.lineAt(pos);
          const sec = headingSectionAtLine(tr.state.doc, line.number);
          if (!sec || !sec.hasBody || (target >= sec.bodyFrom && target <= sec.sectionEnd)) {
            copy.delete(pos);
            changed = true;
          }
        }
        if (changed) next = copy;
      }
    }
    return next;
  },
});

/** Auto-unfolds any section whose folded body a selection lands inside (Rich editor). */
const autoUnfoldOnSelection = EditorState.transactionExtender.of((tr: Transaction) => {
  if (!tr.selection) return null;
  const startFolded = tr.startState.field(foldedHeadings, false);
  if (!startFolded || startFolded.size === 0 || getMode(tr.startState) !== 'edit') return null;
  const doc = tr.newDoc;
  const hits: number[] = [];
  for (const rawPos of startFolded) {
    const mapped = tr.docChanged ? tr.changes.mapPos(rawPos, 1) : rawPos;
    if (mapped < 0 || mapped > doc.length) continue;
    const sec = headingSectionAtLine(doc, doc.lineAt(mapped).number);
    if (!sec || !sec.hasBody) continue;
    for (const range of tr.selection.ranges) {
      if (range.from <= sec.sectionEnd && range.to >= sec.bodyFrom) {
        hits.push(Math.max(sec.bodyFrom, range.from));
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  return {
    effects: [...hits.map((pos) => unfoldHeadingAtEffect.of(pos)), redrawFeatureEffect.of(FEATURE)],
  };
});

/** Linked runs for active folded sections so edits anywhere inside a folded section redraw it cleanly. */
function foldedRuns(state: EditorState): RangeSet<LinkedRun> {
  const folded = state.field(foldedHeadings, false);
  if (!folded || folded.size === 0) return RangeSet.empty;
  const ranges: Range<LinkedRun>[] = [];
  for (const sec of activeFoldedSections(state, folded)) {
    ranges.push(new LinkedRun(`${sec.headStart}:${sec.sectionEnd}`).range(sec.headStart, sec.sectionEnd));
  }
  return RangeSet.of(ranges, true);
}

/** Margin chevron button on a foldable heading line. Adds no text to `plainText` / `visibleText`. */
class HeadingFoldButton extends RichWidget {
  constructor(readonly open: boolean) {
    super('');
  }

  override sameAs(other: HeadingFoldButton): boolean {
    return other.open === this.open;
  }

  override get plainText(): string {
    return '';
  }

  draw(view: EditorView): HTMLElement {
    const button = iconButton(view.dom.ownerDocument, {
      icon: this.open ? 'chevron-down' : 'chevron-right',
      label: this.open ? 'Fold section' : 'Unfold section',
      className: this.open ? 'tm-fold tm-heading-fold' : 'tm-fold tm-heading-fold tm-heading-fold-closed',
      keepFocus: true,
    });
    button.setAttribute('aria-expanded', String(this.open));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const at = posOf(view, button);
      if (at === null) return;
      toggleSectionAt(view, view.state.doc.lineAt(at).from);
    });
    return button;
  }

  override ignores(): boolean {
    return true;
  }
}

/** Subtle clickable ellipsis pill at the end of a folded heading line. */
class FoldedEllipsis extends RichWidget {
  constructor() {
    super('');
  }

  override sameAs(): boolean {
    return true;
  }

  override get plainText(): string {
    return '';
  }

  draw(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'tm-fold-pill tm-stop';
    button.textContent = '…';
    button.setAttribute('aria-label', 'Unfold section');
    button.title = 'Unfold section';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const at = posOf(view, button);
      if (at === null) return;
      toggleSectionAt(view, view.state.doc.lineAt(at).from);
    });
    return button;
  }

  override ignores(): boolean {
    return true;
  }
}

function toggleSectionAt(view: EditorView, lineStart: number): void {
  const folded = view.state.field(foldedHeadings, false) ?? EMPTY_SET;
  const line = view.state.doc.lineAt(lineStart);
  const sec = headingSectionAtLine(view.state.doc, line.number);
  if (!sec || !sec.hasBody) return;
  const folding = !folded.has(line.from);
  // If folding while the cursor sits inside the body, pull cursor up to the heading line so auto-unfold does not undo it.
  const sel = view.state.selection.main;
  const moveCursor = folding && getMode(view.state) === 'edit' && sel.to >= sec.bodyFrom && sel.from <= sec.sectionEnd;
  view.dispatch({
    ...(moveCursor ? { selection: { anchor: line.to } } : {}),
    effects: [toggleHeadingFoldEffect.of(line.from), redrawFeatureEffect.of(FEATURE)],
  });
}

function isFoldableTopHeading(d: BlockDraw, block: BlockEntry): boolean {
  const level = headingLevel(block.name);
  if (!level) return false;
  const next = block.node.nextSibling;
  if (next !== null) {
    const nextLevel = headingLevel(next.name);
    return nextLevel === 0 || nextLevel > level;
  }
  // Past the parsed tree boundary on large documents, fall back to a fast line scan.
  if (block.to < d.doc.length) return headingSectionAtLine(d.doc, block.firstLine)?.hasBody === true;
  return false;
}

function draw(d: BlockDraw): void {
  const folded = d.state.field(foldedHeadings, false) ?? EMPTY_SET;
  const sections = activeFoldedSections(d.state, folded);
  const inFoldedBody = (pos: number) => sections.some((s) => pos >= s.bodyFrom && pos <= s.sectionEnd);

  for (const sec of sections) {
    if (sec.sectionEnd < d.from || sec.headStart > d.to) continue;
    if (sec.bodyFrom <= sec.sectionEnd) d.hideLines(sec.bodyFrom, sec.sectionEnd);
    if (sec.headStart >= d.from && sec.headStart <= d.to) {
      d.line(sec.headStart, 'tm-heading-folded');
      d.widget(sec.headStart, new HeadingFoldButton(false), -1);
      d.widget(d.lines.end(sec.headLine), new FoldedEllipsis(), 1);
    }
  }

  d.blocks((block) => {
    if (!block.top || headingLevel(block.name) === 0) return;
    if (folded.has(block.from) || inFoldedBody(block.from)) return;
    if (!isFoldableTopHeading(d, block)) return;
    d.widget(block.from, new HeadingFoldButton(true), -1);
  });
}

/** Finds the heading section at or enclosing the cursor line and toggles its fold. */
function toggleFoldCommand(view: EditorView): boolean {
  const { state } = view;
  const headLine = state.doc.lineAt(state.selection.main.head).number;
  const direct = headingSectionAtLine(state.doc, headLine);
  if (direct?.hasBody) {
    toggleSectionAt(view, direct.headStart);
    return true;
  }
  const all = allFoldableHeadings(state.doc);
  let enclosing: HeadingSection | null = null;
  for (const sec of all) {
    if (sec.headLine <= headLine && headLine <= sec.sectionEndLine) enclosing = sec;
  }
  if (!enclosing) return false;
  toggleSectionAt(view, enclosing.headStart);
  return true;
}

/** Folds every foldable heading section in the document. */
function foldAllCommand(view: EditorView): boolean {
  const { state } = view;
  const all = allFoldableHeadings(state.doc);
  if (all.length === 0) return false;
  const next = new Set(all.map((s) => s.headStart));
  const head = state.selection.main.head;
  let anchor: number | undefined;
  if (getMode(state) === 'edit') {
    // Place cursor on the outermost enclosing folded heading line so auto-unfold does not immediately re-open it.
    const active = activeFoldedSections(state, next);
    const hit = active.find((s) => head >= s.bodyFrom && head <= s.sectionEnd);
    if (hit) anchor = state.doc.lineAt(hit.headStart).to;
  }
  view.dispatch({
    ...(anchor !== undefined ? { selection: { anchor } } : {}),
    effects: [setHeadingFoldsEffect.of(next), redrawFeatureEffect.of(FEATURE)],
  });
  return true;
}

/** Unfolds every folded heading section in the document. */
function unfoldAllCommand(view: EditorView): boolean {
  const folded = view.state.field(foldedHeadings, false);
  if (!folded || folded.size === 0) return false;
  view.dispatch({ effects: [setHeadingFoldsEffect.of(EMPTY_SET), redrawFeatureEffect.of(FEATURE)] });
  return true;
}

const theme = EditorView.baseTheme({
  '& .cm-content .tm-heading-fold': {
    position: 'absolute',
    left: '-22px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '20px',
    height: '20px',
    justifyContent: 'center',
    borderRadius: '3px',
    color: 'var(--tm-faded)',
    opacity: '0',
    transition: 'opacity 100ms ease',
  },
  '& .cm-content .tm-h:hover > .tm-heading-fold, & .cm-content .tm-heading-fold:focus-visible, & .cm-content .tm-heading-fold-closed':
    {
      opacity: '0.85',
    },
  '& .cm-content .tm-heading-fold:hover': {
    opacity: '1',
    background: 'var(--tm-button2-bg)',
    color: 'var(--tm-fg)',
  },
  '& .cm-content .tm-fold-pill': {
    display: 'inline-flex',
    alignItems: 'center',
    marginLeft: '0.45em',
    padding: '0 6px',
    border: '1px solid var(--tm-border)',
    borderRadius: '3px',
    background: 'var(--tm-code-bg)',
    color: 'var(--tm-faded)',
    fontFamily: 'var(--tm-ui-font)',
    fontSize: '0.6em',
    lineHeight: '1.3',
    verticalAlign: 'middle',
    cursor: 'pointer',
  },
  '& .cm-content .tm-fold-pill:hover': {
    background: 'var(--tm-button2-bg)',
    color: 'var(--tm-fg)',
  },
  '& .cm-content .tm-fold-pill:focus-visible': {
    outline: '1px solid var(--tm-focus)',
  },
});

export const headingFolds: Feature = {
  id: FEATURE,
  extension: () => [
    foldedHeadings,
    autoUnfoldOnSelection,
    blockFeature(FEATURE, draw, { linked: foldedRuns }),
    foldTheme,
    theme,
  ],
  commands: {
    toggleFold: toggleFoldCommand,
    foldAll: foldAllCommand,
    unfoldAll: unfoldAllCommand,
  },
};
