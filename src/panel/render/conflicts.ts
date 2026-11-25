// Git's conflict markers drawn as a conflict (markdown/conflictMarkers.ts reads them): a drawn
// block (render/drawnBlock.ts) headed "Merge conflict", each side labeled in VS Code's words
// with the name git gave it, and its lines as typed. In the Rich editor three buttons keep one
// side or both, rewriting the block as VS Code's own buttons above a conflict in Source do, in one
// change that Undo takes back. While git lists the note as in conflict (the host's
// `gitConflict`), "Resolve in Merge Editor" opens VS Code's merge editor for the note; otherwise
// "Resolve in Source" switches the tab to Source with the cursor at the conflict, where those
// buttons of VS Code's are.

import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { COMMAND_EVENT } from '../commands/base';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { readConflict, type ConflictSide } from '../markdown/conflictMarkers';
import { treeForLine } from '../markdown/tree';
import { canEdit } from '../modes';
import { reportPlace, viewStateOf } from '../reports';
import { icon } from '../ui/dom';
import { drawBlock, drawnBlockKeys, drawnBlockStart, drawnBlockTheme, type DrawnKind } from './drawnBlock';
import { blockFeature, redrawFeatureEffect } from './framework';

/** A conflict longer than this shows as text with a "Draw anyway" button. */
const CONFLICT_LIMIT = 200_000;
/** The height kept for a conflict never measured. */
const CONFLICT_ESTIMATE = 160;

const setGitConflicted = StateEffect.define<boolean>();

/** Whether git lists the note as in conflict, as the host last said; not, from each init. */
const gitConflicted = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setGitConflicted)) value = e.value;
    return value;
  },
});

export function gitConflictedIn(state: EditorState): boolean {
  return state.field(gitConflicted, false) ?? false;
}

/** The effects for the host's word on whether git lists the note as in conflict: the conflicts are drawn again for it. */
export function gitConflictEffects(conflicted: boolean): StateEffect<unknown>[] {
  return [setGitConflicted.of(conflicted), redrawFeatureEffect.of('conflicts')];
}

/** Takes the host's `gitConflict`, and draws the conflicts again with the link it calls for. */
const gitConflictListener = ViewPlugin.define((view) => {
  const stop = view.state.facet(panelContext)?.bridge.onMessage((message) => {
    if (message.type !== 'gitConflict') return;
    const conflicted = (message as { conflicted?: unknown }).conflicted === true;
    if (conflicted === gitConflictedIn(view.state)) return;
    view.dispatch({ effects: gitConflictEffects(conflicted) });
  });
  return { destroy: () => stop?.() };
});

/**
 * The link under a conflict: VS Code's merge editor while git lists the note as in conflict,
 * otherwise Source, with a tooltip, since "Source" alone can be taken for Source Control.
 */
export function resolveLink(inGitConflict: boolean): { label: string; tooltip: string | null } {
  return inGitConflict
    ? { label: 'Resolve in Merge Editor', tooltip: null }
    : { label: 'Resolve in Source', tooltip: "Open the note in Source, VS Code's text editor, at this conflict" };
}

/** Which sides a button keeps. */
export type Keep = 'current' | 'incoming' | 'both';

/**
 * The change that settles the conflict whose lines run from `from` to `to` by keeping `keep`:
 * the kept lines in place of the block, its marker lines and any base part gone, as VS Code's
 * own buttons do. Null when the text there is no conflict.
 */
export function settleConflict(
  doc: Text,
  from: number,
  to: number,
  keep: Keep,
): { from: number; to: number; insert: string } | null {
  const conflict = readConflict(doc.sliceString(from, to));
  if (!conflict) return null;
  const kept = [
    ...(keep === 'incoming' ? [] : conflict.current.lines),
    ...(keep === 'current' ? [] : conflict.incoming.lines),
  ];
  const insert = kept.map((line) => `${line}\n`).join('');
  // The line break after the block goes with it. A block that ends the note had none after it,
  // so the note keeps that ending: no break after the last kept line, or, with none kept, none
  // before the block either.
  if (to < doc.length) return { from, to: to + 1, insert };
  if (kept.length) return { from, to, insert: insert.slice(0, -1) };
  return { from: Math.max(0, from - 1), to, insert: '' };
}

/** The conflict block whose first line starts at `at`. */
function conflictBlockAt(view: EditorView, at: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = treeForLine(view.state, at).resolveInner(at, 1); n; n = n.parent)
    if (n.name === 'ConflictBlock') return n;
  return null;
}

/** Keeps `keep` of the conflict drawn around `element`. */
function settle(view: EditorView, element: Element, keep: Keep): void {
  const at = drawnBlockStart(view, element);
  const node = at === null ? null : conflictBlockAt(view, at);
  if (!node || !canEdit(view.state)) return;
  const change = settleConflict(view.state.doc, node.from, node.to, keep);
  if (change) view.dispatch({ changes: change, userEvent: COMMAND_EVENT });
}

/**
 * Switches the tab to Source with the cursor at the start of the conflict drawn around `element`.
 * The host opens Source at the view state it last had, so that place is sent first, and through
 * the reports (`reportPlace`), so that no report of the editor's own place comes after it.
 */
function resolveInSource(view: EditorView, element: Element): void {
  const at = drawnBlockStart(view, element);
  const ctx = view.state.facet(panelContext);
  if (at === null || !ctx) return;
  const place = viewStateOf(view);
  const line = view.state.doc.lineAt(at).number - 1;
  const top = line < place.topLine ? { topLine: line, topOffsetPx: 0 } : {};
  view.dispatch({ effects: reportPlace.of({ ...place, ...top, selection: { anchor: at, head: at } }) });
  ctx.bridge.post({ type: 'switchView', to: 'source' });
}

/** A button of the drawing: it keeps focus in the editor, and acts on a click. */
function button(doc: Document, text: string, className: string, act: (element: Element) => void): HTMLButtonElement {
  const element = doc.createElement('button');
  element.type = 'button';
  element.className = `${className} tm-stop`;
  element.textContent = text;
  element.addEventListener('mousedown', (event) => event.preventDefault());
  element.addEventListener('click', (event) => {
    event.preventDefault();
    act(element);
  });
  return element;
}

/** One side: its label, then its lines as typed, or "No lines". */
function side(doc: Document, label: string, part: ConflictSide, className: string): HTMLElement {
  const section = doc.createElement('div');
  section.className = `tm-conflict-side ${className}`;
  const head = doc.createElement('div');
  head.className = 'tm-conflict-label';
  head.textContent = part.name ? `${label} (${part.name})` : label;
  const body = doc.createElement('div');
  if (part.lines.length) {
    body.className = 'tm-conflict-lines';
    body.textContent = part.lines.join('\n');
  } else {
    body.className = 'tm-conflict-empty';
    body.textContent = 'No lines';
  }
  section.append(head, body);
  return section;
}

/**
 * The drawing of the conflict in `text` (its source after a first line naming the view and the
 * link, as the block feature below writes it), with the buttons when `editable`.
 */
function drawConflict(text: string, view: EditorView, editable: boolean): { node: Node } {
  const firstLine = text.slice(0, text.indexOf('\n'));
  // The parser made the block by the rule that reads it, so it always holds a conflict.
  const conflict = readConflict(text.slice(firstLine.length + 1))!;
  const doc = view.dom.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'tm-conflict';
  const title = doc.createElement('div');
  title.className = 'tm-conflict-title';
  const words = doc.createElement('span');
  words.textContent = 'Merge conflict';
  title.append(icon(doc, 'git-merge'), words);
  box.append(title, side(doc, 'Current change', conflict.current, 'tm-conflict-current'));
  if (conflict.base) box.append(side(doc, 'Base, before either change', conflict.base, 'tm-conflict-base'));
  box.append(side(doc, 'Incoming change', conflict.incoming, 'tm-conflict-incoming'));
  const actions = doc.createElement('div');
  actions.className = 'tm-conflict-actions';
  if (editable) {
    actions.append(
      button(doc, 'Accept Current Change', 'tm-conflict-accept', (e) => settle(view, e, 'current')),
      button(doc, 'Accept Incoming Change', 'tm-conflict-accept', (e) => settle(view, e, 'incoming')),
      button(doc, 'Accept Both Changes', 'tm-conflict-accept', (e) => settle(view, e, 'both')),
    );
  }
  const merge = firstLine.endsWith(' merge');
  const link = resolveLink(merge);
  const resolve = button(doc, link.label, 'tm-conflict-source', (e) =>
    merge ? view.state.facet(panelContext)?.bridge.post({ type: 'openMergeEditor' }) : resolveInSource(view, e),
  );
  if (link.tooltip) resolve.title = link.tooltip;
  actions.append(resolve);
  box.append(actions);
  return { node: box };
}

const CONFLICT: DrawnKind<boolean> = {
  name: 'Merge conflict',
  sentenceName: 'a merge conflict',
  frameClass: 'tm-drawn-conflict',
  editLabel: 'Edit the conflict',
  doneLabel: 'Done editing the conflict',
  limit: CONFLICT_LIMIT,
  estimate: CONFLICT_ESTIMATE,
  draw: (text, view, editable) => drawConflict(text, view, editable),
};

export const conflicts: Feature = {
  id: 'conflicts',
  extension: () => [
    blockFeature('conflicts', (d) => {
      const editable = d.mode === 'edit' && !d.ctx.doc.readOnly;
      d.blocks((block) => {
        if (block.name !== 'ConflictBlock') return;
        // The first line names the view and the link, so the drawing is made again when either changes.
        const link = gitConflictedIn(d.state) ? 'merge' : 'source';
        const text = `${editable ? 'edit' : 'view'} ${link}\n${d.doc.sliceString(block.from, block.to)}`;
        drawBlock(d, block, CONFLICT, text, true, editable);
      });
    }),
    gitConflicted,
    gitConflictListener,
    drawnBlockKeys,
    drawnBlockTheme,
    EditorView.baseTheme({
      '& .cm-content .tm-conflict': { fontFamily: 'var(--tm-ui-font)', fontSize: '0.9em' },
      '& .cm-content .tm-conflict-title': {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontWeight: '600',
        paddingBottom: '6px',
      },
      // VS Code's own colors for the parts of a conflict in Source.
      '& .cm-content .tm-conflict-side': { borderRadius: '3px', marginBottom: '4px', overflow: 'hidden' },
      '& .cm-content .tm-conflict-label': { padding: '2px 8px', fontWeight: '600' },
      '& .cm-content .tm-conflict-lines, & .cm-content .tm-conflict-empty': {
        padding: '4px 8px',
        fontFamily: 'var(--tm-mono)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      '& .cm-content .tm-conflict-empty': { fontFamily: 'var(--tm-ui-font)', color: 'var(--tm-faded)' },
      '& .cm-content .tm-conflict-current .tm-conflict-label': {
        background: 'var(--vscode-merge-currentHeaderBackground, rgba(64, 200, 174, 0.5))',
      },
      '& .cm-content .tm-conflict-current': {
        background: 'var(--vscode-merge-currentContentBackground, rgba(64, 200, 174, 0.2))',
      },
      '& .cm-content .tm-conflict-incoming .tm-conflict-label': {
        background: 'var(--vscode-merge-incomingHeaderBackground, rgba(64, 166, 255, 0.5))',
      },
      '& .cm-content .tm-conflict-incoming': {
        background: 'var(--vscode-merge-incomingContentBackground, rgba(64, 166, 255, 0.2))',
      },
      '& .cm-content .tm-conflict-base .tm-conflict-label': {
        background: 'var(--vscode-merge-commonHeaderBackground, rgba(96, 96, 96, 0.4))',
      },
      '& .cm-content .tm-conflict-base': {
        background: 'var(--vscode-merge-commonContentBackground, rgba(96, 96, 96, 0.16))',
      },
      '& .cm-content .tm-conflict-actions': {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        paddingTop: '4px',
      },
      '& .cm-content .tm-conflict-accept': {
        font: 'inherit',
        padding: '2px 8px',
        border: 'none',
        borderRadius: '2px',
        background: 'var(--tm-button2-bg)',
        color: 'var(--tm-button2-fg)',
        cursor: 'pointer',
      },
      '& .cm-content .tm-conflict-accept:hover': { background: 'var(--tm-button2-hover-bg)' },
      '& .cm-content .tm-conflict-source': {
        font: 'inherit',
        padding: '2px 0',
        border: 'none',
        background: 'none',
        color: 'var(--tm-link)',
        cursor: 'pointer',
      },
      '& .cm-content .tm-conflict-source:hover': { textDecoration: 'underline' },
      '& .cm-content .tm-conflict-accept:focus-visible, & .cm-content .tm-conflict-source:focus-visible': {
        outline: '1px solid var(--tm-focus)',
        outlineOffset: '1px',
      },
    }),
  ],
};
