// The panel registry: every webview our editor has open, which one is active, each panel's
// mode and last view state, and the context keys the keybindings and the title bar read.
//
// Context keys of the active panel, false or '' when the active editor is not one of ours:
//   tandemMarkdown.editorFocus  focus is inside the panel's page (its editor or a field in it)
//   tandemMarkdown.fieldFocus   a text field inside the panel has focus (a table cell, the find box)
//   tandemMarkdown.mode         'view' or 'edit'
//
// And two lists of files (`uri.toString()`) for the Show buttons, from the rich tabs VS Code
// draws them for: every visible one when `actionsOnEveryGroupNow`, else the active panel alone.
//   tandemMarkdown.richViewFiles    files with such a rich tab in Rich view (a read-only one always is)
//   tandemMarkdown.richEditorFiles  files with such a rich tab in the Rich editor

import * as vscode from 'vscode';
import type { InitFields } from '../core/coordinator';
import type { DocInfo, HostToPanel, Mode, ViewState } from '../core/protocol';
import { setContextKey } from './contextKeys';
import type { Documents, PanelHost } from './documents';
import { log } from './log';
import { actionsOnEveryGroup } from './model/showButtons';
import { affectsPanelSettings, readPanelSettings } from './settings';
import { fileNameOf, workspaceRelative } from './uris';

/** What other host code sees of a panel. */
export interface HostPanel {
  /** The id the coordinator knows the panel by. */
  readonly id: string;
  readonly document: vscode.TextDocument;
  readonly uri: vscode.Uri;
  readonly webviewPanel: vscode.WebviewPanel;
  readonly readOnly: boolean;
  /** The mode the panel is in (or was told to switch to). */
  readonly mode: Mode;
  /** The panel's last reported view state (selection and top line; LF offsets). */
  readonly viewState: ViewState | undefined;
  /**
   * What the panel reports of the keyboard in its `focus { editor, field }` messages. A panel
   * that stops being the active one is taken to have lost focus until it reports again.
   */
  readonly focus: { readonly editor: boolean; readonly field: boolean };
  /** The panel has been sent its `init` and receives everything posted from now on. */
  readonly live: boolean;
  /**
   * Its webview has been disposed (the tab closed). Reading `webviewPanel.active` or
   * `viewColumn` then throws: look at this first after any await.
   */
  readonly disposed: boolean;
  /** Posts a message to the panel's page. Resolves false when VS Code could not deliver it. */
  post(message: HostToPanel): Thenable<boolean>;
  /** Sets the webview's HTML again, so the page starts fresh from the document. */
  reload(): void;
}

/** The registry's own record of a panel. */
export interface PanelRecord extends HostPanel {
  /** `uri.toString()`: the documents' key. */
  readonly key: string;
  mode: Mode;
  viewState: ViewState | undefined;
  /** Given to the panel in its first `init` (from a switch out of Source). */
  initialViewState: ViewState | undefined;
  focus: { editor: boolean; field: boolean };
  live: boolean;
  disposed: boolean;
  /** Whether the page was last told its tab is shown (`tabShown`); a page starts out shown. */
  toldShown: boolean;
}

let nextPanel = 0;
export function newPanelId(): string {
  return `panel${++nextPanel}`;
}

class Panels implements vscode.Disposable, PanelHost {
  private readonly records = new Map<string, PanelRecord>();
  private active: PanelRecord | undefined;
  private documents: Documents | null = null;
  private readonly activeChanged = new vscode.EventEmitter<HostPanel | undefined>();
  private readonly viewStateChanged = new vscode.EventEmitter<HostPanel>();
  private readonly panelLive = new vscode.EventEmitter<HostPanel>();
  private readonly listChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watching = new Map<string, vscode.Disposable>();
  private testMode = false;

  /** The active panel changed (undefined: the active editor is not one of ours). */
  readonly onDidChangeActivePanel = this.activeChanged.event;
  /** A panel reported a new view state (selection, scroll, mode), or its mode was changed by the host. */
  readonly onDidChangeViewState = this.viewStateChanged.event;
  /** A panel was sent its `init` (on open, after a reload, after a resync): what is posted now arrives after it. */
  readonly onDidBecomeLive = this.panelLive.event;
  /** A panel was added or removed. */
  readonly onDidChangePanels = this.listChanged.event;

  /** Called once from activate. In test mode every init tells the panel so, and it answers the test hook. */
  start(documents: Documents, testMode: boolean): vscode.Disposable {
    this.documents = documents;
    this.testMode = testMode;
    this.disposables.push(
      this.activeChanged,
      this.viewStateChanged,
      this.panelLive,
      this.listChanged,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsPanelSettings(e)) this.sendSettings();
        if (EDITOR_ACTION_SETTINGS.some((name) => e.affectsConfiguration(`workbench.editor.${name}`))) this.setKeys();
      }),
      // HTML in a file is drawn only in a trusted workspace (PanelSettings.workspaceTrusted).
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.sendSettings()),
    );
    this.setKeys();
    return this;
  }

  private sendSettings(): void {
    for (const p of this.records.values()) {
      if (p.live) void p.post({ type: 'settings', settings: readPanelSettings(p.uri) });
    }
  }

  activePanel(): HostPanel | undefined {
    return this.active;
  }

  panelsFor(uri: vscode.Uri | string): HostPanel[] {
    const key = typeof uri === 'string' ? uri : uri.toString();
    return [...this.records.values()].filter((p) => p.key === key && !p.disposed);
  }

  all(): HostPanel[] {
    return [...this.records.values()].filter((p) => !p.disposed);
  }

  /** The panels of one document that have been sent their init, so take messages now. */
  livePanelsFor(uri: vscode.Uri | string): HostPanel[] {
    return this.panelsFor(uri).filter((p) => p.live);
  }

  /**
   * The first panel `accept` takes once it is live, or undefined when none is within
   * `timeoutMs`. It resolves after the panel's `init` has been posted.
   */
  whenLive(accept: (panel: HostPanel) => boolean, timeoutMs: number): Promise<HostPanel | undefined> {
    const now = this.all().find((p) => p.live && accept(p));
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (p: HostPanel | undefined) => {
        clearTimeout(timer);
        sub.dispose();
        resolve(p);
      };
      const sub = this.onDidBecomeLive((p) => {
        if (accept(p)) done(p);
      });
      const timer = setTimeout(() => done(this.all().find((p) => p.live && accept(p))), timeoutMs);
    });
  }

  /**
   * Calls `run` with the active panel `delayMs` after its document last changed (each change
   * starts the wait again). Another panel becoming active cancels the wait.
   */
  onActivePanelTextChanged(delayMs: number, run: (panel: HostPanel) => void): vscode.Disposable {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const changed = vscode.workspace.onDidChangeTextDocument((e) => {
      const p = this.active;
      if (!p || e.document !== p.document || e.contentChanges.length === 0) return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (this.active === p) run(p);
      }, delayMs);
    });
    return vscode.Disposable.from(changed, this.onDidChangeActivePanel(cancel), { dispose: cancel });
  }

  add(record: PanelRecord): void {
    this.records.set(record.id, record);
    this.watching.set(
      record.id,
      record.webviewPanel.onDidChangeViewState(() => {
        this.recomputeActive();
        this.tellShown(record);
      }),
    );
    this.listChanged.fire();
    this.recomputeActive();
  }

  remove(id: string): void {
    const p = this.records.get(id);
    if (!p) return;
    p.disposed = true;
    p.live = false;
    this.records.delete(id);
    this.watching.get(id)?.dispose();
    this.watching.delete(id);
    this.listChanged.fire();
    this.recomputeActive();
  }

  // ---------------------------------------------------------------------------
  // What panels report

  setFocus(p: PanelRecord, editor: boolean, field: boolean): void {
    p.focus = { editor, field };
    if (p === this.active) this.setKeys();
  }

  setViewState(p: PanelRecord, viewState: ViewState): void {
    p.viewState = viewState;
    if (viewState.mode !== p.mode) {
      p.mode = viewState.mode;
      this.setKeys();
    }
    this.viewStateChanged.fire(p);
  }

  /** The host changed the panel's mode (a view command): tell the page and the keys. */
  setMode(panelId: string, mode: Mode): void {
    const p = this.records.get(panelId);
    if (!p) return;
    p.mode = mode;
    if (p.viewState) p.viewState = { ...p.viewState, mode };
    if (p.live) void p.post({ type: 'setMode', mode });
    this.setKeys();
    this.viewStateChanged.fire(p);
  }

  // ---------------------------------------------------------------------------
  // PanelHost (the documents' UI port)

  post(panelId: string, message: HostToPanel): void {
    const p = this.records.get(panelId);
    if (!p || p.disposed) return;
    const failed = () => this.documents?.get(p.key)?.coordinator.panelPostFailed(panelId);
    let sent: Thenable<boolean>;
    try {
      sent = p.webviewPanel.webview.postMessage(message);
    } catch (error) {
      log('warn', `Could not post to a panel of ${fileNameOf(p.uri)}`, error);
      failed();
      return;
    }
    if (message.type === 'init') {
      p.live = true;
      // The page may be new (the tab was reloaded), and a new page starts out shown.
      p.toldShown = true;
      this.tellShown(p);
      this.panelLive.fire(p);
    }
    sent.then(
      (ok) => {
        if (!ok && !p.disposed) failed();
      },
      () => {
        if (!p.disposed) failed();
      },
    );
  }

  initFields(panelId: string, reason: 'open' | 'resync'): InitFields {
    const p = this.records.get(panelId);
    if (!p) throw new Error(`No panel ${panelId}`);
    const fields: InitFields = {
      mode: p.readOnly ? 'view' : p.mode,
      settings: readPanelSettings(p.uri),
      docInfo: docInfo(p.document, p.readOnly),
    };
    if (this.testMode) fields.testMode = true;
    if (reason === 'open') {
      // First open: the view state carried from Source. After "Reload tab": the last one reported.
      const vs = p.viewState ?? p.initialViewState;
      if (vs) fields.viewState = { ...vs, mode: fields.mode };
    }
    return fields;
  }

  reloadPanel(panelId: string): void {
    const p = this.records.get(panelId);
    if (!p || p.disposed) return;
    p.live = false;
    p.focus = { editor: false, field: false };
    if (p === this.active) this.setKeys();
    p.reload();
  }

  panelIdsFor(key: string): string[] {
    return this.panelsFor(key).map((p) => p.id);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const d of this.watching.values()) d.dispose();
    this.disposables.length = 0;
    this.watching.clear();
    this.records.clear();
    this.active = undefined;
  }

  /**
   * Tells the panel's page whether its tab is shown, when that is not what it was last told: the
   * page holds its outside-change marks while its tab is behind another tab or in a hidden group.
   */
  private tellShown(p: PanelRecord): void {
    if (p.disposed || !p.live) return;
    const shown = p.webviewPanel.visible;
    if (shown === p.toldShown) return;
    p.toldShown = shown;
    void p.post({ type: 'tabShown', shown });
  }

  // ---------------------------------------------------------------------------
  // The active panel and context keys

  private recomputeActive(): void {
    const next = [...this.records.values()].find((p) => !p.disposed && p.webviewPanel.active);
    if (next === this.active) {
      this.setKeys();
      return;
    }
    // A panel that is no longer active has lost focus; it says so again when it gets it back.
    if (this.active) this.active.focus = { editor: false, field: false };
    this.active = next;
    this.setKeys();
    this.activeChanged.fire(next);
  }

  private setKeys(): void {
    const a = this.active;
    setContextKey('tandemMarkdown.editorFocus', !!a && (a.focus.editor || a.focus.field));
    setContextKey('tandemMarkdown.fieldFocus', !!a && a.focus.field);
    setContextKey('tandemMarkdown.mode', a ? viewOf(a) : '');
    const drawn = actionsOnEveryGroupNow()
      ? [...this.records.values()].filter((p) => !p.disposed && p.webviewPanel.visible)
      : a
        ? [a]
        : [];
    const files = (view: Mode) => [...new Set(drawn.filter((p) => viewOf(p) === view).map((p) => p.key))].sort();
    setContextKey('tandemMarkdown.richViewFiles', files('view'));
    setContextKey('tandemMarkdown.richEditorFiles', files('edit'));
  }
}

/** The view a panel shows: a read-only document is always in Rich view. */
function viewOf(p: PanelRecord): Mode {
  return p.readOnly ? 'view' : p.mode;
}

/** The `workbench.editor` settings `actionsOnEveryGroup` reads. */
const EDITOR_ACTION_SETTINGS = ['editorActionsLocation', 'showTabs', 'alwaysShowEditorActions'];

/** VS Code draws the editor actions, the Show buttons among them, on every group's title bar now (model/showButtons.ts). */
export function actionsOnEveryGroupNow(): boolean {
  const editor = vscode.workspace.getConfiguration('workbench.editor');
  return actionsOnEveryGroup({
    location: editor.get('editorActionsLocation'),
    showTabs: editor.get('showTabs'),
    alwaysShow: editor.get('alwaysShowEditorActions'),
  });
}

function docInfo(document: vscode.TextDocument, readOnly: boolean): DocInfo {
  const uri = document.uri;
  const folder = uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  return {
    uri: uri.toString(),
    fileName: fileNameOf(uri),
    workspacePath: folder ? workspaceRelative(folder.uri, uri) : null,
    readOnly,
  };
}

/** A short warning in the panel's own notice strip. */
export function tellPanel(panel: HostPanel, text: string): void {
  if (panel.live) void panel.post({ type: 'notice', kind: 'warning', text });
}

/** The one registry. It does nothing until activate calls `start`. */
export const panels = new Panels();
