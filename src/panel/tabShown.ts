// Whether the panel's tab is shown, as the host reports it (`tabShown`): VS Code keeps the page of
// a tab behind another running, with nothing in the page to show that it is out of sight. A
// feature that reads the field lists it in its own extension; boot.ts starts it in each state
// from what the host last said, and in a state made with no host (the render lab) it is shown.

import { StateEffect, StateField } from '@codemirror/state';

/** The host said the tab was shown (true), or put behind another tab or in a hidden group (false). */
export const setTabShown = StateEffect.define<boolean>();

/** Whether the panel's tab is shown: true until the host says otherwise. */
export const tabShownField = StateField.define<boolean>({
  create: () => true,
  update(shown, tr) {
    for (const effect of tr.effects) if (effect.is(setTabShown)) shown = effect.value;
    return shown;
  },
});
