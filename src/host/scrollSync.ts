// Scroll sync (docs/ARCHITECTURE.md, "Scroll sync"): the visible tabs of one document scroll
// together, Source and rich alike, while the document is linked. The tab the user scrolls leads;
// every other visible tab of the document is put at the same place. A rich tab tells the host
// of the user's scrolls itself (`scrolled`) and follows on `scrollTo`; the host reads a text
// editor's visible ranges and follows with `revealRange`.
//
// Nothing runs while no document is linked and visible twice: rich tabs are told to stop
// reporting (`scrollLink`), and the visible ranges listener is removed.
//
// The context keys `tandemMarkdown.scrollSyncOn` and `tandemMarkdown.scrollSyncOff` list the
// documents (`uri.toString()`) visible in two or more tabs that are linked and not linked; the
// title bar's buttons test the tab's `resource` against them with `in`.

import * as vscode from 'vscode';
import { plainNotice } from '../core/noticeText';
import { registerCommand } from './commandRegistration';
import { contextKeyList, setContextKey } from './contextKeys';
import type { HostFeature } from './features';
import { log } from './log';
import { lineEditOf } from './model/lineEdits';
import { canLink, ScrollLinks, type VisibleTabs } from './model/scrollLinks';
import { EditorFollow, placeOfTop, revealPosition, type LineRange } from './model/textEditorFollow';
import { registerPanelMessageHandler } from './panelMessages';
import { panels, type HostPanel } from './panels';
import { markdownScope } from './settings';
import { currentTab, isOurTab, panelIn, tabUri } from './tabs';
import { exposeSnapshot } from './testSnapshots';
import { fileNameOf, movedKeys, sameUri } from './uris';

const ON_KEY = 'tandemMarkdown.scrollSyncOn';
const OFF_KEY = 'tandemMarkdown.scrollSyncOff';

type Pane = { kind: 'text'; editor: vscode.TextEditor } | { kind: 'rich'; panel: HostPanel };

interface DocumentTabs {
  uri: vscode.Uri;
  document: vscode.TextDocument;
  panes: Pane[];
}

/** How VS Code reveals a line in one document's text editors. */
interface RevealOptions {
  /** The most lines VS Code keeps above a revealed line: for sticky scroll's headings, or `editor.cursorSurroundingLines`. */
  padding: number;
  smooth: boolean;
  wraps: boolean;
}

/** What the in-VS-Code suite reads of scroll sync. */
export interface ScrollSyncTestState {
  /** Documents visible twice whose tabs are linked, as the title bar's buttons see them. */
  on: string[];
  /** Documents visible twice whose tabs are not linked. */
  off: string[];
  /** Each visible tab of a document visible twice: its column, its kind and the line at its top. */
  panes: { uri: string; column: number; kind: 'text' | 'rich'; topLine: number | null }[];
  /** The documents the user linked or unlinked, and how. */
  chosen: { uri: string; linked: boolean }[];
}

class ScrollSync implements vscode.Disposable {
  private readonly links = new ScrollLinks();
  /** The linked documents visible twice, by uri: their tabs follow each other. */
  private following = new Map<string, DocumentTabs>();
  private shown = new Map<string, DocumentTabs>();
  /** Each text editor that follows, and each in `opening`. */
  private readonly editors = new Map<vscode.TextEditor, EditorFollow>();
  /** Text editors opened to the side and put at a place before their document follows: the answer is still on its way. */
  private readonly opening = new Set<vscode.TextEditor>();
  /** The panels told they are linked. */
  private linkedPanels = new Set<string>();
  private readonly revealOptions = new Map<string, RevealOptions>();
  /** The listeners that only run while something follows. */
  private watching: vscode.Disposable | null = null;

  start(testMode: boolean): vscode.Disposable {
    const update = () => this.update();
    const subscriptions = [
      vscode.window.tabGroups.onDidChangeTabs(update),
      vscode.window.tabGroups.onDidChangeTabGroups(update),
      vscode.window.onDidChangeVisibleTextEditors(update),
      panels.onDidChangePanels(update),
      // A page that starts again (a reload, a resync) is told again.
      panels.onDidBecomeLive((p) => {
        this.linkedPanels.delete(p.id);
        this.update();
      }),
      // A language change closes and opens the document again.
      vscode.workspace.onDidOpenTextDocument(update),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('editor')) this.revealOptions.clear();
        if (e.affectsConfiguration('tandemMarkdown.scrollSync')) this.update();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        const chosen = this.links.choices().map(([uri]) => uri);
        for (const [from, to] of movedKeys(chosen, e.files)) this.links.renamed(from, to);
      }),
      registerPanelMessageHandler('scrolled', (m, panel) => {
        const line = m.line;
        if (typeof line !== 'number' || !Number.isFinite(line) || line < 0) return;
        const tabs = this.following.get(panel.uri.toString());
        const from = tabs?.panes.find((p) => p.kind === 'rich' && p.panel.id === panel.id);
        if (tabs && from) this.lead(tabs, from, line);
      }),
      registerCommand('toggleScrollSync', (arg) => this.set(arg, 'toggle')),
      registerCommand('turnOnScrollSync', (arg) => this.set(arg, true)),
      registerCommand('turnOffScrollSync', (arg) => this.set(arg, false)),
      this,
    ];
    if (testMode) subscriptions.push(exposeSnapshot('scrollSync', () => this.snapshot()));
    this.update();
    return vscode.Disposable.from(...subscriptions);
  }

  dispose(): void {
    this.watching?.dispose();
    this.watching = null;
    this.editors.clear();
    this.opening.clear();
  }

  // ---------------------------------------------------------------------------
  // Opening to the side (openToSide.ts)

  /** The place a text editor shows at its top. */
  placeOf(editor: vscode.TextEditor): number {
    const top = editor.visibleRanges[0]?.start;
    if (!top) return 0;
    return placeOfTop({ line: top.line, character: top.character }, editor.document.lineAt(top.line).text.length);
  }

  /** Puts a place at a text editor's top as a follow does, so its answer is never taken for the user's scroll. */
  revealPlace(editor: vscode.TextEditor, place: number): void {
    this.reveal(editor, place);
  }

  // ---------------------------------------------------------------------------
  // The toggle

  private set(arg: unknown, to: boolean | 'toggle'): void {
    const uri = arg instanceof vscode.Uri ? arg : tabUri(currentTab());
    if (!uri) return;
    const key = uri.toString();
    const tabs = visibleTabs().get(key);
    const linked = to === 'toggle' ? !this.linkedNow(key, tabs) : to;
    this.links.choose(key, linked);
    this.update();
    // Without a second visible tab there is no button to show the change.
    if (!this.shown.has(key))
      void vscode.window.showInformationMessage(
        plainNotice(
          linked
            ? `Scroll sync is now on for ${fileNameOf(uri)}: its tabs scroll together while two or more of them are visible.`
            : `Scroll sync is now off for ${fileNameOf(uri)}: its tabs scroll on their own.`,
        ),
      );
  }

  private linkedNow(key: string, tabs: DocumentTabs | undefined): boolean {
    if (!tabs) return this.links.linked(key, { markdown: true, source: 0, rich: 0 }, false);
    return this.links.linked(key, countOf(tabs), settingOn(tabs.uri));
  }

  // ---------------------------------------------------------------------------
  // Which tabs follow

  private update(): void {
    const shown = new Map<string, DocumentTabs>();
    const following = new Map<string, DocumentTabs>();
    for (const [key, tabs] of visibleTabs()) {
      const counted = countOf(tabs);
      if (!canLink(counted)) continue;
      shown.set(key, tabs);
      if (this.links.linked(key, counted, settingOn(tabs.uri))) following.set(key, tabs);
    }
    this.shown = shown;
    this.following = following;
    const linked = [...shown.keys()].filter((k) => following.has(k));
    setContextKey(ON_KEY, linked);
    setContextKey(
      OFF_KEY,
      [...shown.keys()].filter((k) => !following.has(k)),
    );

    // Rich tabs: tell those that start following, and those that stop.
    const nowLinked = new Set<string>();
    for (const tabs of following.values())
      for (const p of tabs.panes) if (p.kind === 'rich' && p.panel.live) nowLinked.add(p.panel.id);
    for (const id of this.linkedPanels) {
      if (nowLinked.has(id)) continue;
      const panel = panels.all().find((p) => p.id === id);
      if (panel?.live) void panel.post({ type: 'scrollLink', linked: false });
    }
    for (const tabs of following.values())
      for (const p of tabs.panes)
        if (p.kind === 'rich' && nowLinked.has(p.panel.id) && !this.linkedPanels.has(p.panel.id))
          void p.panel.post({ type: 'scrollLink', linked: true });
    this.linkedPanels = nowLinked;

    // Text editors: each that follows starts from what it shows now; a reveal sent to it before
    // (a tab opened to the side) is kept, so its answer is still known as one.
    const visible = new Set<vscode.TextEditor>();
    for (const tabs of following.values())
      for (const p of tabs.panes) {
        if (p.kind !== 'text') continue;
        visible.add(p.editor);
        if (!this.editors.has(p.editor)) this.editors.set(p.editor, new EditorFollow(topOf(p.editor)));
      }
    const showing = new Set(vscode.window.visibleTextEditors);
    for (const editor of this.opening) if (visible.has(editor) || !showing.has(editor)) this.opening.delete(editor);
    for (const editor of this.editors.keys())
      if (!visible.has(editor) && !this.opening.has(editor)) this.editors.delete(editor);
    this.watch(this.editors.size > 0);
  }

  /** Starts or stops the listeners that only run while a text editor follows or is being revealed. */
  private watch(on: boolean): void {
    if (on === !!this.watching) return;
    if (!on) {
      this.watching?.dispose();
      this.watching = null;
      return;
    }
    this.watching = vscode.Disposable.from(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.editorScrolled(e.textEditor, e.visibleRanges)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        const changes = e.contentChanges.map(lineEditOf);
        for (const [editor, follow] of this.editors)
          if (editor.document === e.document) follow.documentChanged(changes);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Leading and following

  private editorScrolled(editor: vscode.TextEditor, visibleRanges: readonly vscode.Range[]): void {
    const follow = this.editors.get(editor);
    if (!follow) return;
    const kind = follow.report(visibleRanges.map(lineRange), editor.document.lineCount);
    const tabs = this.following.get(editor.document.uri.toString());
    if (this.opening.delete(editor) && !tabs) {
      this.editors.delete(editor);
      this.watch(this.editors.size > 0);
    }
    if (kind !== 'lead' || !tabs) return;
    const from = tabs.panes.find((p) => p.kind === 'text' && p.editor === editor);
    if (!from) return;
    const top = follow.reportedTop;
    this.lead(tabs, from, placeOfTop(top, editor.document.lineAt(top.line).text.length));
  }

  /** The user moved `from` to `place`: every other visible tab of the document goes there. */
  private lead(tabs: DocumentTabs, from: Pane, place: number): void {
    for (const pane of tabs.panes) {
      if (pane === from) continue;
      if (pane.kind === 'rich') {
        if (pane.panel.live && !pane.panel.disposed) void pane.panel.post({ type: 'scrollTo', line: place });
      } else {
        this.reveal(pane.editor, place);
      }
    }
  }

  private reveal(editor: vscode.TextEditor, place: number): void {
    const document = editor.document;
    const options = this.optionsFor(document);
    const target = revealPosition(place, document.lineCount, (l) => document.lineAt(l).text.length, options.wraps);
    let follow = this.editors.get(editor);
    if (!follow) {
      follow = new EditorFollow(topOf(editor));
      this.editors.set(editor, follow);
      this.opening.add(editor);
      this.watch(true);
    }
    if (!follow.reveal(target, options.padding, options.smooth)) return;
    const at = new vscode.Position(target.line, target.character);
    try {
      editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
    } catch (error) {
      // An editor closed since it was last seen.
      log('info', 'Scroll sync could not reveal a line in a text editor', error);
    }
  }

  private optionsFor(document: vscode.TextDocument): RevealOptions {
    const key = document.uri.toString();
    const known = this.revealOptions.get(key);
    if (known) return known;
    const editor = vscode.workspace.getConfiguration('editor', document);
    const sticky = editor.get('stickyScroll.enabled') === true;
    const options: RevealOptions = {
      padding: Math.max(
        whole(editor.get('cursorSurroundingLines')),
        sticky ? whole(editor.get('stickyScroll.maxLineCount')) : 0,
      ),
      smooth: editor.get('smoothScrolling') === true,
      wraps: editor.get('wordWrap') !== 'off',
    };
    this.revealOptions.set(key, options);
    return options;
  }

  private snapshot(): ScrollSyncTestState {
    const panes: ScrollSyncTestState['panes'] = [];
    for (const [uri, tabs] of this.shown)
      for (const p of tabs.panes) {
        if (p.kind === 'text')
          panes.push({
            uri,
            column: p.editor.viewColumn ?? 0,
            kind: 'text',
            topLine: p.editor.visibleRanges[0]?.start.line ?? null,
          });
        else
          panes.push({
            uri,
            column: p.panel.disposed ? 0 : (p.panel.webviewPanel.viewColumn ?? 0),
            kind: 'rich',
            topLine: p.panel.viewState?.topLine ?? null,
          });
      }
    return {
      on: contextKeyList(ON_KEY),
      off: contextKeyList(OFF_KEY),
      panes,
      chosen: this.links.choices().map(([uri, linked]) => ({ uri, linked })),
    };
  }
}

/** Every document shown in a visible tab (the active tab of a group), with those tabs. */
function visibleTabs(): Map<string, DocumentTabs> {
  const out = new Map<string, DocumentTabs>();
  const editors = vscode.window.visibleTextEditors;
  for (const group of vscode.window.tabGroups.all) {
    const tab = group.activeTab;
    const uri = tabUri(tab);
    if (!tab || !uri) continue;
    let pane: Pane | undefined;
    let document: vscode.TextDocument | undefined;
    if (tab.input instanceof vscode.TabInputText) {
      const editor = editors.find((e) => e.viewColumn === group.viewColumn && sameUri(e.document.uri, uri));
      if (editor) {
        pane = { kind: 'text', editor };
        document = editor.document;
      }
    } else if (isOurTab(tab)) {
      const panel = panelIn(uri, group.viewColumn);
      if (panel && !panel.disposed) {
        pane = { kind: 'rich', panel };
        document = panel.document;
      }
    }
    if (!pane || !document) continue;
    const key = uri.toString();
    const entry = out.get(key);
    if (entry) entry.panes.push(pane);
    else out.set(key, { uri, document, panes: [pane] });
  }
  return out;
}

function countOf(tabs: DocumentTabs): VisibleTabs {
  const rich = tabs.panes.filter((p) => p.kind === 'rich').length;
  return { markdown: tabs.document.languageId === 'markdown', source: tabs.panes.length - rich, rich };
}

/** `tandemMarkdown.scrollSync` for the document: where a document nobody has toggled starts. */
function settingOn(uri: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration('tandemMarkdown', markdownScope(uri)).get('scrollSync') !== false;
}

function topOf(editor: vscode.TextEditor): { line: number; character: number } {
  const top = editor.visibleRanges[0]?.start;
  return top ? { line: top.line, character: top.character } : { line: 0, character: 0 };
}

function lineRange(r: vscode.Range): LineRange {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** The one scroll sync of the window; openToSide.ts uses it too. */
export const scrollSync = new ScrollSync();

export const scrollSyncFeature: HostFeature = (_context, _documents, testMode) => scrollSync.start(testMode);
