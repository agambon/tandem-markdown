// What has focus in the panel's page. boot.ts reports it to the host for the focus keys
// (`tandemMarkdown.editorFocus`, `tandemMarkdown.fieldFocus`), and the toolbar uses the same test
// to turn its formatting buttons off while a text field has focus. Paste as plain text acts on
// the text field that has focus, and so do the panel commands here:
//   fieldUndo    the browser's own undo in the focused text field (a table cell, the find box)
//   fieldRedo    the browser's own redo there
// The host sends fieldUndo and fieldRedo for Ctrl+Z and Ctrl+Y while a field has focus.

import type { EditorView } from '@codemirror/view';
import type { Feature } from './features';

const TEXT_INPUTS = new Set(['', 'text', 'search', 'url', 'email', 'number', 'password', 'tel']);

/**
 * The text field that has focus, other than the editor's own content (`content`): an input
 * that takes typing, a textarea, or an editable element. Null when none has.
 */
export function focusedField(doc: Document, content: HTMLElement | null): HTMLElement | null {
  const active = doc.activeElement as HTMLElement | null;
  if (!active || active === content) return null;
  if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
    const field = active as HTMLInputElement;
    const takesTyping = field.tagName === 'TEXTAREA' || TEXT_INPUTS.has(field.type);
    return takesTyping && !field.readOnly && !field.disabled ? field : null;
  }
  return active.isContentEditable && !content?.contains(active) ? active : null;
}

/**
 * A text field inside the panel's `root` has focus, other than the editor's own content
 * (`content`): a table cell being edited, the find box. So does a view over the editor (a
 * diagram opened large, `aria-modal`): the editor's keys, and VS Code's undo, must not reach
 * the note from there either.
 */
export function fieldHasFocus(root: HTMLElement, content: HTMLElement | null): boolean {
  const doc = root.ownerDocument;
  const active = doc.activeElement as HTMLElement | null;
  if (!doc.hasFocus() || !active || !root.contains(active) || active === content) return false;
  return focusedField(doc, content) !== null || active.closest('[aria-modal="true"]') !== null;
}

/**
 * The panel's page has focus anywhere: in its root (the editor, the toolbar, a notice) or on
 * the page itself (after a notice that had focus went away). The host then sends the panel's
 * keys (undo, save, close) through the panel, so unsent typing goes first.
 */
export function pageHasFocus(root: HTMLElement): boolean {
  const doc = root.ownerDocument;
  if (!doc.hasFocus()) return false;
  const active = doc.activeElement;
  return !active || active === doc.body || active === doc.documentElement || root.contains(active);
}

function fieldHistory(view: EditorView, which: 'undo' | 'redo'): boolean {
  const doc = view.dom.ownerDocument;
  if (!focusedField(doc, view.contentDOM)) return false;
  // execCommand is the only way to reach a field's own history.
  return doc.execCommand(which);
}

const fieldUndo = (view: EditorView): boolean => fieldHistory(view, 'undo');
const fieldRedo = (view: EditorView): boolean => fieldHistory(view, 'redo');

export const fieldCommands: Feature = {
  id: 'fieldCommands',
  commands: { fieldUndo, fieldRedo },
};
