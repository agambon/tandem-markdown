// The rename box. Rename (F2) in Rich editor asks VS Code what a rename at the cursor would
// rename (`prepareRename`; for markdown, a heading and the links to it, a link's file, a
// reference). A box opens under that text holding VS Code's placeholder, selected; Enter
// renames (`rename`: the provider's edit, applied by VS Code to every file it touches, which
// reaches this panel as an ordinary change), and Escape, or leaving the box, cancels. What VS
// Code refuses is said in a notice. The command given `{ newName }` renames with no box.

import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import { errorMessage } from '../../core/errors';
import { stampOf } from '../../core/hash';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { getMode } from '../modes';

const CHANGED = 'The note changed before the rename could be made, so nothing was renamed. Press F2 to try again.';

interface Box {
  /** The text being renamed. */
  from: number;
  to: number;
  /** Where Rename was asked for. */
  at: number;
  placeholder: string;
  /** Builds the box. Kept as the box moves, so CodeMirror keeps the one it drew and what is typed in it. */
  create: (view: EditorView) => TooltipView;
}

const openBox = StateEffect.define<Box | null>();

const boxField = StateField.define<Box | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(openBox)) return e.value;
    if (!value || !tr.docChanged) return value;
    // A change to the text being renamed ends the rename; one elsewhere moves the box with it.
    if (tr.changes.touchesRange(value.from, value.to)) return null;
    return {
      ...value,
      from: tr.changes.mapPos(value.from),
      to: tr.changes.mapPos(value.to),
      at: tr.changes.mapPos(value.at),
    };
  },
  provide: (field) =>
    showTooltip.from(field, (box): Tooltip | null =>
      box ? { pos: box.from, above: false, create: box.create } : null,
    ),
});

function readPrepared(value: unknown): { from: number; to: number; placeholder: string } | string | null {
  const v = value as { from?: unknown; to?: unknown; placeholder?: unknown; refused?: unknown; stale?: unknown } | null;
  if (!v) return null;
  if (typeof v.refused === 'string') return v.refused;
  if (v.stale === true) return CHANGED;
  if (!Number.isInteger(v.from) || !Number.isInteger(v.to) || typeof v.placeholder !== 'string') return null;
  return { from: v.from as number, to: v.to as number, placeholder: v.placeholder };
}

async function submit(view: EditorView, at: number, newName: string): Promise<void> {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return;
  try {
    const answer = (await ctx.request({
      type: 'rename',
      at,
      newName,
      expect: stampOf(view.state.doc),
    })) as { refused?: unknown; stale?: unknown } | null;
    if (answer?.stale === true) ctx.notify({ kind: 'info', text: CHANGED });
    else if (typeof answer?.refused === 'string') ctx.notify({ kind: 'info', text: answer.refused });
  } catch (error) {
    ctx.log('warn', 'A rename failed', error);
    ctx.notify({ kind: 'warning', text: `Could not rename to ${newName}: ${errorMessage(error)}` });
  }
}

/** The box's drawing: a field holding `placeholder`, selected, with a line saying which keys do what. */
function boxView(placeholder: string): (view: EditorView) => TooltipView {
  const create = (view: EditorView): TooltipView => {
    const doc = view.dom.ownerDocument;
    const dom = doc.createElement('div');
    dom.className = 'tm-rename';
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'tm-rename-input';
    input.value = placeholder;
    input.setAttribute('aria-label', 'New name');
    input.spellcheck = false;
    const hint = doc.createElement('div');
    hint.className = 'tm-rename-hint';
    hint.textContent = 'Enter to rename, Escape to cancel';
    dom.append(input, hint);
    /** Ends the rename: with Enter it is sent, and Enter and Escape give the editor the focus back. */
    const close = (how: 'rename' | 'cancel' | 'left') => {
      const box = view.state.field(boxField, false);
      if (!box || box.create !== create) return;
      const name = input.value;
      view.dispatch({ effects: openBox.of(null) });
      if (how !== 'left') view.focus();
      if (how === 'rename' && name !== '' && name !== placeholder) void submit(view, box.at, name);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        close('rename');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close('cancel');
      }
    });
    // Leaving the box cancels it, once the event is over: the box may be going away in an update.
    input.addEventListener('blur', () => setTimeout(() => close('left'), 0));
    return {
      dom,
      mount: () => {
        input.focus();
        input.select();
      },
    };
  };
  return create;
}

/**
 * Rename: asks VS Code what can be renamed at the cursor, and opens the box over it. With
 * `args: { newName }` it renames to that name at once, with no box.
 */
function rename(view: EditorView, args?: unknown): boolean {
  const ctx = view.state.facet(panelContext);
  if (!ctx || getMode(view.state) !== 'edit' || view.state.readOnly) return false;
  const at = view.state.selection.main.head;
  const given = (args as { newName?: unknown } | undefined)?.newName;
  if (typeof given === 'string' && given !== '') {
    void submit(view, at, given);
    return true;
  }
  const asked = view.state.doc;
  void ctx
    .request({ type: 'prepareRename', at, expect: stampOf(asked) })
    .then((answer) => {
      const prepared = readPrepared(answer);
      if (view.state.doc !== asked) return;
      if (typeof prepared === 'string') ctx.notify({ kind: 'info', text: prepared });
      else if (prepared && 0 <= prepared.from && prepared.from <= prepared.to && prepared.to <= asked.length)
        view.dispatch({ effects: openBox.of({ ...prepared, at, create: boxView(prepared.placeholder) }) });
    })
    .catch((error: unknown) => {
      ctx.log('warn', 'VS Code did not say what can be renamed', error);
      ctx.notify({ kind: 'warning', text: `Can't rename here: ${errorMessage(error)}` });
    });
  return true;
}

export const renameBox: Feature = {
  id: 'renameBox',
  extension: () => [
    boxField,
    EditorView.baseTheme({
      '& .cm-tooltip:has(.tm-rename)': {
        background: 'var(--tm-widget-bg)',
        color: 'var(--tm-widget-fg)',
        border: '1px solid var(--tm-border)',
        borderRadius: '3px',
        boxShadow: '0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25))',
      },
      '& .tm-rename': {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '4px',
        fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
        fontSize: '12px',
      },
      '& .tm-rename-input': {
        minWidth: '240px',
        padding: '3px 6px',
        border: '1px solid var(--tm-focus)',
        borderRadius: '2px',
        background: 'var(--vscode-input-background, var(--tm-bg))',
        color: 'var(--vscode-input-foreground, var(--tm-fg))',
        font: 'inherit',
        outline: 'none',
      },
      '& .tm-rename-hint': { color: 'var(--tm-faded)' },
    }),
  ],
  commands: { rename },
};
