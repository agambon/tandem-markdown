// The test hook: returned by activate only when the extension runs under the in-VS-Code suite
// (`ExtensionMode.Test`), and, besides what five commands resolve with (docs/ARCHITECTURE.md,
// "The test hook"), the suite's only way into the extension. Nothing here is reachable otherwise.
//
// `runInPanel` posts `{ type: 'test', requestId, actions }` to the panel and resolves with its
// `testResult`. The panel side is src/panel/testHook.ts, which a panel installs only when its
// init says test mode; the failure page's guard (provider.ts) answers too, with
// `{ failurePage: true, text }`. Features hand over what the suite reads of them with
// `exposeSnapshot` (testSnapshots.ts).

import type * as vscode from 'vscode';
import type { CoordinatorState, CoreNotice } from '../core/coordinator';
import type {
  CompletionsResult,
  EmbedNoteAnswer,
  FailurePageTestState,
  FeatureRequest,
  PanelTestState,
  PreviewNoteResult,
  TestAction,
} from '../core/featureProtocol';
import type { ViewState } from '../core/protocol';
import { suggestionsAt } from './completions';
import type { Documents } from './documents';
import { embedNote, previewNote } from './links/notePreview';
import { linesAfter, loggedCount, type LogLine } from './log';
import { messages } from './messages';
import { raisedNotices } from './notices';
import type { OutlineTestState } from './outlineView';
import { answerRequest, registerPanelMessageHandler } from './panelMessages';
import { panels, type HostPanel } from './panels';
import { lfTextOf } from './panelText';
import type { TandemMarkdownEditorProvider } from './provider';
import { answerPromptsForTests, type PromptForTests } from './questions';
import type { ScrollSyncTestState } from './scrollSync';
import type { StatusBarTestState } from './statusBar';
import { snapshot } from './testSnapshots';
import { sameUri } from './uris';
import { forgetPlacesForTests } from './viewPlaces';

/**
 * What the test hook resolves with: the panel's state, or the failure page's (which has only
 * `failurePage`, `text` and `cspViolations`), and what an action threw.
 */
type PanelTestResult = PanelTestState & Partial<FailurePageTestState> & { error?: string };

export interface TandemMarkdownTestApi {
  /** The panel's own view of itself (the first panel showing the document, or the one in `column`). */
  panelState(uri: vscode.Uri, column?: vscode.ViewColumn): Promise<PanelTestResult>;
  /** Runs the actions in the panel (the first, or the one in `column`), in order, and resolves with its state afterward. */
  runInPanel(uri: vscode.Uri, actions: TestAction[], column?: vscode.ViewColumn): Promise<PanelTestResult>;
  /**
   * Takes the document's lock (as a save or an undo holds it) until the returned function is
   * called, so a command that waits for it can be overtaken by the user.
   */
  holdDocument(uri: vscode.Uri): () => void;
  /** Asks every panel of the document to send what it has not sent. True when all were clean. */
  flush(uri: vscode.Uri): Promise<boolean>;
  /** The coordinator's state (`inspect()`), with the document's dirty flag and the panels' host-side records. */
  coordinatorState(uri: vscode.Uri): CoordinatorTestState | undefined;
  /** Resolves when a panel for the document has been sent its init. */
  whenPanelLive(uri: vscode.Uri, timeoutMs?: number): Promise<void>;
  /** Every notice the core raised since the last `clearRecords`. */
  notices(): { notice: CoreNotice; uri: string }[];
  /** The message of a notice that asks something, with the buttons in it, while it is open (messages.ts). */
  askedFor(noticeId: string): { text: string; items: readonly string[] } | undefined;
  /** Presses a button of the open message of a notice, in its pop-up or its strip; false when it has no such button. */
  answerNotice(noticeId: string, choice: string): boolean;
  /** Runs a conflict's choice on its diff's title bar, as its button does; false while it does not apply. */
  answerChoice(noticeId: string): Promise<boolean>;
  /** Log lines since the last `clearRecords`, as many as the log still keeps (`KEPT_LINES_MAX` in log.ts). */
  logLines(): LogLine[];
  /** What failure pages reported, for the document. */
  startFailures(uri: vscode.Uri): string[];
  clearRecords(): void;
  /** Panels opened from now on load this script instead of dist/panel/main.js (undefined restores it). */
  setPanelScript(uri: vscode.Uri | undefined): void;
  /** The global storage folder (where backups go). */
  globalStorageUri: vscode.Uri;
  /** The log folder (fault dumps, Verify File's texts). */
  logUri: vscode.Uri;
  /** Answers the "by default" commands' questions in place of the user; undefined restores the dialog. */
  answerPrompts(answer: ((prompt: PromptForTests) => string | undefined) | undefined): void;
  /** The window's focus as the outside-change hold sees it; undefined reads VS Code's again. */
  setWindowFocus(focused: boolean | undefined): void;
  /** Forgets where every note was left, so each opens next in a rich tab as if new. */
  forgetPlaces(): void;
  /** The view state kept for the note, which a rich tab opening on it with no other place takes. */
  keptViewState(uri: vscode.Uri): ViewState | undefined;
  statusBar(): StatusBarTestState;
  outline(): OutlineTestState;
  /** Which documents' tabs scroll together, as the title bar's buttons show it, and where each of their tabs is. */
  scrollSync(): ScrollSyncTestState;
  /** What a link's hover card would show of the note it points to, as the panel's `previewNote` request answers. */
  previewNote(from: vscode.Uri, kind: 'wikilink' | 'file', address: string): Promise<PreviewNoteResult>;
  /** The suggestions at an LF offset of an open document, as the panel's `completions` request answers. */
  completions(uri: vscode.Uri, at: number, trigger?: string): Promise<CompletionsResult>;
  /** What an embed `![[target]]` in the note `from` would show, as the panel's `embedNotes` request answers. */
  embedNote(from: vscode.Uri, target: string): Promise<EmbedNoteAnswer>;
  /**
   * What the host answers the first panel of `uri` for `message`, as it answers the page's own
   * request; an embedded note's editor names its note in `note`.
   */
  request(uri: vscode.Uri, message: FeatureRequest): Promise<unknown>;
}

/** The coordinator's state (DocumentCoordinator.inspect), with what the host knows of its document and each of its panels. */
interface CoordinatorTestState extends Omit<CoordinatorState, 'panels'> {
  dirty: boolean;
  readOnly: boolean;
  reconciled: boolean;
  panels: (CoordinatorState['panels'][number] & {
    mode?: string | undefined;
    hostLive?: boolean | undefined;
    viewState?: ViewState | undefined;
    /** What the panel last reported of the keyboard: its page, or a field in it, has focus. */
    focus?: { editor: boolean; field: boolean } | undefined;
    /** It is the active panel, whose focus the context key `tandemMarkdown.editorFocus` shows. */
    active?: boolean;
  })[];
}

const RESULT_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 20_000;

export function createTestApi(
  context: vscode.ExtensionContext,
  documents: Documents,
  provider: TandemMarkdownEditorProvider,
): { api: TandemMarkdownTestApi; disposable: vscode.Disposable } {
  const hooks = provider.testHooks;
  if (!hooks) throw new Error('The editor was not created in test mode');
  const waiting = new Map<
    string,
    { resolve(v: PanelTestResult): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  let counter = 0;
  let noticeMark = 0;
  let logMark = 0;

  const disposable = registerPanelMessageHandler('testResult', (m) => {
    const w = waiting.get(String(m.requestId));
    if (!w) return;
    waiting.delete(String(m.requestId));
    clearTimeout(w.timer);
    const result = { ...(m.result as PanelTestResult) };
    if (typeof m.error === 'string') result.error = m.error;
    w.resolve(result);
  });

  const firstPanel = (uri: vscode.Uri, column?: vscode.ViewColumn): HostPanel | undefined =>
    column === undefined
      ? panels.panelsFor(uri)[0]
      : panels.panelsFor(uri).find((p) => p.webviewPanel.viewColumn === column);

  const whenPanelLive = async (uri: vscode.Uri, timeoutMs = LIVE_TIMEOUT_MS): Promise<void> => {
    if (!(await panels.whenLive((p) => sameUri(p.uri, uri), timeoutMs)))
      throw new Error(`No panel for ${uri.path} was ready within ${timeoutMs} ms`);
  };

  const runInPanel = async (
    uri: vscode.Uri,
    actions: TestAction[],
    column?: vscode.ViewColumn,
  ): Promise<PanelTestResult> => {
    let p = firstPanel(uri, column);
    if (!p) throw new Error(`No panel shows ${uri.path}${column === undefined ? '' : ` in column ${column}`}`);
    if (!p.live && hooks.startFailures.get(uri.toString()) === undefined) {
      await whenPanelLive(uri);
      p = firstPanel(uri, column)!;
    }
    const requestId = `t${++counter}`;
    return new Promise<PanelTestResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error(`The panel did not answer the test request within ${RESULT_TIMEOUT_MS} ms`));
      }, RESULT_TIMEOUT_MS);
      waiting.set(requestId, { resolve, reject, timer });
      void p!.post({ type: 'test', requestId, actions }).then((ok) => {
        if (ok) return;
        clearTimeout(timer);
        waiting.delete(requestId);
        reject(new Error('Could not post the test request to the panel'));
      });
    });
  };

  const api: TandemMarkdownTestApi = {
    panelState: (uri, column) => runInPanel(uri, [{ type: 'state' }], column),
    runInPanel,
    holdDocument: (uri) => {
      const t = documents.get(uri);
      if (!t) throw new Error(`No coordinator for ${uri.path}`);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      void t.coordinator.runExclusive(() => held);
      return release;
    },
    flush: async (uri) => (await documents.get(uri)?.coordinator.flushPanels()) ?? false,
    coordinatorState: (uri) => {
      const t = documents.get(uri);
      if (!t) return undefined;
      const s = t.coordinator.inspect();
      return {
        ...s,
        dirty: t.document.isDirty,
        readOnly: t.readOnly,
        reconciled: t.reconciled,
        panels: s.panels.map((cp) => {
          const hp = panels.all().find((p) => p.id === cp.id);
          return {
            ...cp,
            mode: hp?.mode,
            hostLive: hp?.live,
            viewState: hp?.viewState,
            focus: hp && { ...hp.focus },
            active: !!hp && panels.activePanel() === hp,
          };
        }),
      };
    },
    whenPanelLive,
    notices: () =>
      raisedNotices()
        .slice(noticeMark)
        .map(({ notice, uri }) => ({ notice, uri })),
    logLines: () => linesAfter(logMark),
    startFailures: (uri) => hooks.startFailures.get(uri.toString()) ?? [],
    askedFor: (id) => messages.askedFor(id),
    answerNotice: (id, choice) => messages.answerNotice(id, choice),
    answerChoice: (id) => messages.answerChoice(id),
    clearRecords: () => {
      noticeMark = raisedNotices().length;
      logMark = loggedCount();
      hooks.startFailures.clear();
    },
    setPanelScript: (uri) => {
      hooks.panelScript = uri;
    },
    globalStorageUri: context.globalStorageUri,
    logUri: context.logUri,
    answerPrompts: (answer) => answerPromptsForTests(answer),
    setWindowFocus: (focused) => {
      documents.windowFocusForTests = focused;
    },
    forgetPlaces: forgetPlacesForTests,
    keptViewState: (uri) => snapshot('places').kept[uri.toString()],
    statusBar: () => snapshot('statusBar'),
    outline: () => snapshot('outline'),
    scrollSync: () => snapshot('scrollSync'),
    previewNote,
    completions: async (uri, at, trigger) => {
      const document = documents.get(uri)?.document;
      if (!document) throw new Error(`No open document ${uri.path}`);
      return suggestionsAt(document, lfTextOf(document), at, trigger);
    },
    embedNote: async (from, target) => (await embedNote(from, target)).answer,
    request: async (uri, message) => {
      const p = firstPanel(uri);
      if (!p) throw new Error(`No panel shows ${uri.path}`);
      return answerRequest(message, p);
    },
  };
  return { api, disposable };
}
