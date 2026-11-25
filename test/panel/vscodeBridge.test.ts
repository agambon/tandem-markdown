// The bridge over VS Code's webview API takes only VS Code's messages. The page stands in for
// the panel's frame; each message event is shaped as Chrome delivers it there: from VS Code's
// host page with the frame's own origin, from a sandboxed frame inside it with the origin "null".

import { describe, expect, it, vi } from 'vitest';
import { vscodeBridge, type PanelWindow, type VsCodeApi } from '../../src/panel/vscodeBridge';

const ORIGIN = 'vscode-webview://0123456789abcdef';

function panelPage(): PanelWindow & EventTarget {
  return Object.assign(new EventTarget(), { origin: ORIGIN });
}

const api: VsCodeApi = { postMessage: () => {}, getState: () => undefined, setState: () => {} };

/** A message event as the page receives it from `source`. */
function message(data: unknown, origin: string, source: object): Event {
  return Object.assign(new Event('message'), { data, origin, source });
}

describe('the VS Code bridge', () => {
  const hostPage = {};
  const update = { type: 'updates', fromVersion: 0, updates: [], version: 0, length: 0, hash: 0 };

  it("passes on VS Code's messages", () => {
    const page = panelPage();
    const listener = vi.fn();
    vscodeBridge(api, page).onMessage(listener);
    page.dispatchEvent(message(update, ORIGIN, hostPage));
    expect(listener.mock.calls).toEqual([[update]]);
  });

  it('ignores a message from a frame inside the panel, such as the diagram frame', () => {
    const page = panelPage();
    const listener = vi.fn();
    vscodeBridge(api, page).onMessage(listener);
    page.dispatchEvent(message(update, 'null', {}));
    page.dispatchEvent(message(update, 'https://example.com', {}));
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a message the panel posts to itself', () => {
    const page = panelPage();
    const listener = vi.fn();
    vscodeBridge(api, page).onMessage(listener);
    page.dispatchEvent(message(update, ORIGIN, page));
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores a message from VS Code that names no type, and stops listening when asked', () => {
    const page = panelPage();
    const listener = vi.fn();
    const stop = vscodeBridge(api, page).onMessage(listener);
    page.dispatchEvent(message({ kind: 'updates' }, ORIGIN, hostPage));
    page.dispatchEvent(message('updates', ORIGIN, hostPage));
    stop();
    page.dispatchEvent(message(update, ORIGIN, hostPage));
    expect(listener).not.toHaveBeenCalled();
  });
});
