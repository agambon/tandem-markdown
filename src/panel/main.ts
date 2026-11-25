// The panel's entry point inside VS Code's webview: wraps acquireVsCodeApi() as a HostBridge
// (vscodeBridge.ts) and boots the panel into #tm-root.
//
// The boot code is loaded with a dynamic import. A static import would let a module that throws
// while it loads stop the page before any of our code runs, leaving an empty tab; this way the
// failure page ("Tandem Markdown could not start in this tab." with Show Source) is shown instead.

import { showFailurePage } from './failurePage';
import { vscodeBridge, type VsCodeApi } from './vscodeBridge';

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

const bridge = vscodeBridge(api, window);

function rootElement(): HTMLElement {
  const found = document.getElementById('tm-root');
  if (found) return found;
  const made = document.createElement('div');
  made.id = 'tm-root';
  document.body.appendChild(made);
  return made;
}

const root = rootElement();

import('./boot').then(
  ({ bootPanel }) => {
    bootPanel(bridge, root);
  },
  (error: unknown) => {
    // No init reaches this page, so it never answers the test hook.
    const detail = `The panel's code did not load: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    try {
      api.postMessage({ type: 'startFailed', detail });
    } catch {
      // Nothing more can be done from here.
    }
    showFailurePage(root, () => api.postMessage({ type: 'showSource' }));
  },
);
