// Messages from a panel's page. Every message goes to the document's coordinator first (it
// takes `ready`, `push`, `check`, `resyncRequest`, `fault` and `flushed`, and needs to see every
// message to know the panel is alive). What the coordinator does not take is handled here:
//   viewState, focus            kept in the panel registry (panels.ts)
//   log                         the log channel
//   anything else               the handler registered for its type
// A message that carried a `requestId` is answered with `{ type: 'reply', requestId, ok, result | error }`:
// the handler's return value (awaited), or the message of what it threw.
//
// Usage, from a feature's own file:
//   registerPanelMessageHandler('resolveLinks', async (message, panel) => ({ ... }))

import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { FeatureRequest, PanelFeatureMessage } from '../core/featureProtocol';
import type { PanelToHost, ReplyMessage, ViewStateMessage } from '../core/protocol';
import type { Documents } from './documents';
import { log } from './log';
import { panels, type HostPanel, type PanelRecord } from './panels';
import { fileNameOf } from './uris';

/** The longest string a handler takes from a panel message (an address, a path). */
export const MAX_MESSAGE_TEXT = 4000;

/** The distinct strings of a message field that should hold a list of them, at most `max`; anything else is left out. */
export function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.length <= MAX_MESSAGE_TEXT && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A message as it arrives from a panel's page: its `type` is known and every other field is
 * still to be checked.
 */
type Unchecked<M> = M extends { type: infer T }
  ? { readonly type: T } & { readonly [K in Exclude<keyof M, 'type'>]?: unknown }
  : never;

/** The feature messages a handler can be registered for (`log` is handled here). */
type HandledType = Exclude<PanelFeatureMessage['type'], 'log'>;

type PanelMessageHandler<T extends HandledType = HandledType> = (
  message: Unchecked<Extract<PanelFeatureMessage, { type: T }>>,
  panel: HostPanel,
) => unknown;

/** A handler as stored: the router calls it only with messages of the type it was registered for. */
interface Registered {
  handle(message: Unchecked<PanelFeatureMessage>, panel: HostPanel): unknown;
}

const handlers = new Map<string, Registered>();

/** The coordinator's own message types, and the ones this file handles itself. */
const RESERVED = new Set(['ready', 'push', 'check', 'resyncRequest', 'fault', 'flushed', 'viewState', 'focus', 'log']);

/**
 * Registers the handler for one message type. Registering a type twice, or a type the core
 * or this router handles, throws (two features must not both answer one message).
 */
export function registerPanelMessageHandler<T extends HandledType>(
  type: T,
  handler: PanelMessageHandler<T>,
): vscode.Disposable {
  if (RESERVED.has(type)) throw new Error(`The panel message "${type}" is handled by the host itself`);
  if (handlers.has(type)) throw new Error(`A handler for the panel message "${type}" is already registered`);
  const registered = { handle: handler } as Registered;
  handlers.set(type, registered);
  return new vscode.Disposable(() => {
    if (handlers.get(type) === registered) handlers.delete(type);
  });
}

/** What the handler registered for a request's type answers it from `panel` (the test hook asks through this). */
export function answerRequest(message: FeatureRequest, panel: HostPanel): unknown {
  const handler = handlers.get(message.type);
  if (!handler) throw new Error(`Nothing answers "${message.type}"`);
  return handler.handle(message as Unchecked<PanelFeatureMessage>, panel);
}

export function routePanelMessage(documents: Documents, panel: PanelRecord, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') {
    log('warn', 'A panel sent a message without a type', raw);
    return;
  }
  const message = raw as Unchecked<PanelToHost>;
  const tracked = documents.get(panel.key);
  // The coordinator checks the fields it reads.
  if (tracked && tracked.coordinator.panelMessage(panel.id, raw as PanelToHost)) return;

  switch (message.type) {
    case 'viewState':
      if (isViewState(message)) {
        panels.setViewState(panel, {
          selection: { anchor: message.selection.anchor, head: message.selection.head },
          topLine: message.topLine,
          topOffsetPx: typeof message.topOffsetPx === 'number' ? message.topOffsetPx : 0,
          mode: message.mode,
        });
      }
      return;
    case 'focus':
      panels.setFocus(panel, message.editor === true, message.field === true);
      return;
    case 'log': {
      const level = message.level === 'error' || message.level === 'warn' ? message.level : 'info';
      log(level, `Panel (${fileNameOf(panel.uri)}): ${String(message.message)}`, message.detail);
      return;
    }
    default:
      // Every other type goes to the handler registered for it.
      break;
  }

  const handler = handlers.get(message.type);
  const sentId = (message as { requestId?: unknown }).requestId;
  const requestId = typeof sentId === 'string' ? sentId : null;
  if (!handler) {
    log('warn', `No host handler for the panel message "${message.type}"`);
    if (requestId) reply(panel, { type: 'reply', requestId, ok: false, error: `Nothing answers "${message.type}"` });
    return;
  }
  let result: unknown;
  try {
    result = handler.handle(message as Unchecked<PanelFeatureMessage>, panel);
  } catch (error) {
    failed(panel, message.type, requestId, error);
    return;
  }
  if (!requestId) {
    // No answer wanted; still report a handler that fails later.
    Promise.resolve(result).catch((error: unknown) =>
      log('error', `The host handler for "${message.type}" failed`, error),
    );
    return;
  }
  Promise.resolve(result).then(
    (value) => reply(panel, { type: 'reply', requestId, ok: true, result: value }),
    (error: unknown) => failed(panel, message.type, requestId, error),
  );
}

function failed(panel: HostPanel, type: string, requestId: string | null, error: unknown): void {
  log('error', `The host handler for "${type}" failed`, error);
  if (requestId) reply(panel, { type: 'reply', requestId, ok: false, error: errorMessage(error) });
}

function reply(panel: HostPanel, message: ReplyMessage): void {
  void panel.post(message);
}

function isViewState(m: Unchecked<ViewStateMessage>): m is ViewStateMessage {
  const s = m.selection as { anchor?: unknown; head?: unknown } | undefined;
  return (
    !!s &&
    typeof s.anchor === 'number' &&
    typeof s.head === 'number' &&
    typeof m.topLine === 'number' &&
    (m.mode === 'view' || m.mode === 'edit')
  );
}
