// Verify File (`tandemMarkdown.verify`): compares the text of the rich tab the user is in with
// your text (VS Code's document) and, when nothing is unsaved, your text with the file on disk,
// and says in one message whether they agree. When something differs it says only what
// differs, and offers "Compare versions", which opens each text that differs, held in memory
// as it was compared, beside your text; and when the tab is the one that differs, "Reload
// tab", which builds the tab again from your text. The command returns what it showed.
//
// A tab is compared by the stamp of its text, at the host's own log version, so a change
// still on its way to it is not taken for a disagreement; its text is asked for only when the
// stamps differ. The file is decoded as the core decodes it and compared as LF text.

import * as vscode from 'vscode';
import { decodeBytes } from '../core/encoding';
import { toLf } from '../core/eol';
import { errorMessage } from '../core/errors';
import type { PanelStamp } from '../core/featureProtocol';
import { sameStamp, stampOf } from '../core/hash';
import { plainNotice } from '../core/noticeText';
import { FLUSH_MS } from '../core/protocol';
import { registerCommand } from './commandRegistration';
import type { Documents } from './documents';
import type { HostFeature } from './features';
import { HeldTexts } from './heldTexts';
import { log } from './log';
import { documentText } from './model/documentText';
import { compareTexts, VERIFY_WORDS, verifyMessage, type Compared, type FileSkipped } from './model/verifyText';
import { registerPanelMessageHandler } from './panelMessages';
import type { HostPanel } from './panels';
import { NOT_RUN } from './strings';
import { currentTab, panelOfTab, tabUri } from './tabs';
import { encodingOf, fileNameOf, sameUri } from './uris';

const CATCHING_UP = 'This tab is still updating. Run Verify File again in a moment.';
const NOT_STARTED = "This tab hasn't finished opening. Run Verify File again in a moment.";
const NO_FILE = 'Open a markdown file, then run Verify File.';
const COMPARE = 'Compare versions';
const RELOAD = VERIFY_WORDS.reloadTab;

/** How long the panel has to answer: its own flush (up to FLUSH_MS), then the stamp. */
const STAMP_WAIT_MS = FLUSH_MS + 3500;
/** How often to look again when the panel is not yet at the host's version. */
const CATCH_UP_TRIES = 5;
const CATCH_UP_PAUSE_MS = 200;
/** A file that differs is read again after this long, in case VS Code was about to load it. */
const FILE_SECOND_LOOK_MS = 500;

/** What Verify File showed, which it resolves with (docs/ARCHITECTURE.md, "The test hook"). */
export interface VerifyResult {
  /** Everything that was compared agreed (a comparison that could not be made is not a disagreement). */
  agree: boolean;
  message: string;
  buttons: string[];
  /** The texts "Compare versions" opens beside your text: the tab's and the file's, where they differ. */
  compared: { tab?: string; file?: string };
}

/** A comparison made, with the other side's text when it differs from your text. */
interface Comparison<C> {
  compared: C;
  text: string | null;
}

type AskStamp = (panel: HostPanel, withText: boolean) => Promise<PanelStamp | null>;

function readStamp(m: { [key: string]: unknown }): PanelStamp | null {
  if (
    typeof m.clean !== 'boolean' ||
    typeof m.version !== 'number' ||
    typeof m.length !== 'number' ||
    typeof m.hash !== 'string'
  )
    return null;
  const out: PanelStamp = { clean: m.clean, version: m.version, length: m.length, hash: m.hash };
  if (typeof m.text === 'string') out.text = m.text;
  return out;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const verify: HostFeature = (_context, documents) => {
  const waiting = new Map<string, (stamp: PanelStamp | null) => void>();
  const held = new HeldTexts();
  let seq = 0;

  const askStamp: AskStamp = (panel, withText) => {
    const id = `verify${++seq}`;
    return new Promise((resolve) => {
      const done = (stamp: PanelStamp | null) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(stamp);
      };
      const timer = setTimeout(() => done(null), STAMP_WAIT_MS);
      waiting.set(id, done);
      void Promise.resolve(panel.post({ type: 'stampRequest', id, withText })).then((ok) => {
        if (!ok) done(null);
      });
    });
  };

  return vscode.Disposable.from(
    held,
    registerPanelMessageHandler('stamp', (m) => {
      waiting.get(String(m.id))?.(readStamp(m));
    }),
    registerCommand('verify', async (): Promise<VerifyResult> => {
      try {
        return await verifyActive(documents, askStamp, held);
      } catch (error) {
        log('error', 'Verify File failed', error);
        const message = `Verify File could not finish: ${errorMessage(error)}`;
        void vscode.window.showErrorMessage(plainNotice(message));
        return { agree: false, message, buttons: [], compared: {} };
      }
    }),
  );
};

/** A message that compares nothing, or says everything compared agrees. */
function said(message: string, agree: boolean): VerifyResult {
  void vscode.window.showInformationMessage(plainNotice(message));
  return { agree, message, buttons: [], compared: {} };
}

async function verifyActive(documents: Documents, askStamp: AskStamp, held: HeldTexts): Promise<VerifyResult> {
  const tab = currentTab();
  const uri = tabUri(tab);
  if (!tab || !uri) return said(NO_FILE, false);
  const panel = panelOfTab(tab);
  const document =
    vscode.workspace.textDocuments.find((d) => !d.isClosed && sameUri(d.uri, uri)) ??
    (await vscode.workspace.openTextDocument(uri));

  let tabSide: Comparison<Compared> | null = null;
  if (panel) {
    const compared = await comparePanel(documents, panel, document, askStamp);
    if (typeof compared === 'string') return said(compared, false);
    tabSide = compared;
  }
  const fileSide = await compareFile(document);
  const name = fileNameOf(uri);
  const shown = verifyMessage({ name, tab: tabSide?.compared ?? null, file: fileSide.compared });

  const where = uri.fsPath || uri.toString();
  const sizes = [
    tabSide?.compared.kind === 'differ' ? `the tab by ${tabSide.compared.characters} characters` : '',
    typeof fileSide.compared === 'object' && fileSide.compared.kind === 'differ'
      ? `the file by ${fileSide.compared.characters} characters`
      : '',
  ].filter(Boolean);
  log(
    shown.agree ? 'info' : 'warn',
    `Verify File: ${shown.text}${sizes.length ? ` (${sizes.join(', ')})` : ''} ${where}`,
  );
  if (shown.agree) return said(shown.text, true);

  const compared: VerifyResult['compared'] = {};
  if (shown.tabDiffers && tabSide && tabSide.text !== null) compared.tab = tabSide.text;
  if (shown.fileDiffers && fileSide.text !== null) compared.file = fileSide.text;
  const buttons = shown.tabDiffers ? [COMPARE, RELOAD] : [COMPARE];
  void vscode.window.showWarningMessage(plainNotice(shown.text), ...buttons).then((choice) => {
    if (choice === COMPARE) void compareVersions(held, document, compared);
    else if (choice === RELOAD && panel && !panel.disposed) panel.reload();
  });
  return { agree: false, message: shown.text, buttons, compared };
}

/** Opens each text that differs, read-only on the left, beside your text on the right. */
async function compareVersions(
  held: HeldTexts,
  document: vscode.TextDocument,
  compared: VerifyResult['compared'],
): Promise<void> {
  const name = fileNameOf(document.uri);
  const sides: [string | undefined, string][] = [
    [compared.tab, 'this tab'],
    [compared.file, 'file on disk'],
  ];
  for (const [text, what] of sides) {
    if (text === undefined) continue;
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        held.hold(name, text),
        document.uri,
        `${name}: ${what} ↔ your text`,
        { preview: false },
      );
    } catch (error) {
      log('error', `Verify File could not open the comparison of ${what} with your text`, error);
    }
  }
}

/**
 * The tab's text against your text. A string is the message to show instead, when the tab
 * cannot be compared now (it has not opened, it has unsent typing, or it is catching up).
 */
async function comparePanel(
  documents: Documents,
  panel: HostPanel,
  document: vscode.TextDocument,
  askStamp: AskStamp,
): Promise<Comparison<Compared> | string> {
  if (!panel.live) return NOT_STARTED;
  const tracked = documents.get(panel.uri);
  for (let attempt = 1; ; attempt++) {
    const flushed = tracked ? await tracked.coordinator.flushPanels([panel.id]) : true;
    const stamp = flushed ? await askStamp(panel, false) : null;
    if (!stamp || !stamp.clean) return NOT_RUN.verify;
    const hostVersion = tracked?.coordinator.inspect().version;
    if (hostVersion !== undefined && stamp.version !== hostVersion) {
      if (attempt >= CATCH_UP_TRIES) return CATCHING_UP;
      await pause(CATCH_UP_PAUSE_MS);
      continue;
    }
    if (sameStamp(stamp, stampOf(toLf(documentText(document))))) return { compared: { kind: 'same' }, text: null };
    // The stamps differ: the tab's text, to measure the difference and to compare it.
    const full = await askStamp(panel, true);
    if (!full || !full.clean || full.text === undefined) return NOT_RUN.verify;
    const compared = compareTexts(full.text, toLf(documentText(document)));
    return { compared, text: compared.kind === 'differ' ? full.text : null };
  }
}

/** Your text against the file on disk, or why the file was not compared. */
async function compareFile(document: vscode.TextDocument): Promise<Comparison<Compared | FileSkipped>> {
  if (document.isDirty) return { compared: 'unsaved', text: null };
  if (document.uri.scheme === 'untitled') return { compared: 'noFile', text: null };
  let read = await readFileLf(document);
  let documentLf = toLf(documentText(document));
  if (typeof read === 'string' && read !== documentLf) {
    await pause(FILE_SECOND_LOOK_MS);
    read = await readFileLf(document);
    documentLf = toLf(documentText(document));
  }
  if (document.isDirty) return { compared: 'unsaved', text: null };
  if (typeof read !== 'string') return { compared: read.skipped, text: null };
  const compared = compareTexts(documentLf, read);
  return { compared, text: compared.kind === 'differ' ? read : null };
}

/** The file's text as LF, decoded as the core decodes it, or why it could not be had. */
async function readFileLf(document: vscode.TextDocument): Promise<string | { skipped: FileSkipped }> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(document.uri);
  } catch (error) {
    log('warn', `Verify File could not read ${document.uri.fsPath || document.uri.toString()}`, error);
    return { skipped: 'unreadable' };
  }
  const text = decodeBytes(bytes, encodingOf(document));
  return text === null ? { skipped: 'encoding' } : toLf(text);
}
