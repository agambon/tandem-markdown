// The messages between a panel (the webview) and the host, and the small types and names both
// share. Positions and texts in them are LF text; the host never sends a "\r" to a panel.

import type { HostFeatureMessage, PanelFeatureMessage } from './featureProtocol';
import type { TextStamp } from './hash';

/** A panel whose bundle speaks another number is reloaded by the host. */
export const PROTOCOL = 1;

export type Mode = 'view' | 'edit';

/** The two rich views by the names the user reads, by the panel's mode. */
export const RICH_VIEW_NAME: Readonly<Record<Mode, string>> = { view: 'Rich view', edit: 'Rich editor' };

export interface ViewState {
  selection: { anchor: number; head: number };
  topLine: number;
  topOffsetPx: number;
  mode: Mode;
}

export interface PanelSettings {
  /** Column width in pixels; 0 for full width. */
  contentWidth: number;
  fontSize: number;
  /** Empty uses the system UI font. */
  fontFamily: string;
  /** Line height as a multiple of font size. */
  lineHeight: number;
  tableAlignOnEdit: boolean;
  frontmatterDisplay: 'table' | 'source' | 'hidden';
  imagesAllowRemote: boolean;
  maxRichFileSizeKb: number;
  tabSize: number;
  insertSpaces: boolean;
  defaultRichMode: Mode;
  /** `tandemMarkdown.outsideChanges.highlight`: lines changed by another program are marked for a moment. */
  outsideHighlight: boolean;
  /** `tandemMarkdown.outsideChanges.announce`: a screen reader is told when another program changes the note. */
  outsideAnnounce: boolean;
  /**
   * `tandemMarkdown.syntax.*`, by the name after `syntax.`: true or false, or the value chosen for
   * a setting with choices. A name missing here takes the default in src/panel/syntax/.
   */
  syntax: Readonly<Record<string, boolean | string>>;
  /** VS Code trusts the workspace. HTML in a file is drawn only then. */
  workspaceTrusted: boolean;
}

/**
 * Each setting's value when the user has set none: package.json's defaults, and VS Code's own for
 * `tabSize` and `insertSpaces`. Trust is never assumed, so it has none.
 */
export const SETTING_DEFAULTS: Readonly<Omit<PanelSettings, 'workspaceTrusted'>> = {
  contentWidth: 860,
  fontSize: 16,
  fontFamily: '',
  lineHeight: 1.6,
  tableAlignOnEdit: false,
  frontmatterDisplay: 'table',
  imagesAllowRemote: true,
  maxRichFileSizeKb: 2048,
  tabSize: 4,
  insertSpaces: true,
  defaultRichMode: 'edit',
  outsideHighlight: true,
  outsideAnnounce: true,
  syntax: {},
};

export interface DocInfo {
  uri: string;
  fileName: string;
  /** Workspace-relative path with forward slashes, or null outside every workspace folder. */
  workspacePath: string | null;
  readOnly: boolean;
}

/**
 * Why a foreign update happened; absent for typing in Source. 'merge' is another program's version
 * merged in; 'press' is the user's press of a message's button or a warning's quick fix, which may
 * bring another program's text in or put the user's back. 'outside' is the host's hint that the
 * change came from no text editor of this document; the core carries it and acts on nothing.
 */
export type UpdateReason = 'undo' | 'redo' | 'merge' | 'press' | 'outside';

/** One entry of the host's log as it crosses the wire. */
export interface WireUpdate {
  clientId: string;
  /** A CodeMirror ChangeSet in its JSON form (ChangeSet.toJSON()). */
  changes: unknown;
  reason?: UpdateReason;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** Timers and the clock, injected everywhere so the simulation owns time. */
export interface Schedule {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** The real timers and clock. */
export const systemSchedule: Schedule = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

// A panel answers a `flush` within FLUSH_MS, not clean when something is still unconfirmed by
// then. The host waits FLUSH_WAIT_MS for every panel's `flushed`: longer than a panel takes.
export const FLUSH_MS = 1500;
export const FLUSH_WAIT_MS = 2000;

// ---------------------------------------------------------------------------
// Panel to host

interface ReadyMessage {
  type: 'ready';
  protocol: number;
}

export interface PushMessage {
  type: 'push';
  clientId: string;
  /** The panel's synced version: the host's log version the updates were made on. */
  baseVersion: number;
  /** Every unconfirmed update, oldest first, each as ChangeSet JSON. */
  updates: unknown[];
  /** Stamp of the panel's whole text, after all of these updates. */
  expect: TextStamp;
}

interface FaultMessage {
  type: 'fault';
  kind: string;
  detail: string;
  /** The panel's whole text, so the host can write both texts to the log folder. */
  panelText?: string;
}

interface ResyncRequestMessage {
  type: 'resyncRequest';
  reason: string;
}

export interface ViewStateMessage extends ViewState {
  type: 'viewState';
}

interface FocusMessage {
  type: 'focus';
  /** The panel's editor has focus. */
  editor: boolean;
  /** A text field inside the panel (a table cell, the find box) has focus. */
  field: boolean;
}

export interface FlushedMessage {
  type: 'flushed';
  id: string;
  /** True only when the panel has nothing unconfirmed. */
  clean: boolean;
}

/**
 * The stamp of a panel's text at its synced version, sent with nothing unconfirmed once the panel
 * has been quiet after a change, and when it regains focus. A host further on resends the updates;
 * one at that version whose text differs answers with its own stamp (an empty `updates`).
 */
export interface CheckMessage extends TextStamp {
  type: 'check';
  clientId: string;
  version: number;
}

/** The messages the document core reads. */
type PanelSyncMessage =
  | ReadyMessage
  | PushMessage
  | FaultMessage
  | ResyncRequestMessage
  | ViewStateMessage
  | FocusMessage
  | FlushedMessage
  | CheckMessage;

export type PanelToHost = PanelSyncMessage | PanelFeatureMessage;

// ---------------------------------------------------------------------------
// Host to panel

export interface InitMessage {
  type: 'init';
  protocol: number;
  /** New for every init. A push under any earlier id is ignored by the host. */
  clientId: string;
  text: string;
  version: number;
  hash: string;
  length: number;
  mode: Mode;
  readOnly: boolean;
  settings: PanelSettings;
  viewState?: ViewState;
  docInfo: DocInfo;
  reason: 'open' | 'resync';
  /** The extension runs under its in-VS-Code suite: the panel answers `test` messages. */
  testMode?: true;
}

export interface UpdatesMessage {
  type: 'updates';
  /** The log version the first update applies to. */
  fromVersion: number;
  updates: WireUpdate[];
  /** fromVersion + updates.length. */
  version: number;
  /** Stamp of the host's whole text at `version`. */
  length: number;
  hash: string;
}

export type PushRejection = 'stale' | 'invalid' | 'failed' | 'diverged' | 'superseded';

export interface PushRejectedMessage {
  type: 'pushRejected';
  reason: PushRejection;
  /** The host's log version when it answered. */
  version: number;
  /** The client id the rejected push carried, so a panel ignores answers meant for an earlier init. */
  clientId: string;
}

export interface FlushMessage {
  type: 'flush';
  id: string;
}

interface SetModeMessage {
  type: 'setMode';
  mode: Mode;
}

/**
 * Whether the panel's tab is shown (VS Code's `WebviewPanel.visible`): false while another tab
 * is in front of it or its group is hidden, when VS Code keeps the page running with nothing in
 * the page to show it. A page starts out shown, and is told when it is not.
 */
interface TabShownMessage {
  type: 'tabShown';
  shown: boolean;
}

interface SettingsMessage {
  type: 'settings';
  settings: PanelSettings;
}

interface CommandMessage {
  type: 'command';
  id: string;
  args?: unknown;
}

/** A notice the host asks the panel to show in its page. It carries no buttons. */
export interface NoticeMessage {
  type: 'notice';
  kind: 'info' | 'warning' | 'error';
  text: string;
  sticky?: boolean;
}

export interface ReplyMessage {
  type: 'reply';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The messages `PanelSync.handle` takes. */
type HostSyncMessage = UpdatesMessage | PushRejectedMessage | FlushMessage;

export type HostToPanel =
  | InitMessage
  | HostSyncMessage
  | SetModeMessage
  | TabShownMessage
  | SettingsMessage
  | CommandMessage
  | NoticeMessage
  | ReplyMessage
  | HostFeatureMessage;
