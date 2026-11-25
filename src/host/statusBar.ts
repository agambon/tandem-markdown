// The status bar while one of our panels is the active editor. Two items on the right: the
// word count ("1,204 words", or "37 of 1,204 words" with a selection; the tooltip gives the
// characters the same way), and the view's name ("Rich editor" or "Rich view"), which runs
// Switch View when clicked. Both are hidden while the active editor is not ours.
//
// The count is `countWords` of the document's text with the front matter block left out, and
// of the text the panel's last reported selection covers (model/wordCountText.ts). The whole
// is counted again when the active panel changes and shortly after its document last changed;
// a new selection is counted against the whole already counted.

import * as vscode from 'vscode';
import { toLf } from '../core/eol';
import { RICH_VIEW_NAME } from '../core/protocol';
import type { HostFeature } from './features';
import { documentText } from './model/documentText';
import { bodyStart, countBody, countSelection, countTexts, type Counts } from './model/wordCountText';
import { panels, type HostPanel } from './panels';
import { STATUS_PRIORITY } from './statusPlaces';
import { exposeSnapshot } from './testSnapshots';

const RECOUNT_DELAY_MS = 300;

/** What the in-VS-Code suite reads back through the test hook (test mode only). */
export interface StatusBarTestState {
  visible: boolean;
  count: { text: string; tooltip: string };
  view: { text: string; tooltip: string; command: string | null; arguments: string[] };
}

interface Counted {
  version: number;
  lf: string;
  start: number;
  total: Counts;
}

export const statusBar: HostFeature = (_context, _documents, testMode) => {
  const countItem = vscode.window.createStatusBarItem(
    'tandemMarkdown.wordCount',
    vscode.StatusBarAlignment.Right,
    STATUS_PRIORITY.wordCount,
  );
  countItem.name = 'Tandem Markdown Word Count';
  const viewItem = vscode.window.createStatusBarItem(
    'tandemMarkdown.view',
    vscode.StatusBarAlignment.Right,
    STATUS_PRIORITY.view,
  );
  viewItem.name = 'Tandem Markdown View';
  viewItem.tooltip = 'Switch view';

  let panel: HostPanel | undefined;
  let visible = false;
  let counted: Counted | null = null;
  /** The document version and selection the count item shows. */
  let shownKey = '';
  /** The panel and mode the view item shows. Scrolling reports a view state often; unchanged items are left alone. */
  let shownView = '';

  const showView = (p: HostPanel) => {
    const mode = p.readOnly ? 'view' : p.mode;
    const key = `${p.id}:${mode}`;
    if (key === shownView) return;
    shownView = key;
    viewItem.text = RICH_VIEW_NAME[mode];
    viewItem.command = { command: 'tandemMarkdown.switchView', title: 'Switch view', arguments: [p.uri] };
  };

  const showCount = (p: HostPanel, c: Counted) => {
    const selection = p.viewState?.selection;
    const key = `${c.version}:${selection ? `${selection.anchor}-${selection.head}` : ''}`;
    if (key === shownKey) return;
    shownKey = key;
    const { text, tooltip } = countTexts(c.total, countSelection(c.lf, c.start, selection));
    countItem.text = text;
    countItem.tooltip = tooltip;
  };

  const recount = (p: HostPanel) => {
    const lf = toLf(documentText(p.document));
    const start = bodyStart(lf);
    counted = { version: p.document.version, lf, start, total: countBody(lf, start) };
    shownKey = '';
    showCount(p, counted);
  };

  const follow = (next: HostPanel | undefined) => {
    panel = next;
    counted = null;
    shownKey = '';
    shownView = '';
    if (!next) {
      countItem.hide();
      viewItem.hide();
      visible = false;
      return;
    }
    showView(next);
    recount(next);
    countItem.show();
    viewItem.show();
    visible = true;
  };

  const subscriptions: vscode.Disposable[] = [
    countItem,
    viewItem,
    panels.onDidChangeActivePanel((p) => follow(p)),
    panels.onDidChangeViewState((p) => {
      if (p !== panel) return;
      showView(p);
      if (!counted) return;
      const selection = p.viewState?.selection;
      const selecting = !!selection && selection.anchor !== selection.head;
      // A selection made since the document changed is counted in the current text, now.
      if (selecting && counted.version !== p.document.version) recount(p);
      else showCount(p, counted);
    }),
    panels.onActivePanelTextChanged(RECOUNT_DELAY_MS, recount),
  ];

  if (testMode) {
    subscriptions.push(
      exposeSnapshot('statusBar', () => ({
        visible,
        count: { text: countItem.text, tooltip: String(countItem.tooltip ?? '') },
        view: {
          text: viewItem.text,
          tooltip: String(viewItem.tooltip ?? ''),
          command: typeof viewItem.command === 'object' ? viewItem.command.command : (viewItem.command ?? null),
          arguments:
            typeof viewItem.command === 'object'
              ? (viewItem.command.arguments ?? []).map((a: unknown) => String(a))
              : [],
        },
      })),
    );
  }

  follow(panels.activePanel());
  return vscode.Disposable.from(...subscriptions);
};
