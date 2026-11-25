// Tab Moves Focus (`tandemMarkdown.toggleTabMovesFocus`). Tab indents in the Rich editor, so the
// keyboard alone cannot leave it; in this mode, as in VS Code's own for its text editor, Tab
// and Shift+Tab move focus instead. It holds for every panel in the window until it is turned
// off. Each panel is told with the panel command `setTabMovesFocus` and `{ on }`; a status bar
// item shows while the mode is on and one of our panels is the active editor, and a click on it
// turns the mode off.

import * as vscode from 'vscode';
import { registerCommand } from './commandRegistration';
import type { HostFeature } from './features';
import { panels, type HostPanel } from './panels';
import { STATUS_PRIORITY } from './statusPlaces';

const TOGGLE = 'toggleTabMovesFocus';

export const tabFocus: HostFeature = () => {
  let on = false;
  const item = vscode.window.createStatusBarItem(
    'tandemMarkdown.tabMovesFocus',
    vscode.StatusBarAlignment.Right,
    STATUS_PRIORITY.tabMovesFocus,
  );
  item.name = 'Tandem Markdown Tab Moves Focus';
  item.text = 'Tab Moves Focus';
  item.tooltip = 'Tab and Shift+Tab move focus. Click to make them indent again.';
  item.command = `tandemMarkdown.${TOGGLE}`;

  const tell = (panel: HostPanel) => {
    void panel.post({ type: 'command', id: 'setTabMovesFocus', args: { on } });
  };
  const showItem = () => {
    if (on && panels.activePanel()) item.show();
    else item.hide();
  };

  return vscode.Disposable.from(
    item,
    registerCommand(TOGGLE, () => {
      on = !on;
      for (const p of panels.all()) if (p.live) tell(p);
      showItem();
    }),
    panels.onDidChangeActivePanel(showItem),
    // A panel that opens or starts again while the mode is on.
    panels.onDidBecomeLive((p) => {
      if (on) tell(p);
    }),
  );
};
