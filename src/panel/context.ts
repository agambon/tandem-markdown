// The panel's context: what every feature may use to reach the host, the page and the
// settings. One per panel. Features read it with `state.facet(panelContext)`.

import { Facet, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { FeatureRequest } from '../core/featureProtocol';
import type { DocInfo, HostToPanel, LogLevel, PanelSettings, PanelToHost, ReplyMessage } from '../core/protocol';
import { NoticeStrip, type NoticeHandle } from './notices';

export type { DocInfo, PanelSettings };

export interface HostBridge {
  post(message: PanelToHost): void;
  onMessage(listener: (message: HostToPanel) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

export interface PanelSlots {
  toolbar: HTMLElement;
  notices: HTMLElement;
  editor: HTMLElement;
}

export interface NoticeAction {
  label: string;
  /** What the button does. */
  run(): void | Promise<boolean>;
  /**
   * The notice stays while `run`'s promise is pending and closes only when it resolves true:
   * for a button that can fail, such as a copy, and must leave what the notice holds in view.
   * Otherwise the notice closes as the button is pressed.
   */
  closeWhenDone?: boolean;
}

export interface Notice {
  kind: 'info' | 'warning' | 'error';
  text: string;
  actions?: NoticeAction[] | undefined;
  sticky?: boolean;
}

interface RequestOptions {
  /** Milliseconds to wait for the reply; `null` means no time limit. Default REQUEST_TIMEOUT_MS. */
  timeoutMs?: number | null;
}

export interface PanelContext {
  readonly bridge: HostBridge;
  readonly doc: DocInfo;
  readonly slots: PanelSlots;
  /** Always the current settings. */
  readonly settings: PanelSettings;
  onSettingsChange(listener: () => void): () => void;
  /**
   * Adds a `requestId`; resolves with the reply's `result`; rejects on `ok: false` or after
   * `timeoutMs` (REQUEST_TIMEOUT_MS by default); `null` waits as long as it takes (a file dialog).
   */
  request<T = unknown>(message: FeatureRequest, options?: RequestOptions): Promise<T>;
  notify(notice: Notice): void;
  /** Posts `{ type: 'log', level, message, detail }` to the host. */
  log(level: LogLevel, message: string, detail?: unknown): void;
  view(): EditorView;
  /** Dispatches `spec` to the view; before there is one (a headless state) nothing is drawn, so it does nothing. */
  dispatch(spec: TransactionSpec): void;
}

export interface PanelContextHandle extends PanelContext {
  /** `notify`, with a handle to take the notice away again (the boot code's lost-contact warning). */
  showNotice(notice: Notice): NoticeHandle;
  setSettings(next: PanelSettings): void;
  setView(view: EditorView): void;
  /** Settles the request a `reply` answers. Returns true when `message` was a reply. */
  handleReply(message: HostToPanel): boolean;
}

/** The panel context of an editor state; undefined in a state made without one (headless tests). */
export const panelContext = Facet.define<PanelContext, PanelContext | undefined>({
  combine: (values) => values[0],
});

const REQUEST_TIMEOUT_MS = 10_000;

interface Pending {
  type: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** Undefined for a request with no time limit. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

function isReply(message: unknown): message is ReplyMessage {
  const m = message as { type?: unknown; requestId?: unknown } | null;
  return !!m && m.type === 'reply' && typeof m.requestId === 'string';
}

/** Makes an error or other value safe to post (structured clone cannot carry functions or DOM nodes). */
function serializableDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) return { name: detail.name, message: detail.message, stack: detail.stack };
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return String(detail);
  }
}

let requestCounter = 0;

export function createPanelContext(options: {
  bridge: HostBridge;
  doc: DocInfo;
  slots: PanelSlots;
  settings: PanelSettings;
}): PanelContextHandle {
  const { bridge, doc, slots } = options;
  let settings = options.settings;
  let view: EditorView | null = null;
  const settingsListeners = new Set<() => void>();
  const pending = new Map<string, Pending>();
  const strip = new NoticeStrip(slots.notices);

  const ctx: PanelContextHandle = {
    bridge,
    doc,
    slots,
    get settings() {
      return settings;
    },
    onSettingsChange(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    request<T>(message: FeatureRequest, options?: RequestOptions): Promise<T> {
      const requestId = `rq${++requestCounter}`;
      const timeoutMs = options?.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : options.timeoutMs;
      return new Promise<T>((resolve, reject) => {
        const timer =
          timeoutMs === null
            ? undefined
            : setTimeout(() => {
                pending.delete(requestId);
                reject(new Error(`No reply to "${message.type}" within ${timeoutMs / 1000} s`));
              }, timeoutMs);
        pending.set(requestId, { type: message.type, resolve: resolve as (v: unknown) => void, reject, timer });
        try {
          bridge.post({ ...message, requestId });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(notice) {
      strip.show(notice);
    },
    showNotice(notice) {
      return strip.show(notice);
    },
    log(level, message, detail) {
      const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
      out(`Tandem Markdown: ${message}`, detail ?? '');
      try {
        bridge.post({ type: 'log', level, message, detail: serializableDetail(detail) });
      } catch (error) {
        console.error('Tandem Markdown: could not send a log message to the host', error);
      }
    },
    view() {
      if (!view) throw new Error('The editor view has not been created yet');
      return view;
    },
    dispatch(spec) {
      view?.dispatch(spec);
    },
    setSettings(next) {
      settings = next;
      for (const listener of [...settingsListeners]) {
        try {
          listener();
        } catch (error) {
          ctx.log('error', 'A settings listener failed', error);
        }
      }
    },
    setView(next) {
      view = next;
    },
    handleReply(message) {
      if (!isReply(message)) return false;
      const waiting = pending.get(message.requestId);
      if (!waiting) return true;
      pending.delete(message.requestId);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result);
      else {
        const reason = typeof message.error === 'string' ? message.error : `"${waiting.type}" failed`;
        waiting.reject(new Error(reason));
      }
      return true;
    },
  };
  return ctx;
}
