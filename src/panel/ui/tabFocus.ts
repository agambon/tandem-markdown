// Tab Moves Focus. Tab indents in the Rich editor, so without this mode the keyboard alone
// cannot leave it. The host's command Toggle Tab Moves Focus holds the mode for every panel and
// sends the panel command `setTabMovesFocus` with `{ on }`, also to a panel that starts or
// reloads while the mode is on. While it is on, CodeMirror leaves Tab and Shift+Tab to the
// browser, which moves focus. A panel starts with the mode off.

import type { EditorView } from '@codemirror/view';
import type { PanelCommand } from '../commands/registry';
import type { Feature } from '../features';

/** The mode the host last set in each view. CodeMirror keeps its own copy, which has no reader. */
const modes = new WeakMap<EditorView, boolean>();

/** True while Tab and Shift+Tab move focus in `view` instead of indenting. */
export function tabMovesFocus(view: EditorView): boolean {
  return modes.get(view) === true;
}

const setTabMovesFocus: PanelCommand = (view, args) => {
  const on = (args as { on?: unknown } | undefined)?.on === true;
  view.setTabFocusMode(on);
  modes.set(view, on);
  return true;
};

export const tabFocus: Feature = {
  id: 'tabFocus',
  commands: { setTabMovesFocus },
};
