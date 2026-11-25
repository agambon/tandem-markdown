// Use Tandem Markdown by Default (`tandemMarkdown.useByDefault`) and Use Source by Default
// (`tandemMarkdown.useSourceByDefault`), the only place the extension writes a setting, and only
// when the user runs one and confirms it. They change the `*.md` and `*.markdown` entries of the
// user-level `workbench.editorAssociations`, which says what opens a file, and Use Tandem
// Markdown by Default those of `workbench.diffEditorAssociations` too, which says what opens a
// comparison, so that comparisons never fall to this extension's editor; an entry that already
// gives what was asked, an installed editor chosen for comparisons, and every other entry, stay
// as they are. Where each kind of markdown file opens now is named in the question, with how to
// go back. An entry they do not write that still decides, the workspace's or one with a longer
// pattern (model/editorAssociations.ts), is named before and after the change, and never
// changed. The rich view the questions and answers name is the one Default Rich Mode opens first.

import * as vscode from 'vscode';
import { isMarkdownPath, MARKDOWN_EXTENSIONS } from '../core/fileKinds';
import { plainNotice } from '../core/noticeText';
import { RICH_VIEW_NAME } from '../core/protocol';
import { registerCommand } from './commandRegistration';
import type { HostFeature } from './features';
import { log } from './log';
import {
  afterWriting,
  alreadySet,
  alreadyThere,
  DONT_CHANGE,
  fromNowOn,
  namedEditor,
  notAnObject,
  OPEN_USER_SETTINGS,
  OPEN_WORKSPACE_SETTINGS,
  question,
  SETTING_KEYS,
  settingsToOpen,
  type Comparisons,
  type NamedEditor,
  type Now,
  type RichView,
  type SourceHeld,
  type Target,
  type Winner,
} from './model/defaultsWords';
import {
  associationFor,
  comparisonEntry,
  comparisonsFollowOpening,
  editorDisplayName,
  editorsOpeningByThemselves,
  matchesEvery,
  patternOutranked,
  patternsOf,
  registeredEditors,
  type AssociationLevels,
} from './model/editorAssociations';
import { TEXT_EDITOR, VIEW_TYPE } from './model/editorIds';
import { globToRegExp, MARKDOWN_PATTERNS, patternOf } from './model/glob';
import { askModal } from './questions';
import { defaultRichMode } from './settings';
import { currentTab, tabUri } from './tabs';
import { fileNameOf } from './uris';

const OPENING = SETTING_KEYS.opening;
const COMPARING = SETTING_KEYS.comparing;
/** A note's name with nothing particular to it, before its extension (plainNotes). */
const PLAIN_NOTE = 'note';
/** The settings file of a workspace opened as a folder, from the folder. */
const FOLDER_SETTINGS_FILE = '.vscode/settings.json';

/** A modal question with one button besides Don't change. True when that button was chosen. */
async function confirm(message: string, detail: string, button: string): Promise<boolean> {
  return (await askModal(message, detail, [button], DONT_CHANGE)) === button;
}

// ---------------------------------------------------------------------------
// The answers

/** The rich view markdown files open in: the one Default Rich Mode opens first. */
function richView(): RichView {
  const mode = defaultRichMode();
  return { name: RICH_VIEW_NAME[mode], readOnly: mode === 'view' };
}

/** A button that opens a settings file at a setting. */
interface SettingsButton {
  title: string;
  command: string;
}
const USER_SETTINGS_BUTTON: SettingsButton = {
  title: OPEN_USER_SETTINGS,
  command: 'workbench.action.openSettingsJson',
};
const WORKSPACE_SETTINGS_BUTTON: SettingsButton = {
  title: OPEN_WORKSPACE_SETTINGS,
  command: 'workbench.action.openWorkspaceSettingsFile',
};

/** Shows the answer, with the button that opens the settings at `key` when it has one. */
function tell(message: string, button?: SettingsButton, key = OPENING): void {
  const text = plainNotice(message);
  if (!button) {
    void vscode.window.showInformationMessage(text);
    return;
  }
  void vscode.window.showInformationMessage(text, button.title).then((choice) => {
    if (choice !== button.title) return;
    Promise.resolve(vscode.commands.executeCommand(button.command, { revealSetting: { key } })).catch(
      (error: unknown) => log('error', `Could not open the settings for ${key}`, error),
    );
  });
}

// ---------------------------------------------------------------------------
// The plan: what the markdown entries of each setting become

interface Plan {
  key: string;
  /** The whole setting after the change; undefined removes it from the user settings. */
  next: Record<string, unknown> | undefined;
  /** The user's entries for the markdown patterns before the change. */
  was: Record<string, unknown>;
  /** The markdown patterns whose entries the change writes or takes out. */
  changed: string[];
  /** The markdown patterns it leaves since they already give what was asked: not those a longer entry outranks. */
  kept: string[];
  /** False when the setting already says what was asked. */
  changes: boolean;
}

/** What the entry for `pattern` becomes from its value now; undefined deletes it. */
interface EntryRule {
  next(now: unknown, pattern: string): unknown;
}

/**
 * `workbench.editorAssociations`. Use Source by Default keeps an entry that names VS Code's text
 * editor and deletes the others, so VS Code's own choice applies: its text editor, since this
 * extension's editor is only an option. Where another editor would then open files of the
 * entry's pattern, by itself or by another extension's default settings (`claimed`), the entry is
 * set to VS Code's text editor instead.
 */
function openingRule(target: Target, claimed: ReadonlySet<string>): EntryRule {
  if (target === 'rich') return { next: () => VIEW_TYPE };
  return { next: (now, pattern) => (now === TEXT_EDITOR || claimed.has(pattern) ? TEXT_EDITOR : undefined) };
}

/**
 * `workbench.diffEditorAssociations`, which only Use Tandem Markdown by Default changes, so that
 * comparisons never fall to this extension's editor: with no entry, VS Code 1.120 to 1.128 shows
 * both sides of a comparison in the editor `workbench.editorAssociations` names, and later
 * versions keep the text comparison for an editor whose priority is a string. Each entry becomes
 * what `comparisonEntry` gives: the user's own where it names an installed editor; on 1.120 to
 * 1.128 another extension's editor that opens the pattern's files now (`openers`), where they
 * show comparisons now; else the text comparison. Where the pattern's files open in different
 * editors in different workspace folders, no one entry keeps every comparison where it is, and
 * they take the text comparison. Use Source by Default leaves the setting as it is.
 */
function comparingRule(registered: ReadonlySet<string>, openers: ReadonlyMap<string, readonly string[]>): EntryRule {
  return {
    next: (now, pattern) => {
      const opens = openers.get(pattern) ?? [];
      const opener = opens.length === 1 ? opens[0]! : TEXT_EDITOR;
      return comparisonEntry(now, opener, (v) => registered.has(v), vscode.version);
    },
  };
}

/**
 * A plain note of the markdown kind `extension` at the top of each workspace folder, or at the
 * root with no folder open: what the commands read the settings by. Both settings are the
 * window's, but a pattern with a `/` matches some folders' files and not others'.
 */
function plainNotes(extension: string): vscode.Uri[] {
  const name = `${PLAIN_NOTE}.${extension}`;
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 0 ? folders.map((f) => vscode.Uri.joinPath(f.uri, name)) : [vscode.Uri.file(`/${name}`)];
}

/**
 * For each markdown pattern, the editors its files open in before the change, one for each that
 * the plain notes (plainNotes) open in: by the user's settings and the defaults, as VS Code takes
 * them for the note, else one that `claiming` says opens them by itself, else VS Code's text editor.
 */
function openersNow(claiming: ReadonlyMap<string, string[]>): Map<string, string[]> {
  const inspected = vscode.workspace.getConfiguration().inspect(OPENING);
  const levels: AssociationLevels = { user: inspected?.globalValue, default: inspected?.defaultValue };
  const editors = registeredEditors(manifests());
  const openers = new Map<string, string[]>();
  for (const extension of MARKDOWN_EXTENSIONS) {
    const pattern = patternOf(extension);
    const opens = plainNotes(extension).map(
      (note) =>
        associationFor(levels, { scheme: note.scheme, path: note.path }, (v) => editors.has(v))?.viewType ??
        claiming.get(pattern)?.[0] ??
        TEXT_EDITOR,
    );
    openers.set(pattern, [...new Set(opens)]);
  }
  return openers;
}

/**
 * What the setting at `key` becomes. Null when its user-level value is not an object of patterns
 * (an old list form, or something else), which is left alone. The entry for a pattern that a
 * longer entry outranks for every file (`patternOutranked`) is left as it is: VS Code never uses it.
 */
function plan(key: string, rule: EntryRule): Plan | null {
  const inspected = vscode.workspace.getConfiguration().inspect(key);
  const current = inspected?.globalValue;
  const patterns = current === undefined ? {} : patternsOf(current);
  if (patterns === null) return null;
  const editors = registeredEditors(manifests());
  const levels = { user: current, default: inspected?.defaultValue };
  const before = { ...patterns };
  const next: Record<string, unknown> = { ...before };
  const outranked: string[] = [];
  for (const pattern of MARKDOWN_PATTERNS) {
    if (patternOutranked(levels, pattern, (viewType) => editors.has(viewType))) {
      outranked.push(pattern);
      continue;
    }
    const after = rule.next(before[pattern], pattern);
    if (after === undefined) delete next[pattern];
    else next[pattern] = after;
  }
  const changed = MARKDOWN_PATTERNS.filter((p) => before[p] !== next[p]);
  const kept = MARKDOWN_PATTERNS.filter((p) => !changed.includes(p) && !outranked.includes(p));
  const was = Object.fromEntries(MARKDOWN_PATTERNS.map((p) => [p, before[p]]));
  return {
    key,
    next: Object.keys(next).length > 0 ? next : undefined,
    was,
    changed,
    kept,
    changes: changed.length > 0,
  };
}

/**
 * The plans of the settings a command changes: where comparisons open, for Use Tandem Markdown by
 * Default only, with the editors each pattern's files open in before the change (`openersNow`).
 */
interface Plans {
  opening: Plan;
  comparing?: Plan;
  openers?: Map<string, string[]>;
}

/** The plans of the settings `target` changes, or the key of the first that cannot be changed. */
function planFor(target: Target, claiming: ReadonlyMap<string, string[]>): Plans | { unchangeable: string } {
  const claimed = target === 'source' ? new Set(claiming.keys()) : new Set<string>();
  const opening = plan(OPENING, openingRule(target, claimed));
  if (!opening) return { unchangeable: OPENING };
  if (target === 'source') return { opening };
  const openers = openersNow(claiming);
  const comparing = plan(COMPARING, comparingRule(registeredEditors(manifests()), openers));
  if (!comparing) return { unchangeable: COMPARING };
  return { opening, comparing, openers };
}

/** True when a plan changes either setting. */
function changesAny(plans: Plans): boolean {
  return plans.opening.changes || plans.comparing?.changes === true;
}

// ---------------------------------------------------------------------------
// Other editors

/** Every installed extension's manifest. */
function manifests(): unknown[] {
  return vscode.extensions.all.map((e) => e.packageJSON as unknown);
}

/** An editor's view type as the words name it: Source and this extension's own by their kind, another by the name it shows. */
function describeEditor(viewType: string): NamedEditor {
  if (viewType === TEXT_EDITOR) return { kind: 'source', name: '', label: '' };
  if (viewType === VIEW_TYPE) return { kind: 'rich', name: '', label: '' };
  const name = editorDisplayName(manifests(), viewType);
  return { kind: 'other', name: name ? namedEditor(name, viewType) : viewType, label: name ?? viewType };
}

/**
 * For each markdown pattern (`*.md`) whose files would open somewhere other than VS Code's text
 * editor if the user's settings had no entry for it, the editors they would open in: the one
 * another extension's default settings give the pattern, where it is installed, and those that,
 * among the notes the check reads by, would open them by themselves.
 */
function claimants(): Map<string, string[]> {
  const packages = manifests();
  const editors = registeredEditors(packages);
  const defaults = patternsOf(vscode.workspace.getConfiguration().inspect(OPENING)?.defaultValue) ?? {};
  const claiming = new Map<string, string[]>();
  for (const extension of MARKDOWN_EXTENSIONS) {
    const pattern = patternOf(extension);
    const given = defaults[pattern];
    const found = new Set<string>();
    if (typeof given === 'string' && given !== TEXT_EDITOR && editors.has(given)) found.add(given);
    for (const note of notesToCheck(extension).filter((n) => globToRegExp(pattern).test(fileNameOf(n))))
      for (const viewType of editorsOpeningByThemselves(
        packages,
        { scheme: note.scheme, path: note.path },
        vscode.version,
      ))
        if (viewType !== VIEW_TYPE) found.add(viewType);
    if (found.size > 0) claiming.set(pattern, [...found]);
  }
  return claiming;
}

// ---------------------------------------------------------------------------
// Entries the commands do not write

/** The name of the extension whose defaults give the setting `key` an entry for `pattern`, when one does. */
function defaultFrom(key: string, pattern: string): string | undefined {
  for (const extension of vscode.extensions.all) {
    const json = extension.packageJSON as
      { displayName?: unknown; contributes?: { configurationDefaults?: Record<string, unknown> } } | undefined;
    const patterns = patternsOf(json?.contributes?.configurationDefaults?.[key]);
    if (!patterns || !(pattern in patterns)) continue;
    const name = json?.displayName;
    // A built-in extension's display name is a key into its translations, such as "%displayName%".
    return typeof name === 'string' && !name.startsWith('%') ? name : extension.id;
  }
  return undefined;
}

/** The open workspace's settings file, as the words name it; null for an untitled workspace, whose settings have no file. */
function workspaceFile(): string | null {
  const file = vscode.workspace.workspaceFile;
  if (!file) return FOLDER_SETTINGS_FILE;
  return file.scheme === 'untitled' ? null : fileNameOf(file);
}

/**
 * The notes the check reads by: the plain notes with the markdown extension `extension`
 * (plainNotes), then the markdown note in the active tab, whichever editor shows it.
 */
function notesToCheck(extension = 'md'): vscode.Uri[] {
  const active = activeFile();
  return active && isMarkdownPath(active.path) ? [...plainNotes(extension), active] : plainNotes(extension);
}

/** The file the active tab shows, a notebook's among them. */
function activeFile(): vscode.Uri | undefined {
  const tab = currentTab();
  return tab?.input instanceof vscode.TabInputNotebook ? tab.input.uri : tabUri(tab);
}

/**
 * The entry that, with the user's settings as `planned` leaves them (as they are when not given),
 * still keeps markdown files from opening where `target` asks, or null. `claimed`: the patterns
 * whose files another editor would open by itself (`claimants`).
 */
function winner(target: Target, claimed: ReadonlySet<string>, planned?: Plans): Winner | null {
  const inspected = vscode.workspace.getConfiguration().inspect(OPENING);
  const user = planned ? planned.opening.next : inspected?.globalValue;
  const levels: AssociationLevels = { workspace: inspected?.workspaceValue, user, default: inspected?.defaultValue };
  const editors = registeredEditors(manifests());
  const want = target === 'rich' ? VIEW_TYPE : TEXT_EDITOR;
  for (const note of notesToCheck()) {
    const entry = associationFor(levels, { scheme: note.scheme, path: note.path }, (v) => editors.has(v));
    if (!entry || entry.viewType === want) continue;
    const covers = MARKDOWN_PATTERNS.filter((p) => matchesEvery(entry.pattern, p));
    // Once it is gone, the user's own entries for these patterns decide its files: removing it
    // gives what was asked where each gives it, or for Source where none is set and no editor
    // opens them by itself.
    const handedTo =
      covers.length > 0 ? covers : MARKDOWN_PATTERNS.filter((p) => globToRegExp(p).test(fileNameOf(note)));
    const userEntries = patternsOf(user) ?? {};
    const removable = handedTo.every(
      (p) => userEntries[p] === want || (userEntries[p] === undefined && want === TEXT_EDITOR && !claimed.has(p)),
    );
    const extension = entry.level === 'default' ? defaultFrom(OPENING, entry.pattern) : undefined;
    return {
      level: entry.level,
      pattern: entry.pattern,
      editor: describeEditor(entry.viewType),
      want,
      covers,
      removable,
      ...(extension !== undefined && { extension }),
    };
  }
  return null;
}

/** The button for an answer naming `found`, as its words name it (model/defaultsWords.ts, `settingsToOpen`). */
function buttonFor(found: Winner): SettingsButton | undefined {
  const opens = settingsToOpen(found);
  return opens === 'workspace' ? WORKSPACE_SETTINGS_BUTTON : opens === 'user' ? USER_SETTINGS_BUTTON : undefined;
}

// ---------------------------------------------------------------------------
// The commands

/**
 * What a "by default" command resolves with (docs/ARCHITECTURE.md, "The test hook"): whether it
 * wrote the settings, and the answer it showed, with its buttons; no answer where the question
 * was closed with nothing changed.
 */
export interface DefaultsResult {
  written: boolean;
  message?: string;
  buttons?: string[];
}

/**
 * Where the files of each pattern `opening`, the plan for where they open, writes open now: in
 * the editor the user's settings choose; where VS Code passes over that one or they choose none,
 * in an editor that `claiming` says opens them by itself, else in VS Code's text editor.
 */
function whereNow(opening: Plan, claiming: ReadonlyMap<string, string[]>): Now[] {
  const editors = registeredEditors(manifests());
  return opening.changed.map((pattern): Now => {
    const chosen = opening.was[pattern];
    if (typeof chosen === 'string' && editors.has(chosen))
      return { pattern, opens: describeEditor(chosen), by: 'settings', entry: chosen };
    const byItself = claiming.get(pattern)?.[0];
    const opens = byItself !== undefined ? describeEditor(byItself) : describeEditor(TEXT_EDITOR);
    const by = byItself !== undefined ? 'itself' : 'vscode';
    return typeof chosen === 'string'
      ? { pattern, opens, by, passedOver: describeEditor(chosen), entry: chosen }
      : { pattern, opens, by };
  });
}

/**
 * Whether the workspace's settings set `workbench.editorAssociations`. VS Code 1.146's "Configure
 * default editor" (its editor resolver's `setDefaultEditor`) writes every association it reads with
 * no target, so to the most specific settings that set the key: here the workspace's, which a
 * project often shares. The words then give the user settings' entries to edit instead.
 */
function workspaceSetsOpening(): boolean {
  return vscode.workspace.getConfiguration().inspect(OPENING)?.workspaceValue !== undefined;
}

/**
 * The editors comparisons of the patterns in `changed` open in now that the entries the change
 * writes take them out of, on a VS Code that opens a comparison in the editor that opens the
 * file: each editor a pattern's files open in (`openers`) but VS Code's text editor and the one
 * its entry gives, by view type. None on a later VS Code, which keeps them where they are.
 */
function comparisonsLeft(plans: Plans, changed: readonly string[]): Set<string> {
  const left = new Set<string>();
  if (!comparisonsFollowOpening(vscode.version)) return left;
  for (const pattern of changed) {
    const entry = plans.comparing?.next?.[pattern];
    for (const opener of plans.openers?.get(pattern) ?? [])
      if (opener !== TEXT_EDITOR && opener !== entry) left.add(opener);
  }
  return left;
}

/**
 * What the change does to comparisons, as the question names it: the editors the user's settings
 * choose for them that VS Code passes over, which it replaces; the editors they open in now and
 * will leave (comparisonsLeft); and the patterns whose entries it writes.
 */
function comparisonsChange(plans: Plans): Comparisons {
  const changed = plans.comparing?.changed ?? [];
  const replaced = new Set<string>();
  for (const pattern of changed) {
    const was = plans.comparing?.was[pattern];
    if (typeof was === 'string') replaced.add(was);
  }
  return {
    replaced: [...replaced].map(describeEditor),
    left: [...comparisonsLeft(plans, changed)].map(describeEditor),
    written: changed,
  };
}

/**
 * What Use Source by Default's answers say the user's settings hold, with nothing written: the
 * markdown patterns where an entry of theirs gives VS Code's text editor and decides, for each
 * plain note of that kind (plainNotes).
 */
function sourceHeldNow(): SourceHeld {
  const inspected = vscode.workspace.getConfiguration().inspect(OPENING);
  const editors = registeredEditors(manifests());
  const chosen = MARKDOWN_EXTENSIONS.filter((extension) =>
    plainNotes(extension).every(
      (note) =>
        associationFor({ user: inspected?.globalValue }, { scheme: note.scheme, path: note.path }, (v) =>
          editors.has(v),
        )?.viewType === TEXT_EDITOR,
    ),
  ).map(patternOf);
  return { chosen, cleared: [] };
}

/** What Use Source by Default's answers say it did, from the plan it wrote: the patterns it set to VS Code's text editor, and those whose entry it took out. */
function sourceHeldAfter(opening: Plan): SourceHeld {
  return {
    chosen: opening.changed.filter((p) => opening.next?.[p] === TEXT_EDITOR),
    cleared: opening.changed.filter((p) => opening.next?.[p] === undefined),
  };
}

async function useByDefault(target: Target): Promise<DefaultsResult> {
  const title = target === 'rich' ? 'Use Tandem Markdown by Default' : 'Use Source by Default';
  const claiming = claimants();
  const claimed = target === 'source' ? new Set(claiming.keys()) : new Set<string>();
  const done = (written: boolean, message: string, button?: SettingsButton, key?: string): DefaultsResult => {
    tell(message, button, key);
    return { written, message, ...(button && { buttons: [button.title] }) };
  };
  const plans = planFor(target, claiming);
  if ('unchangeable' in plans)
    return done(false, notAnObject(plans.unchangeable), USER_SETTINGS_BUTTON, plans.unchangeable);
  if (!changesAny(plans)) {
    const found = winner(target, claimed);
    if (!found) return done(false, alreadyThere(target, richView(), sourceHeldNow()));
    return done(false, alreadySet(target, richView(), found, workspaceFile(), sourceHeldNow()), buttonFor(found));
  }
  const asked = question(
    target,
    richView(),
    whereNow(plans.opening, claiming),
    plans.opening.kept,
    comparisonsChange(plans),
    winner(target, claimed, plans),
    workspaceFile(),
    workspaceSetsOpening(),
  );
  if (!(await confirm(asked.message, asked.detail, asked.button))) return { written: false };

  // Read again: the settings may have changed while the question was open. Only the markdown entries change.
  const fresh = planFor(target, claiming);
  if ('unchangeable' in fresh)
    return done(false, notAnObject(fresh.unchangeable), USER_SETTINGS_BUTTON, fresh.unchangeable);
  // The comparisons' setting is written first, so a write that fails between the two never
  // leaves comparisons to this editor.
  for (const p of [fresh.comparing, fresh.opening]) {
    if (!p?.changes) continue;
    await vscode.workspace.getConfiguration().update(p.key, p.next, vscode.ConfigurationTarget.Global);
    const entries = MARKDOWN_PATTERNS.map((pattern) => `${pattern} ${JSON.stringify(p.next?.[pattern] ?? null)}`);
    log('info', `${title}: ${p.key} in the user settings now holds ${entries.join(', ')}`);
  }
  const written = changesAny(fresh);
  const found = winner(target, claimed);
  const held = sourceHeldAfter(fresh.opening);
  if (found) return done(written, afterWriting(target, richView(), found, workspaceFile(), held), buttonFor(found));
  return done(written, fromNowOn(target, richView(), held));
}

export const defaults: HostFeature = () =>
  vscode.Disposable.from(
    registerCommand('useByDefault', () => useByDefault('rich')),
    registerCommand('useSourceByDefault', () => useByDefault('source')),
  );
