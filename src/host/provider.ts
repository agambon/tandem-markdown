// The custom editor that hosts the panel. It joins each webview to its document's coordinator
// and builds the page; it decides nothing about text.
//
// Attach order: the panel is attached to the coordinator before its page exists, and the
// coordinator posts `init` itself when the page sends `ready`; until then the panel receives
// no broadcast.
//
// The page has a strict content policy (scripts and styles by nonce, images from the webview and
// https), with the nonce in a `<meta>` for CodeMirror's style tags. A small inline script draws
// "Tandem Markdown could not start in this tab." with a "Show Source" button when the bundle
// fails to load or throws before it has drawn anything; a bundle that runs draws its own page.

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Documents } from './documents';
import { log } from './log';
import { VIEW_TYPE } from './model/editorIds';
import { takePendingOpen } from './modeSwitch';
import { registerPanelMessageHandler, routePanelMessage } from './panelMessages';
import { newPanelId, panels, type PanelRecord } from './panels';
import { defaultRichMode } from './settings';
import { fileNameOf } from './uris';
import { keptPlaceFor } from './viewPlaces';

interface ProviderOptions {
  testMode: boolean;
}

/** What the test hook sets and reads in the editor. */
interface ProviderTestHooks {
  /** Pages opened from now on load this script instead of dist/panel/main.js. */
  panelScript: vscode.Uri | undefined;
  /** What a page's start guard reported, by document uri. */
  readonly startFailures: Map<string, string[]>;
}

export class TandemMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  /** Present in test mode only. */
  readonly testHooks: ProviderTestHooks | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly documents: Documents,
    private readonly options: ProviderOptions,
  ) {
    this.testHooks = options.testMode ? { panelScript: undefined, startFailures: new Map() } : undefined;
  }

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
      registerPanelMessageHandler('reloadView', (_m, panel) => panel.reload()),
      registerPanelMessageHandler('startFailed', (m, panel) => {
        const detail = String(m.detail ?? '');
        log('error', `The panel for ${fileNameOf(panel.uri)} could not start`, detail);
        // A failed page answers nothing: the coordinator lets it go at once, so no flush waits
        // on it (Show Source, undo in the document's other panels). A reload of the page
        // (record.reload) attaches it again.
        this.documents.get(panel.uri)?.coordinator.panelDetached(panel.id);
        const failures = this.testHooks?.startFailures;
        if (failures) {
          const key = panel.uri.toString();
          failures.set(key, [...(failures.get(key) ?? []), detail]);
        }
      }),
    );
  }

  resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
    const tracked = this.documents.ensure(document);
    const id = newPanelId();
    const opening = takePendingOpen(document.uri);
    // A switch or an open to the side carries its own place; otherwise the note opens where it was left.
    const kept = opening?.viewState ? undefined : keptPlaceFor(document);
    const mode = tracked.readOnly ? 'view' : (opening?.mode ?? kept?.mode ?? defaultRichMode(document.uri));
    const webview = webviewPanel.webview;
    webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots(document) };

    const record: PanelRecord = {
      id,
      document,
      uri: document.uri,
      key: tracked.key,
      webviewPanel,
      readOnly: tracked.readOnly,
      mode,
      viewState: undefined,
      initialViewState: opening?.viewState ?? kept?.viewState,
      focus: { editor: false, field: false },
      live: false,
      disposed: false,
      toldShown: true,
      post: (message) => webview.postMessage(message),
      reload: () => {
        if (record.disposed) return;
        // A fresh page: the coordinator forgets the old one and waits for the new `ready`.
        this.documents.get(record.key)?.coordinator.panelAttached(id);
        record.live = false;
        webview.html = this.html(webview, document);
      },
    };

    panels.add(record);
    tracked.coordinator.panelAttached(id);
    const subscriptions = [
      webview.onDidReceiveMessage((message) => routePanelMessage(this.documents, record, message)),
      webviewPanel.onDidDispose(() => {
        for (const s of subscriptions) s.dispose();
        this.documents.get(record.key)?.coordinator.panelDetached(id);
        panels.remove(id);
      }),
    ];
    webview.html = this.html(webview, document);
  }

  private resourceRoots(document: vscode.TextDocument): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist')];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    if (document.uri.scheme === 'file') roots.push(vscode.Uri.joinPath(document.uri, '..'));
    const testScript = this.testHooks?.panelScript;
    if (testScript) roots.push(vscode.Uri.joinPath(testScript, '..'));
    return roots;
  }

  private html(webview: vscode.Webview, document: vscode.TextDocument): string {
    const nonce = randomBytes(18).toString('base64');
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'panel');
    const asUri = (uri: vscode.Uri) => webview.asWebviewUri(uri).toString();
    const script = this.testHooks?.panelScript ?? vscode.Uri.joinPath(dist, 'main.js');
    return pageHtml({
      nonce,
      cspSource: webview.cspSource,
      assets: `${asUri(dist)}/`,
      codiconCss: asUri(vscode.Uri.joinPath(dist, 'codicon.css')),
      panelCss: asUri(vscode.Uri.joinPath(dist, 'panel.css')),
      script: asUri(script),
      title: fileNameOf(document.uri) || 'Tandem Markdown',
      testMode: this.options.testMode,
    });
  }
}

function pageHtml(o: {
  nonce: string;
  cspSource: string;
  /** The address of dist/panel/, ending in a slash: where the panel finds its own files. */
  assets: string;
  codiconCss: string;
  panelCss: string;
  script: string;
  title: string;
  testMode: boolean;
}): string {
  // Pictures and played media from https addresses are allowed here and loaded only while
  // `tandemMarkdown.images.allowRemote` is on: the host's `resolveImages` and the panel's HTML
  // door both read that one setting. `data:` is for the panel's own icons and for pictures
  // stored in a file, which the door limits to PNG, JPEG, GIF and WebP. Media plays only
  // under `tandemMarkdown.syntax.media`.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${o.nonce}' ${o.cspSource}`,
    `style-src ${o.cspSource} 'nonce-${o.nonce}'`,
    `img-src ${o.cspSource} https: data:`,
    `media-src ${o.cspSource} https:`,
    `font-src ${o.cspSource}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="tm-csp-nonce" content="${attr(o.nonce)}">
<meta name="tm-assets" content="${attr(o.assets)}">
<link rel="stylesheet" href="${attr(o.codiconCss)}">
<link rel="stylesheet" href="${attr(o.panelCss)}">
<title>${text(o.title)}</title>
</head>
<body>
<div id="tm-root"></div>
<script nonce="${attr(o.nonce)}">${startGuard(o.testMode)}</script>
<script type="module" nonce="${attr(o.nonce)}" src="${attr(o.script)}"></script>
</body>
</html>`;
}

/**
 * Shows the failure page when the panel bundle cannot load or throws before it has drawn
 * anything into #tm-root. It acquires VS Code's API only then, so a bundle that runs keeps it.
 * In test mode the failure page also answers `test` messages (its state, and a click on
 * "Show Source"), so the in-VS-Code suite can see it and press the button. It takes them only
 * from VS Code's host page, known as src/panel/vscodeBridge.ts knows it: a message of the page's
 * own origin from a window other than the page.
 */
function startGuard(testMode: boolean): string {
  return `(function () {
  var root = document.getElementById('tm-root');
  var shown = false;
  function describe(e) {
    if (e && e.error) return String(e.error && e.error.stack || e.error);
    if (e && e.reason) return String(e.reason && e.reason.stack || e.reason);
    if (e && e.message) return String(e.message);
    if (e && e.target && e.target.src) return 'Could not load ' + e.target.src;
    return 'Unknown error';
  }
  function fail(detail) {
    if (shown || !root || root.childElementCount > 0) return;
    shown = true;
    var api = null;
    // When the bundle already holds the API it is running and owns the page.
    try { api = acquireVsCodeApi(); } catch (error) { return; }
    var box = document.createElement('div');
    box.className = 'tm-start-failed';
    box.setAttribute('role', 'alert');
    box.style.padding = '2em';
    box.style.fontFamily = 'var(--vscode-font-family)';
    var p = document.createElement('p');
    p.textContent = 'Tandem Markdown could not start in this tab.';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Show Source';
    button.style.padding = '4px 12px';
    button.style.border = 'none';
    button.style.color = 'var(--vscode-button-foreground)';
    button.style.background = 'var(--vscode-button-background)';
    button.style.cursor = 'pointer';
    button.addEventListener('click', function () { api.postMessage({ type: 'showSource' }); });
    box.appendChild(p);
    box.appendChild(button);
    root.appendChild(box);
    api.postMessage({ type: 'startFailed', detail: detail });
    if (${testMode ? 'true' : 'false'}) {
      window.addEventListener('message', function (ev) {
        if (ev.origin !== window.origin || ev.source === window) return;
        var m = ev.data;
        if (!m || m.type !== 'test') return;
        var actions = Array.isArray(m.actions) ? m.actions : [];
        for (var i = 0; i < actions.length; i++) {
          if (actions[i] && actions[i].type === 'click' && actions[i].target === 'showSource') button.click();
        }
        api.postMessage({ type: 'testResult', requestId: m.requestId, result: { failurePage: true, text: root.textContent, cspViolations: [] } });
      });
    }
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (e instanceof ErrorEvent || (t && t.tagName === 'SCRIPT')) fail(describe(e));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { fail(describe(e)); });
})();`;
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
