// A diagram opened large: its picture over the whole tab, to read and move around a wide one. The
// button at a drawn diagram's corner opens it (render/diagrams.ts) with the picture already
// drawn, so nothing is drawn again and the note never changes. It opens showing the whole
// diagram as large as fits. Buttons and keys zoom out (-), zoom in (+) and show the whole
// diagram again (0); a drag, the arrow keys or the scroll wheel move it; Ctrl with the wheel, or
// a pinch, zooms at the pointer. Close, or Escape, puts it away and gives focus back. Find and
// Replace put it away first (`closeDiagramView`), since the search bar's matches are in the note
// it hides.
//
// While it is open no key or command changes the note behind it: the editor is read-only, as while
// a resync is pending, and focus in the view counts as a field's (focus.ts), which keeps VS Code's
// undo and the editor's keys away. It sits outside the editor element, so its styles go in
// through a global style module (`largeDiagramView`), as the toolbar's do.

import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { StyleModule } from 'style-mod';
import { panelContext } from '../context';
import { iconButton } from './dom';

interface ViewedPicture {
  src: string;
  width: number;
  height: number;
  label: string;
}

const ZOOM_STEP = 1.25;
const ARROW_STEP = 40; // px
const MARGIN = 24; // px around the fitted diagram
const ZOOM_OUT_LIMIT = 4; // factor below whole-diagram scale
const ZOOM_IN_LIMIT = 8; // factor above max(whole-diagram scale, 1)
const WHEEL_LINE = 16; // px per DOM_DELTA_LINE step
/** Zoom per wheel pixel with Ctrl: one 100 px mouse notch zooms by ~20%. */
const WHEEL_ZOOM = 0.002;

const styles = new StyleModule({
  '.tm-diagram-view': {
    position: 'fixed',
    inset: '0',
    zIndex: '100',
    background: 'var(--tm-bg)',
    color: 'var(--tm-fg)',
    outline: 'none',
  },
  '.tm-diagram-view-stage': {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    cursor: 'grab',
    touchAction: 'none',
  },
  '.tm-diagram-view-stage.tm-dragging': { cursor: 'grabbing' },
  '.tm-diagram-view-stage img': {
    position: 'absolute',
    left: '0',
    top: '0',
    maxWidth: 'none',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  '.tm-diagram-view-bar': {
    position: 'absolute',
    top: '8px',
    right: '8px',
    display: 'flex',
    gap: '2px',
    padding: '2px',
    borderRadius: '4px',
    background: 'var(--tm-widget-bg)',
    border: '1px solid var(--tm-border)',
  },
  '.tm-diagram-view-bar button': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    padding: '0',
    border: 'none',
    borderRadius: '3px',
    background: 'none',
    color: 'var(--tm-widget-fg)',
    cursor: 'pointer',
  },
  '.tm-diagram-view-bar button:hover': {
    background: 'var(--vscode-toolbar-hoverBackground, var(--tm-button2-bg))',
  },
  '.tm-diagram-view-bar button:focus-visible': { outline: '1px solid var(--tm-focus)', outlineOffset: '-1px' },
});

interface Place {
  x: number;
  y: number;
  scale: number;
}

const lockEffect = StateEffect.define<boolean>();

/** Whether a diagram is open large: the editor is then read-only, given at the highest precedence as the resync lock is. */
const lockField = StateField.define<boolean>({
  create: () => false,
  update: (locked, tr) => tr.effects.reduce((value, e) => (e.is(lockEffect) ? e.value : value), locked),
  provide: (field) =>
    Prec.highest(EditorState.readOnly.computeN([field], (state) => (state.field(field) ? [true] : []))),
});

/** The open view of an editor. When the editor's state is replaced (a resync) or the editor goes, the view goes too. */
class OpenView {
  /** Takes the view off the page, as the editor's state is replaced or the editor goes. */
  close: (() => void) | null = null;
  /** Puts the view away for the search bar: the editor takes edits again and the search bar takes focus. */
  giveWay: (() => void) | null = null;
  destroy(): void {
    this.close?.();
  }
}

const openView = ViewPlugin.fromClass(OpenView);

/**
 * Puts away a diagram open large over `view`, for the search bar, which looks through the note
 * the view hides.
 */
export function closeDiagramView(view: EditorView): void {
  view.plugin(openView)?.giveWay?.();
}

export const largeDiagramView = [lockField, openView, EditorView.styleModule.of(styles)];

/**
 * Opens `picture` large over `view`'s panel, inside the panel's root element. Focus moves into
 * the view, and goes back to what had it when the view closes, or to the editor when that is gone.
 */
export function openDiagramView(view: EditorView, picture: ViewedPicture): void {
  const holder = view.plugin(openView);
  if (!holder || holder.close) return;
  const doc = view.dom.ownerDocument;
  const root = view.state.facet(panelContext)?.slots.editor.parentElement ?? doc.body;
  const before = doc.activeElement;
  const dialog = doc.createElement('div');
  dialog.className = 'tm-diagram-view';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', picture.label);
  dialog.tabIndex = -1;
  const stage = doc.createElement('div');
  stage.className = 'tm-diagram-view-stage';
  const img = doc.createElement('img');
  img.alt = picture.label;
  img.draggable = false;
  img.src = picture.src;
  stage.appendChild(img);

  let place: Place = { x: 0, y: 0, scale: 1 };
  const wholeScale = () =>
    Math.min(
      Math.max(1, stage.clientWidth - 2 * MARGIN) / picture.width,
      Math.max(1, stage.clientHeight - 2 * MARGIN) / picture.height,
    );
  const show = (next: Place) => {
    const whole = wholeScale();
    const scale = Math.min(Math.max(next.scale, whole / ZOOM_OUT_LIMIT), Math.max(whole, 1) * ZOOM_IN_LIMIT);
    const width = picture.width * scale;
    const height = picture.height * scale;
    // Some of the diagram stays in view, however far it is moved.
    const x = Math.min(Math.max(next.x, MARGIN - width), stage.clientWidth - MARGIN);
    const y = Math.min(Math.max(next.y, MARGIN - height), stage.clientHeight - MARGIN);
    place = { x, y, scale };
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    img.style.transform = `translate(${x}px, ${y}px)`;
  };
  const showWhole = () => {
    const scale = wholeScale();
    show({
      scale,
      x: (stage.clientWidth - picture.width * scale) / 2,
      y: (stage.clientHeight - picture.height * scale) / 2,
    });
  };
  /** Zooms by `factor`, keeping the point at `cx`, `cy` of the stage where it is. */
  const zoomAt = (factor: number, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) => {
    const scale = place.scale * factor;
    const ratio = scale / place.scale;
    show({ scale, x: cx - (cx - place.x) * ratio, y: cy - (cy - place.y) * ratio });
  };
  const moveBy = (dx: number, dy: number) => show({ ...place, x: place.x + dx, y: place.y + dy });

  const close = (giveFocusBack: boolean) => {
    holder.close = null;
    holder.giveWay = null;
    dialog.remove();
    view.dispatch({ effects: lockEffect.of(false) });
    if (!giveFocusBack) return;
    if (before instanceof HTMLElement && before !== doc.body && before.isConnected) before.focus();
    else view.focus();
  };
  const bar = doc.createElement('div');
  bar.className = 'tm-diagram-view-bar';
  // Each button's tooltip names its key, the page's own and the same on every system.
  const buttons: [string, string, () => void][] = [
    ['zoom-out', 'Zoom out (-)', () => zoomAt(1 / ZOOM_STEP)],
    ['zoom-in', 'Zoom in (+)', () => zoomAt(ZOOM_STEP)],
    ['screen-normal', 'Show the whole diagram (0)', showWhole],
    ['close', 'Close (Escape)', () => close(true)],
  ];
  for (const [icon, label, act] of buttons) {
    const button = iconButton(doc, { icon, label, className: 'tm-diagram-view-button' });
    button.addEventListener('click', act);
    bar.appendChild(button);
  }

  dialog.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'Escape':
        close(true);
        break;
      case '-':
      case '_':
        zoomAt(1 / ZOOM_STEP);
        break;
      case '+':
      case '=':
        zoomAt(ZOOM_STEP);
        break;
      case '0':
        showWhole();
        break;
      case 'ArrowLeft':
        moveBy(ARROW_STEP, 0);
        break;
      case 'ArrowRight':
        moveBy(-ARROW_STEP, 0);
        break;
      case 'ArrowUp':
        moveBy(0, ARROW_STEP);
        break;
      case 'ArrowDown':
        moveBy(0, -ARROW_STEP);
        break;
      case 'Tab': {
        // Focus stays in the view while it is open.
        const all = [...bar.querySelectorAll('button')];
        const at = all.indexOf(doc.activeElement as HTMLButtonElement);
        const next = event.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : (at + 1) % all.length;
        all[next]!.focus();
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  let drag: { id: number; x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('tm-dragging');
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    moveBy(event.clientX - drag.x, event.clientY - drag.y);
    drag = { ...drag, x: event.clientX, y: event.clientY };
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    stage.classList.remove('tm-dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE : 1;
      // A pinch on a trackpad arrives as the wheel with Ctrl.
      if (event.ctrlKey || event.metaKey) {
        const box = stage.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * unit * WHEEL_ZOOM), event.clientX - box.left, event.clientY - box.top);
      } else {
        moveBy(-event.deltaX * unit, -event.deltaY * unit);
      }
    },
    { passive: false },
  );

  dialog.append(stage, bar);
  root.appendChild(dialog);
  // A state that replaces this one starts unlocked, so the view goes with it.
  holder.close = () => dialog.remove();
  holder.giveWay = () => close(false);
  view.dispatch({ effects: lockEffect.of(true) });
  showWhole();
  dialog.focus();
}
