// The two rich modes, held in the editor state so that changing mode is one dispatch:
//   view.dispatch({ effects: setModeEffect.of('view') })
//
// Rich view ('view'): read-only and not editable, but the content element keeps
// `tabindex="0"` so the keyboard can scroll it and the find keys reach the editor.
// Rich editor ('edit'): editable.
//
// The editor element carries the class `tm-mode-view` or `tm-mode-edit` for the stylesheet.

import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Mode } from '../core/protocol';
import { panelContext } from './context';

export type { Mode };

export const setModeEffect = StateEffect.define<Mode>();

export const modeField = StateField.define<Mode>({
  create: () => 'edit',
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setModeEffect)) value = effect.value;
    return value;
  },
});

/** The state's mode; 'edit' when the state has no mode field. */
export function getMode(state: EditorState): Mode {
  return state.field(modeField, false) ?? 'edit';
}

/** The mode field starting in `initial`, and what each mode does to the editor. */
export function modes(initial: Mode): Extension {
  return [
    modeField.init(() => initial),
    EditorState.readOnly.compute([modeField], (state) => state.field(modeField) === 'view'),
    EditorView.editable.compute([modeField], (state) => state.field(modeField) !== 'view'),
    EditorView.contentAttributes.compute([modeField], (state): Record<string, string> =>
      state.field(modeField) === 'view' ? { tabindex: '0' } : {},
    ),
    EditorView.editorAttributes.compute([modeField], (state) => ({ class: `tm-mode-${state.field(modeField)}` })),
  ];
}

/** False in Rich view and on a read-only document: commands and typing rules then do nothing. */
export function canEdit(state: EditorState): boolean {
  if (getMode(state) === 'view' || state.readOnly) return false;
  return !state.facet(panelContext)?.doc.readOnly;
}
