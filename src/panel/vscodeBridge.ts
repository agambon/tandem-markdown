// The panel's HostBridge inside VS Code's webview, over the API VS Code's host page gives the
// page (`acquireVsCodeApi()`). Only a message from VS Code reaches the panel: the page also
// receives messages from the frames inside it, such as the diagram frame, where Mermaid draws
// a note's text, and none of those may pass for the host.

import type { HostToPanel } from '../core/protocol';
import type { HostBridge } from './context';

/** What `acquireVsCodeApi()` returns. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** The window the panel runs in, as far as the bridge needs it. */
export type PanelWindow = Pick<Window, 'origin' | 'addEventListener' | 'removeEventListener'>;

/**
 * Whether `event` comes from VS Code's host page. That page holds the panel's frame, which it
 * loads from its own origin, and posts every message with its own origin as the target; the
 * API it puts in the frame sets `window.parent` to the frame itself, so the page cannot be named
 * (VS Code 1.120 to 1.146). Any other window that can post
 * here is a frame inside the panel, of another origin, or the panel itself.
 */
function fromHostPage(event: MessageEvent, page: PanelWindow): boolean {
  return event.origin === page.origin && event.source !== page;
}

export function vscodeBridge(api: VsCodeApi, page: PanelWindow): HostBridge {
  return {
    post: (message) => api.postMessage(message),
    onMessage(listener) {
      const onMessage = (event: MessageEvent) => {
        if (!fromHostPage(event, page)) return;
        const data: unknown = event.data;
        if (data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string')
          listener(data as HostToPanel);
      };
      page.addEventListener('message', onMessage);
      return () => page.removeEventListener('message', onMessage);
    },
    getState: <T>() => api.getState() as T | undefined,
    setState: (state) => api.setState(state),
  };
}
