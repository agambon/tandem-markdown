// When a click follows a link or a tag the panel draws: in Rich view a plain click, unless it
// ended a drag that selected text; in Rich editor Ctrl+click (Cmd+click on a Mac), since a plain
// click there places the cursor.

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getMode } from '../modes';

/** Whether the keys held with `event`, a click, follow a link: any in Rich view; Ctrl or Cmd in Rich editor. */
export function keysFollowLink(view: EditorView, event: MouseEvent): boolean {
  return getMode(view.state) === 'view' || event.ctrlKey || event.metaKey;
}

/**
 * Whether `event`, a click on text that a drawing taking its own clicks draws (a table's cell, a
 * front matter value), follows a link. The editor never sees a drag there, so whether one
 * selected text is read from the page's selection.
 */
export function followsLink(view: EditorView, event: MouseEvent): boolean {
  if (!keysFollowLink(view, event)) return false;
  return getMode(view.state) === 'edit' || view.dom.ownerDocument.getSelection()?.isCollapsed !== false;
}

/**
 * Handlers by which a click in a line follows what `open` finds where it happened; `open` gives
 * false when nothing is there, so the event goes on. Rich editor's click is taken on the press,
 * before the editor places the cursor; in Rich view a drag moves the editor's own selection.
 */
export function followOnClick(open: (view: EditorView, event: MouseEvent) => boolean): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) =>
      event.button === 0 && getMode(view.state) === 'edit' && keysFollowLink(view, event) && open(view, event),
    click: (event, view) =>
      event.button === 0 && getMode(view.state) === 'view' && view.state.selection.main.empty && open(view, event),
  });
}
