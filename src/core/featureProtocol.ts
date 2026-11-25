// The messages the panel's features and the host's features exchange, beside the document
// core's own in protocol.ts. A message sent with a `requestId` is answered with a `reply`; where
// the answer carries a value, its type is named after the message (`ResolveLinksResult` for
// `resolveLinks`). The host checks every field of a message from a panel before it uses it.

import type { TextStamp } from './hash';
import type { LogLevel, Mode } from './protocol';
import type { LinkResolution } from './wikilinks';

interface Request {
  requestId?: string;
  /**
   * For a request from an embedded note's editor, that note's path in the workspace folder of
   * the panel's note, forward slashes: the note its addresses and links are read from. Left out
   * for the panel's own note.
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Panel to host

interface ResolveLinksMessage extends Request {
  type: 'resolveLinks';
  /** Wikilink targets as written. */
  targets: string[];
}
export type ResolveLinksResult = Record<string, LinkResolution>;

interface ListLinkTargetsMessage extends Request {
  type: 'listLinkTargets';
  query: string;
}
export interface LinkTargetItem {
  /** The file's name (a markdown file's without its extension). */
  label: string;
  /** What goes between `[[` and `]]`: the shortest target that names this file alone. */
  target: string;
  /** The folder it is in, or '' at the top. */
  detail: string;
}
export type ListLinkTargetsResult = { items: LinkTargetItem[] };

export type LinkKind = 'web' | 'file' | 'anchor' | 'wikilink';

interface OpenLinkMessage extends Request {
  type: 'openLink';
  kind: LinkKind;
  href: string;
  /** The view the link was followed from; a markdown file opens in the same one. */
  mode: Mode;
}

/** Search the workspace's markdown files for a tag (`#name`), in VS Code's search view. */
interface SearchTagMessage extends Request {
  type: 'searchTag';
  /** The tag without its `#`. */
  tag: string;
}

export interface PreviewNoteMessage extends Request {
  type: 'previewNote';
  kind: 'wikilink' | 'file';
  /** The wikilink's target, or the link's address as written. */
  path: string;
}
export interface NotePreview {
  title: string;
  /**
   * The first NOTE_PREVIEW_CHARS characters after the front matter (and after the title, when the
   * note starts with it).
   */
  text: string;
  /** Workspace-relative, forward slashes. */
  path: string;
}
/** Null when there is no note to show, or it may not be shown. */
export type PreviewNoteResult = NotePreview | null;

interface EmbedNotesMessage extends Request {
  type: 'embedNotes';
  /** Embeds' targets as written between `![[` and `]]`, a heading or a block id included. */
  targets: string[];
}
/** What an embed shows: the part of the note it names, or why there is nothing to show, in a sentence. */
export type EmbedNoteAnswer = { path: string; title: string; text: string } | { reason: string };
export type EmbedNotesResult = Record<string, EmbedNoteAnswer>;

interface ResolveImagesMessage extends Request {
  type: 'resolveImages';
  /** Image addresses as written. */
  sources: string[];
}
/** An address the page may load, or why the image is not shown. */
export type ImageAnswer = { uri: string } | { reason: string };
export type ResolveImagesResult = Record<string, ImageAnswer>;

interface PickImageMessage extends Request {
  type: 'pickImage';
}
/** Null when no image is to be inserted (the dialog was closed, or the file was refused). */
export type PickImageResult = { markdownPath: string } | null;

interface SaveImageMessage extends Request {
  type: 'saveImage';
  name: string;
  mime: string;
  dataBase64: string;
}
/** The saved file's path relative to the note, forward slashes. */
export type SaveImageResult = { markdownPath: string };

// VS Code's language features at a place in the panel's text. Offsets are in the text whose
// stamp is `expect`; the host first has the panel send what is unsent, and answers `stale` when
// the document's text is not that text then.

interface AtText extends Request {
  /** Stamp of the panel's whole text when it asked. */
  expect: TextStamp;
}
/** The document is no longer the text the panel asked about. */
interface Stale {
  stale: true;
}
/** Nothing was done, and why, in a sentence for the user. */
interface Refused {
  refused: string;
}

interface PrepareRenameMessage extends AtText {
  type: 'prepareRename';
  at: number;
}
/** What a rename at `at` would rename: the range and the text the rename box starts with. */
export type PrepareRenameResult = { from: number; to: number; placeholder: string } | Refused | Stale;

interface RenameMessage extends AtText {
  type: 'rename';
  at: number;
  newName: string;
}
/** The rename's edit was applied by VS Code: the panel sees it as an ordinary change. */
export type RenameResult = { done: true } | Refused | Stale;

interface CompletionsMessage extends AtText {
  type: 'completions';
  at: number;
  /** The character just typed, when it is one VS Code's markdown suggestions start on. */
  trigger?: string;
}
export interface SuggestionItem {
  /** What the list shows. */
  label: string;
  /** What typing is matched against. */
  filter: string;
  detail: string;
  /** Replaces from the start of the result's range to the cursor. */
  insert: string;
  /** Where the cursor goes, as an offset into `insert`. */
  cursor: number;
  /** Suggestions are asked for again after this one is chosen (a folder). */
  again: boolean;
}
/** `from` is where the suggestions' text starts; every item replaces from there to the cursor. */
export type CompletionsResult = { from: number; items: SuggestionItem[] } | Stale;

interface CodeActionsMessage extends AtText {
  type: 'codeActions';
  from: number;
  to: number;
}
export interface FixItem {
  /** Names the fix to `applyCodeAction`, until the next `codeActions` from this panel. */
  id: string;
  title: string;
  /** The provider marks this fix as the one to take. */
  preferred: boolean;
}
export type CodeActionsResult = { fixes: FixItem[] } | Stale;

interface ApplyCodeActionMessage extends Request {
  type: 'applyCodeAction';
  id: string;
}
export type ApplyCodeActionResult = { done: true } | Refused;

/**
 * Asks whether this tab tells a screen reader of the changes from outside up to `upTo`, its
 * synced version: a note open in two rich tabs is told once, by the one the user is in.
 */
interface TellOutsideMessage extends Request {
  type: 'tellOutside';
  upTo: number;
}
/** The answer to `tellOutside`: tell what came after version `after`; null when another tab of the note tells it. */
export type TellOutsideResult = { after: number } | null;

/** The panel's text as Verify File compares it. */
export interface PanelStamp {
  /** False when something was still unconfirmed when the panel answered. */
  clean: boolean;
  /** The host's log version the panel is synced to; -1 when it has no editor. */
  version: number;
  length: number;
  hash: string;
  text?: string;
}
export interface StampMessage extends PanelStamp {
  type: 'stamp';
  id: string;
}

export interface PanelTestState {
  text: string;
  version: number;
  /** How many local updates the host has not confirmed yet. */
  unconfirmed: number;
  mode: Mode;
  selection: { anchor: number; head: number };
  lineCount: number;
  /** The class attribute of every drawn widget, in document order. */
  widgets: string[];
  /** Content-policy violations seen by the page, as "directive: blocked address". */
  cspViolations: string[];
  /** The lines (one-based) that carry the outside-change mark. */
  outsideMarked: number[];
  /** What the editor's live region was given for a screen reader to speak, in order, since the hook first answered. */
  announced: string[];
  /** Tab and Shift+Tab move focus instead of indenting (Tab Moves Focus). */
  tabMovesFocus: boolean;
  /** The problems the panel holds, where they now stand in its text. */
  diagnostics: { from: number; to: number; severity: DiagnosticSeverity; message: string }[];
  /** The lines (one-based) marked as differing from the last commit, with their kind. */
  changeMarks: { line: number; kind: ChangeMark['kind'] }[];
  /** The message the strip shows: its words and the names of its buttons, in order; null for none. */
  messageStrip: { text: string; buttons: string[] } | null;
}
export interface FailurePageTestState {
  failurePage: true;
  text: string;
  cspViolations: string[];
}
export interface TestResultMessage {
  type: 'testResult';
  requestId: string;
  result: PanelTestState | FailurePageTestState;
  /** What an action threw; the actions after it did not run. */
  error?: string;
}

interface ShowSourceMessage {
  type: 'showSource';
}

interface SwitchViewMessage {
  type: 'switchView';
  to: 'source' | Mode;
}

/** The panel asks to be built again from the document. */
interface ReloadViewMessage {
  type: 'reloadView';
}

/** The page could not start; it shows its failure page. */
interface StartFailedMessage {
  type: 'startFailed';
  detail: string;
}

interface ShowLogMessage {
  type: 'showLog';
}

/** Opens VS Code's Settings at a setting id (such as `tandemMarkdown.maxRichFileSizeKb`). */
interface OpenSettingMessage {
  type: 'openSetting';
  id: string;
}

/**
 * Scroll sync: the user moved the view, which the document's other visible tabs follow. Sent only
 * while the host has linked the view (`scrollLink`).
 */
interface ScrolledMessage {
  type: 'scrolled';
  /** The place at the view's top: a zero-based line plus the share of it above the top. */
  line: number;
}

/** Opens VS Code's merge editor for the note, which git lists as in conflict (`gitConflict`). */
interface OpenMergeEditorMessage {
  type: 'openMergeEditor';
}

/** A button of the message the strip shows was pressed: `message` is its id, `button` what the button does. */
interface MessagePressedMessage {
  type: 'messagePressed';
  message: string;
  button: string;
}

interface LogMessage {
  type: 'log';
  level: LogLevel;
  message: string;
  detail?: unknown;
}

export type FeatureRequest =
  | ResolveLinksMessage
  | ListLinkTargetsMessage
  | OpenLinkMessage
  | SearchTagMessage
  | PreviewNoteMessage
  | EmbedNotesMessage
  | ResolveImagesMessage
  | PickImageMessage
  | SaveImageMessage
  | PrepareRenameMessage
  | RenameMessage
  | CompletionsMessage
  | CodeActionsMessage
  | ApplyCodeActionMessage
  | TellOutsideMessage;

export type PanelFeatureMessage =
  | FeatureRequest
  | StampMessage
  | TestResultMessage
  | ShowSourceMessage
  | SwitchViewMessage
  | ReloadViewMessage
  | StartFailedMessage
  | ShowLogMessage
  | OpenSettingMessage
  | ScrolledMessage
  | OpenMergeEditorMessage
  | MessagePressedMessage
  | LogMessage;

// ---------------------------------------------------------------------------
// Host to panel

/** Files were added, removed or renamed: links and images are resolved again. */
interface LinksChangedMessage {
  type: 'linksChanged';
}

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

/** One problem VS Code knows of in the document (from a linter, a spell checker, the markdown link check). */
export interface DiagnosticItem {
  from: number;
  to: number;
  severity: DiagnosticSeverity;
  message: string;
  /** The tool that reported it, or ''. */
  source: string;
  /** Its rule or code, or ''. */
  code: string;
  /** Reported as unused or unnecessary: faded rather than underlined. */
  unnecessary: boolean;
  /** Reported as deprecated: struck through. */
  deprecated: boolean;
}

/**
 * Every problem in the document, replacing those sent before. Offsets are in the host's text at
 * log `version`; the panel carries them over the changes it has seen since.
 */
export interface DiagnosticsMessage {
  type: 'diagnostics';
  version: number;
  items: DiagnosticItem[];
}

/**
 * Lines that differ from the file's last commit. `from` is the start of the first line and `to`
 * the end of the last; for removed lines both are where they were, the start of the line after
 * them (or the end of the text).
 */
export interface ChangeMark {
  kind: 'added' | 'changed' | 'removed';
  from: number;
  to: number;
  /** Committed lines replaced or removed by this hunk (omitted for added lines or oversized hunks). */
  original?: string;
  /** True for a `removed` hunk deleted strictly after the document's last remaining line. */
  afterEnd?: boolean;
}

/** Every change mark, replacing those sent before; offsets as in `DiagnosticsMessage`. */
export interface ChangeMarksMessage {
  type: 'changeMarks';
  version: number;
  marks: ChangeMark[];
}

/** A note the panel embeds changed, in its file or in VS Code: embeds are read again. */
interface EmbedsChangedMessage {
  type: 'embedsChanged';
}

/** Verify File asks for the panel's stamp, after the panel has sent what is unsent. */
export interface StampRequestMessage {
  type: 'stampRequest';
  id: string;
  withText: boolean;
}

/**
 * Scroll sync: the view's document is linked and visible in another tab (`linked: true`), so the
 * view reports the user's scrolling with `scrolled`; or it no longer is, and it reports nothing.
 */
interface ScrollLinkMessage {
  type: 'scrollLink';
  linked: boolean;
}

/** Show this place at the view's top: a zero-based line plus the share of it above the top. */
interface ScrollToMessage {
  type: 'scrollTo';
  line: number;
}

/**
 * Whether git lists the note as in conflict (a merge, a rebase or a cherry-pick stopped on it).
 * A panel starts each init taking it as not; the host sends it when that changes.
 */
interface GitConflictMessage {
  type: 'gitConflict';
  conflicted: boolean;
}

/** A message that asks the user something, as the strip at the top of the tab shows it. */
export interface StripMessage {
  id: string;
  text: string;
  /** Its buttons in order, the first the main one; a press names one by `does`. */
  buttons: { does: string; label: string }[];
  /** It popped up as well, where a screen reader heard it: the strip does not say it again. */
  popped: boolean;
  /** What the strip says after its buttons while other messages of the note wait behind it; null for none. */
  more: string | null;
}

/** The message the strip shows, null for none; with `focus`, the keyboard goes to it. */
interface MessagesMessage {
  type: 'messages';
  shown: StripMessage | null;
  focus?: true;
}

export type TestAction =
  | { type: 'insert'; at: number; text: string; userEvent?: string }
  | { type: 'replace'; from: number; to: number; text: string }
  | { type: 'select'; anchor: number; head: number }
  | { type: 'command'; id: string; args?: unknown }
  | { type: 'setMode'; mode: Mode }
  | { type: 'flush' }
  | { type: 'state' }
  /**
   * Puts `text` into the panel at `at` without telling the host, as a fault would (the Verify
   * File test). The next update from the host finds it by its checksum and reloads the view.
   */
  | { type: 'corrupt'; at: number; text: string }
  /** Only the failure page has this button; on a working panel the action is an error. */
  | { type: 'click'; target: 'showSource' }
  /** Presses the button named `label` of the message the strip shows, as a click does. */
  | { type: 'pressMessage'; label: string };

/** Sent only to a panel of an extension running its tests. */
export interface TestMessage {
  type: 'test';
  requestId: string;
  actions: TestAction[];
}

/** Whether the note holds unsaved changes (VS Code's own flag): sent once a panel is live, and when it flips. */
interface UnsavedChangesMessage {
  type: 'unsavedChanges';
  held: boolean;
}

/**
 * What one of the core's notices about a change from outside does: a message speaks for the
 * latest change from outside at or before `version`, the host's log version when the notice came
 * (`message`); or it has no message, and its warning in the Problems list is being written
 * (`coming`, with `version`), is shown (`warning`), or was not written (`none`).
 */
export interface OutsideNoticeMessage {
  type: 'outsideNotice';
  /** The notice's id, which names it in the messages that follow. */
  notice: string;
  tells: 'message' | 'coming' | 'warning' | 'none';
  version?: number;
}

/** Another rich tab of the note has told a screen reader of the changes from outside up to version `upTo`. */
interface OutsideToldMessage {
  type: 'outsideTold';
  upTo: number;
}

export type HostFeatureMessage =
  | UnsavedChangesMessage
  | OutsideNoticeMessage
  | OutsideToldMessage
  | LinksChangedMessage
  | EmbedsChangedMessage
  | StampRequestMessage
  | TestMessage
  | DiagnosticsMessage
  | ChangeMarksMessage
  | ScrollLinkMessage
  | ScrollToMessage
  | GitConflictMessage
  | MessagesMessage;
