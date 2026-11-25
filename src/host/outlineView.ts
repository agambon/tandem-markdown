// The outline: the active panel's headings in the Explorer view `tandemMarkdown.outline`, nested
// by level. Choosing a heading scrolls the panel to it, and the heading the panel is scrolled to
// is selected in the tree, without taking focus.
//
// The view is declared with `when: activeCustomEditorId == 'tandemMarkdown.editor'`, so VS Code
// shows it only while one of our panels is the active editor. Its headings are built again
// when the active panel changes and shortly after the panel's document last changed; while
// the view is out of sight (the Explorer closed, or the view collapsed) nothing is built
// until it shows again. Headings come from `buildOutline`, the parser the panel draws with. While
// the file's emoji setting is on, emoji codes show as their emoji, as the panel draws them: the
// emoji list loads the first time a heading shows a code, and the headings are built again then.

import * as vscode from 'vscode';
import { alignedDiff } from '../core/alignDiff';
import type { EmojiCodes } from '../core/emojiCodes';
import { toLf } from '../core/eol';
import { moveOutlineSection } from '../core/headingSections';
import { buildOutline, sameHeadings, type OutlineItem } from '../core/outline';
import { textOf } from '../core/positions';
import type { HostFeature } from './features';
import { log } from './log';
import { documentText } from './model/documentText';
import { hostEmojiNames } from './model/emojiNames';
import { HeadingFollower, headingAtTop, nestOutline, type OutlineNode } from './model/outlineTree';
import { panels, type HostPanel } from './panels';
import { toPosition } from './panelText';
import { emojiOn, markdownScope, plainTextSyntax } from './settings';
import { exposeSnapshot } from './testSnapshots';

const VIEW_ID = 'tandemMarkdown.outline';
const OUTLINE_MIME = 'application/vnd.code.tree.tandemmarkdown.outline';
const REBUILD_DELAY_MS = 300;
const NO_HEADINGS = 'No headings in this file.';
/** The label of a heading with no text (`#` alone on its line). */
const EMPTY_HEADING = '(empty heading)';

/** What the in-VS-Code suite reads back through the test hook (test mode only). */
export interface OutlineTestState {
  visible: boolean;
  message: string | null;
  /** Every heading in tree order, as VS Code is given it. */
  items: { label: string; depth: number; command: string | null; arguments: unknown[] }[];
  /** The selected headings, by their place in document order. */
  selection: number[];
}

/** Shows `message` above the tree; undefined clears it, which @types/vscode leaves out of the type. */
function setMessage(tree: vscode.TreeView<OutlineNode>, message: string | undefined): void {
  (tree as { message?: string | undefined }).message = message;
}

class OutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
  roots: OutlineNode[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  set(roots: OutlineNode[]): void {
    this.roots = roots;
    this.changed.fire();
  }

  getChildren(node?: OutlineNode): OutlineNode[] {
    return node ? node.children : this.roots;
  }

  getParent(node: OutlineNode): OutlineNode | undefined {
    return node.parent;
  }

  getTreeItem(node: OutlineNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.item.text || EMPTY_HEADING,
      node.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.command = {
      command: 'tandemMarkdown.revealHeading',
      title: 'Go to heading',
      arguments: [{ from: node.item.from }],
    };
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export const outlineView: HostFeature = (_context, documents, testMode) => {
  const provider = new OutlineProvider();
  const dragAndDropController: vscode.TreeDragAndDropController<OutlineNode> = {
    dragMimeTypes: [OUTLINE_MIME],
    dropMimeTypes: [OUTLINE_MIME],
    handleDrag(source, dataTransfer) {
      if (!panel || panel.readOnly || source.length !== 1) return;
      const fromIndex = flat.indexOf(source[0]!);
      if (fromIndex < 0) return;
      dataTransfer.set(OUTLINE_MIME, new vscode.DataTransferItem(String(fromIndex)));
    },
    async handleDrop(target, dataTransfer) {
      if (!panel || panel.readOnly) return;
      const raw = dataTransfer.get(OUTLINE_MIME)?.value;
      const fromIndex = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
      if (!Number.isInteger(fromIndex) || fromIndex < 0) return;
      const targetPanel = panel;
      const targetIndex = target ? flat.indexOf(target) : items.length - 1;
      if (targetIndex < 0) return;
      const place: 'before' | 'after' = target ? (fromIndex > targetIndex ? 'before' : 'after') : 'after';

      const applied = await documents.applyUserEdit(targetPanel.document.uri, async () => {
        if (targetPanel.disposed || targetPanel.document.isClosed) return false;
        const lf = toLf(documentText(targetPanel.document));
        const liveHeadings = buildOutline(lf, {
          emoji: emojiCodesFor(targetPanel),
          ...plainTextSyntax(targetPanel.document.uri),
        });
        if (fromIndex >= liveHeadings.length || targetIndex >= liveHeadings.length) return false;
        const nextLf = moveOutlineSection(lf, liveHeadings, fromIndex, targetIndex, place);
        if (nextLf === null) return false;
        const text = textOf(lf);
        const edit = new vscode.WorkspaceEdit();
        for (const change of alignedDiff(lf, nextLf)) {
          edit.replace(
            targetPanel.document.uri,
            new vscode.Range(toPosition(text, change.from), toPosition(text, change.to)),
            change.insert,
          );
        }
        return vscode.workspace.applyEdit(edit);
      });
      if (applied) rebuild();
    },
  };
  const tree = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    dragAndDropController,
  });
  const follower = new HeadingFollower();

  let panel: HostPanel | undefined;
  let items: OutlineItem[] = [];
  let flat: OutlineNode[] = [];
  /** The headings are out of date with the panel's document (built again when the view shows). */
  let stale = false;
  /** The heading last selected in the tree, by us or by the user (-1: none or unknown). */
  let shownIndex = -1;

  const atTop = (): number => {
    const vs = panel?.viewState;
    return headingAtTop(items, vs?.topLine ?? 0, vs?.topOffsetPx ?? 0);
  };

  /** Selects the heading the panel is scrolled to, while the view is in sight. */
  const select = () => {
    if (!panel || !tree.visible || flat.length === 0) return;
    const want = follower.target(atTop());
    const node = flat[want];
    if (!node || want === shownIndex) return;
    shownIndex = want;
    tree.reveal(node, { select: true, focus: false }).then(undefined, (e: unknown) => {
      log('trace', 'The outline could not select the heading the panel is at', e);
    });
  };

  const show = (next: OutlineItem[]) => {
    items = next;
    const nested = nestOutline(next);
    flat = nested.flat;
    const message = panel && next.length === 0 ? NO_HEADINGS : undefined;
    if (tree.message !== message) setMessage(tree, message);
    provider.set(nested.roots);
    // The tree was given new elements: whatever it had selected is selected again below.
    shownIndex = -1;
    select();
  };

  /** Whether the emoji list has been asked for: it loads once, and the headings are built again then. */
  let emojiAsked = false;
  const wantEmoji = () => {
    if (emojiAsked) return;
    emojiAsked = true;
    hostEmojiNames.load().then(
      () => rebuild(),
      (e: unknown) => log('error', 'The outline could not load the emoji list, so emoji codes show as typed', e),
    );
  };

  /** How the headings of the panel's file read emoji codes: not at all while its emoji setting is off. */
  const emojiCodesFor = (p: HostPanel): EmojiCodes | undefined =>
    emojiOn(p.document.uri) ? { names: hostEmojiNames.loaded(), wanted: wantEmoji } : undefined;

  const rebuild = () => {
    if (panel && !tree.visible) {
      stale = true;
      return;
    }
    stale = false;
    const next = panel
      ? buildOutline(toLf(documentText(panel.document)), {
          emoji: emojiCodesFor(panel),
          ...plainTextSyntax(panel.document.uri),
        })
      : [];
    if (!sameHeadings(items, next)) follower.reset();
    show(next);
  };

  const subscriptions: vscode.Disposable[] = [
    tree,
    provider,
    panels.onDidChangeActivePanel((p) => {
      panel = p;
      follower.reset();
      // Out of sight, the last file's headings go now, so they never show for the new one.
      if (!tree.visible && flat.length > 0) {
        items = [];
        flat = [];
        setMessage(tree, undefined);
        provider.set([]);
      }
      rebuild();
    }),
    panels.onDidChangeViewState((p) => {
      if (p !== panel) return;
      if (p.viewState) follower.viewStateReported(p.viewState.topLine);
      select();
    }),
    panels.onActivePanelTextChanged(REBUILD_DELAY_MS, rebuild),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!panel) return;
      const scope = markdownScope(panel.document.uri);
      if (
        e.affectsConfiguration('tandemMarkdown.syntax.emoji', scope) ||
        e.affectsConfiguration('tandemMarkdown.syntax.math', scope) ||
        e.affectsConfiguration('tandemMarkdown.syntax.wikilinks', scope)
      ) {
        rebuild();
      }
    }),
    tree.onDidChangeVisibility((e) => {
      if (!e.visible) return;
      if (stale) rebuild();
      else {
        shownIndex = -1;
        select();
      }
    }),
    tree.onDidChangeSelection((e) => {
      const node = e.selection[0];
      // Only a heading of the current headings that we did not select ourselves is the user's choice.
      if (!node || flat[node.index] !== node || node.index === shownIndex) return;
      follower.choose(node.index, atTop());
      shownIndex = node.index;
    }),
  ];

  if (testMode) {
    subscriptions.push(
      exposeSnapshot('outline', () => {
        const out: OutlineTestState['items'] = [];
        const walk = (nodes: OutlineNode[], depth: number) => {
          for (const node of nodes) {
            const item = provider.getTreeItem(node);
            out.push({
              label: typeof item.label === 'string' ? item.label : (item.label?.label ?? ''),
              depth,
              command: item.command?.command ?? null,
              arguments: item.command?.arguments ?? [],
            });
            walk(provider.getChildren(node), depth + 1);
          }
        };
        walk(provider.getChildren(), 0);
        return {
          visible: tree.visible,
          message: tree.message ?? null,
          items: out,
          selection: tree.selection.map((n) => n.index),
        };
      }),
    );
  }

  panel = panels.activePanel();
  rebuild();
  return vscode.Disposable.from(...subscriptions);
};
