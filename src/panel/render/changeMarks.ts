// Git change marks: in the Rich editor's margin, a bar beside the lines added or changed since
// the file's last commit and a short mark where lines were removed, in the colors Source's
// gutter uses for them. Clicking a mark opens a compact peek card showing the committed lines
// with a one-click Revert action. Rich view shows no change marks.

import type { ChangeDesc, ChangeSpec, EditorState, Text } from '@codemirror/state';
import { EditorView, layer, ViewPlugin, type LayerMarker, type ViewUpdate } from '@codemirror/view';
import type { ChangeMark } from '../../core/featureProtocol';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { hostRangeField, listenForHostSet } from '../hostRanges';
import { getMode } from '../modes';
import { iconButton } from '../ui/dom';
import { layerBase } from './layers';

/** The most marks a panel takes from one message. */
const MAX_TAKEN = 10_000;
/** Longest original hunk text accepted from a host message. */
const MAX_ORIGINAL_CHARS = 8_000;
/** Where the bar sits, from the left edge of the text column's box, and its width. */
const BAR_LEFT_PX = 14;
const BAR_WIDTH_PX = 3;
/** The mark for removed lines: wider than the bar, and short, centered on the line boundary. */
const REMOVED_WIDTH_PX = 8;
const REMOVED_HEIGHT_PX = 4;

const KINDS = new Set<ChangeMark['kind']>(['added', 'changed', 'removed']);

const LABELS: Record<ChangeMark['kind'], string> = {
  added: 'Added since last commit',
  changed: 'Changed since last commit',
  removed: 'Removed since last commit',
};

/** Computes the document change that reverts `mark` back to the last committed text, or null if unavailable. */
export function revertChangeMark(doc: Text, mark: ChangeMark): ChangeSpec | null {
  const from = Math.max(0, Math.min(doc.length, mark.from));
  const to = Math.max(from, Math.min(doc.length, mark.to));
  if (mark.kind === 'changed') {
    if (mark.original === undefined) return null;
    return { from, to, insert: mark.original };
  }
  if (mark.kind === 'added') {
    if (to < doc.length) return { from, to: to + 1, insert: '' };
    if (from > 0) return { from: from - 1, to, insert: '' };
    return { from: 0, to: doc.length, insert: '' };
  }
  if (mark.original === undefined) return null;
  if (mark.afterEnd) return { from: doc.length, to: doc.length, insert: `\n${mark.original}` };
  return { from, to: from, insert: `${mark.original}\n` };
}

/** A mark keeps its lines while text is typed in them; removed lines stay at the boundary before the next line. */
function mapMark(mark: ChangeMark, changes: ChangeDesc): ChangeMark {
  const from = changes.mapPos(mark.from, -1);
  const to = mark.kind === 'removed' ? from : Math.max(from, changes.mapPos(mark.to, 1));
  return from === mark.from && to === mark.to ? mark : { ...mark, from, to };
}

const marks = hostRangeField<ChangeMark>(mapMark);

/** The effect that hands the panel a set of marks, as the host sent it. */
export const setChangeMarks = marks.set;

export function changeMarksOf(state: EditorState): readonly ChangeMark[] {
  return state.field(marks.field, false)?.items ?? [];
}

export function readChangeMarks(value: unknown): ChangeMark[] {
  if (!Array.isArray(value)) return [];
  const out: ChangeMark[] = [];
  for (const v of value) {
    const m = v as Partial<ChangeMark> | null;
    if (!m || !KINDS.has(m.kind as ChangeMark['kind']) || !Number.isInteger(m.from) || !Number.isInteger(m.to))
      continue;
    if (m.from! < 0 || m.to! < m.from!) continue;
    const item: ChangeMark = { kind: m.kind!, from: m.from!, to: m.to! };
    if (typeof m.original === 'string' && m.original.length <= MAX_ORIGINAL_CHARS) item.original = m.original;
    if (m.afterEnd === true) item.afterEnd = true;
    out.push(item);
    if (out.length >= MAX_TAKEN) break;
  }
  return out;
}

class ChangeBarMarker implements LayerMarker {
  constructor(
    readonly className: string,
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly index: number,
    readonly kind: ChangeMark['kind'],
  ) {}

  draw(): HTMLElement {
    const el = document.createElement('div');
    this.adjust(el);
    return el;
  }

  update(dom: HTMLElement, oldMarker: ChangeBarMarker): boolean {
    if (
      oldMarker.className === this.className &&
      oldMarker.left === this.left &&
      oldMarker.top === this.top &&
      oldMarker.width === this.width &&
      oldMarker.height === this.height &&
      oldMarker.index === this.index &&
      oldMarker.kind === this.kind
    ) {
      return true;
    }
    this.adjust(dom);
    return true;
  }

  private adjust(dom: HTMLElement): void {
    dom.className = this.className;
    dom.style.left = `${this.left}px`;
    dom.style.top = `${this.top}px`;
    dom.style.width = `${this.width}px`;
    dom.style.height = `${this.height}px`;
    dom.dataset['markIndex'] = String(this.index);
    dom.setAttribute('role', 'button');
    dom.setAttribute('aria-label', `${LABELS[this.kind]}. Click to inspect or revert.`);
    dom.title = `${LABELS[this.kind]} (click to inspect or revert)`;
  }

  eq(other: LayerMarker): boolean {
    return (
      other instanceof ChangeBarMarker &&
      other.className === this.className &&
      other.left === this.left &&
      other.top === this.top &&
      other.width === this.width &&
      other.height === this.height &&
      other.index === this.index &&
      other.kind === this.kind
    );
  }
}

function markers(view: EditorView): ChangeBarMarker[] {
  const items = changeMarksOf(view.state);
  if (items.length === 0 || getMode(view.state) !== 'edit') return [];
  const { from: viewFrom, to: viewTo } = view.viewport;
  const length = view.state.doc.length;
  const base = layerBase(view);
  const left = (view.contentDOM.getBoundingClientRect().left - base.left) / view.scaleX + BAR_LEFT_PX;
  const y = (top: number) => (view.documentTop - base.top) / view.scaleY + top;
  const out: ChangeBarMarker[] = [];
  items.forEach((m, index) => {
    if (m.to < viewFrom || m.from > viewTo) return;
    const from = Math.min(m.from, length);
    if (m.kind === 'removed') {
      const block = view.lineBlockAt(from);
      // Removed at the very end: below the last line; otherwise at the top of the line after them.
      const at = from === length && from > block.from ? block.bottom : block.top;
      out.push(
        new ChangeBarMarker(
          'tm-change tm-change-removed',
          left - (REMOVED_WIDTH_PX - BAR_WIDTH_PX) / 2,
          y(at) - REMOVED_HEIGHT_PX / 2,
          REMOVED_WIDTH_PX,
          REMOVED_HEIGHT_PX,
          index,
          m.kind,
        ),
      );
      return;
    }
    const top = view.lineBlockAt(from).top;
    const bottom = view.lineBlockAt(Math.min(m.to, length)).bottom;
    out.push(
      new ChangeBarMarker(`tm-change tm-change-${m.kind}`, left, y(top), BAR_WIDTH_PX, bottom - top, index, m.kind),
    );
  });
  return out;
}

function redraws(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    getMode(update.startState) !== getMode(update.state) ||
    update.startState.field(marks.field, false) !== update.state.field(marks.field, false)
  );
}

/** Floating peek popover opened when clicking a git change bar in Rich editor. */
const hunkPeek = ViewPlugin.fromClass(
  class {
    private card: HTMLElement | null = null;
    private readonly onPointerDown: (event: MouseEvent) => void;
    private readonly onKeyDown: (event: KeyboardEvent) => void;
    private readonly onScroll: () => void;

    constructor(private readonly view: EditorView) {
      const doc = view.dom.ownerDocument;
      this.onPointerDown = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const bar = target.closest('.tm-change-layer .tm-change') as HTMLElement | null;
        if (bar && view.dom.contains(bar)) {
          event.preventDefault();
          event.stopPropagation();
          const index = Number(bar.dataset['markIndex']);
          const mark = Number.isInteger(index) ? changeMarksOf(view.state)[index] : undefined;
          if (mark && getMode(view.state) === 'edit') this.open(mark, bar.getBoundingClientRect());
          return;
        }
        if (this.card && !this.card.contains(target)) this.close();
      };
      this.onKeyDown = (event) => {
        if (event.key === 'Escape' && this.card) {
          event.preventDefault();
          event.stopPropagation();
          this.close();
          view.focus();
        }
      };
      this.onScroll = () => this.close();

      view.dom.addEventListener('mousedown', this.onPointerDown, true);
      doc.addEventListener('mousedown', this.onPointerDown);
      doc.addEventListener('keydown', this.onKeyDown, true);
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || getMode(update.state) !== 'edit') this.close();
    }

    private open(mark: ChangeMark, anchor: DOMRect): void {
      this.close();
      const doc = this.view.dom.ownerDocument;
      const card = doc.createElement('div');
      card.className = 'tm-hunk-peek';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', LABELS[mark.kind]);

      const head = doc.createElement('div');
      head.className = 'tm-hunk-head';
      const title = doc.createElement('span');
      title.className = 'tm-hunk-title';
      title.textContent = LABELS[mark.kind];
      head.appendChild(title);

      const actions = doc.createElement('div');
      actions.className = 'tm-hunk-actions';
      const readOnly = this.view.state.facet(panelContext)?.doc.readOnly ?? false;
      const change = !readOnly ? revertChangeMark(this.view.state.doc, mark) : null;
      if (change) {
        const revert = doc.createElement('button');
        revert.type = 'button';
        revert.className = 'tm-hunk-revert';
        revert.textContent = 'Revert';
        revert.addEventListener('mousedown', (e) => e.preventDefault());
        revert.addEventListener('click', (e) => {
          e.preventDefault();
          this.close();
          this.view.dispatch({ changes: change, userEvent: 'input.revert' });
          this.view.focus();
        });
        actions.appendChild(revert);
      }

      const closeBtn = iconButton(doc, { icon: 'close', label: 'Close', className: 'tm-hunk-close', keepFocus: true });
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
        this.view.focus();
      });
      actions.appendChild(closeBtn);
      head.appendChild(actions);
      card.appendChild(head);

      if (mark.kind === 'added') {
        const note = doc.createElement('div');
        note.className = 'tm-hunk-note';
        note.textContent = 'New lines not in the last commit.';
        card.appendChild(note);
      } else if (mark.original !== undefined) {
        const pre = doc.createElement('pre');
        pre.className = 'tm-hunk-code';
        pre.textContent = mark.original === '' ? '(blank line)' : mark.original;
        card.appendChild(pre);
      } else {
        const note = doc.createElement('div');
        note.className = 'tm-hunk-note';
        note.textContent = 'Original lines are too large to preview here. Open Source or Git diff to inspect.';
        card.appendChild(note);
      }

      const host = this.view.dom;
      host.appendChild(card);
      const hostRect = host.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const maxLeft = Math.max(8, hostRect.width - cardRect.width - 8);
      const maxTop = Math.max(8, hostRect.height - cardRect.height - 8);
      const left = Math.max(8, Math.min(maxLeft, anchor.right - hostRect.left + 8));
      const top = Math.max(8, Math.min(maxTop, anchor.top - hostRect.top));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      this.card = card;
    }

    private close(): void {
      this.card?.remove();
      this.card = null;
    }

    destroy(): void {
      this.close();
      const doc = this.view.dom.ownerDocument;
      this.view.dom.removeEventListener('mousedown', this.onPointerDown, true);
      doc.removeEventListener('mousedown', this.onPointerDown);
      doc.removeEventListener('keydown', this.onKeyDown, true);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    }
  },
);

export const changeMarks: Feature = {
  id: 'changeMarks',
  extension: () => [
    marks.field,
    listenForHostSet('changeMarks', 'marks', readChangeMarks, setChangeMarks),
    layer({ above: true, class: 'tm-change-layer', update: redraws, markers }),
    hunkPeek,
    EditorView.baseTheme({
      '& .tm-change-layer': {
        pointerEvents: 'none',
      },
      '& .tm-change-layer .tm-change': {
        position: 'absolute',
        pointerEvents: 'auto',
        cursor: 'pointer',
      },
      // Transparent wider hit target so clicking a 3px gutter bar is comfortable.
      '& .tm-change-layer .tm-change::after': {
        content: '""',
        position: 'absolute',
        inset: '-4px -5px',
      },
      '& .tm-change-layer .tm-change-added': {
        background: 'var(--vscode-editorGutter-addedBackground, #2ea043)',
      },
      '& .tm-change-layer .tm-change-changed': {
        background: 'var(--vscode-editorGutter-modifiedBackground, #0078d4)',
      },
      '& .tm-change-layer .tm-change-removed': {
        background: 'var(--vscode-editorGutter-deletedBackground, #f85149)',
      },
      '& .tm-hunk-peek': {
        position: 'absolute',
        zIndex: '20',
        minWidth: '220px',
        maxWidth: '460px',
        background: 'var(--tm-widget-bg)',
        color: 'var(--tm-widget-fg)',
        border: '1px solid var(--tm-border)',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.28)',
        fontFamily: 'var(--tm-ui-font)',
        fontSize: '12px',
        overflow: 'hidden',
      },
      '& .tm-hunk-head': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '5px 8px',
        borderBottom: '1px solid var(--tm-border)',
      },
      '& .tm-hunk-title': {
        fontWeight: '600',
        color: 'var(--tm-fg)',
      },
      '& .tm-hunk-actions': {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      },
      '& .tm-hunk-revert': {
        font: 'inherit',
        padding: '2px 8px',
        border: 'none',
        borderRadius: '2px',
        background: 'var(--tm-button-bg)',
        color: 'var(--tm-button-fg)',
        cursor: 'pointer',
      },
      '& .tm-hunk-revert:hover': { background: 'var(--tm-button-hover-bg)' },
      '& .tm-hunk-close': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '20px',
        height: '20px',
        padding: '0',
        border: 'none',
        borderRadius: '2px',
        background: 'none',
        color: 'var(--tm-faded)',
        cursor: 'pointer',
      },
      '& .tm-hunk-close:hover': { background: 'var(--tm-button2-bg)', color: 'var(--tm-fg)' },
      '& .tm-hunk-code': {
        margin: '0',
        padding: '6px 8px',
        maxHeight: '200px',
        overflow: 'auto',
        fontFamily: 'var(--tm-mono)',
        fontSize: '12px',
        lineHeight: '1.45',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: 'var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.14))',
      },
      '& .tm-hunk-note': {
        padding: '6px 8px',
        color: 'var(--tm-faded)',
      },
    }),
  ],
};
