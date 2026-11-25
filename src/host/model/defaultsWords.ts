// Every word Use Tandem Markdown by Default and Use Source by Default (defaults.ts) show: the
// question and its buttons, and each answer, among them what a command says when an entry it does
// not write still decides where markdown files open (model/editorAssociations.ts says which entry
// wins). Each screen names the rich view as Tandem Markdown's, and Source as VS Code's text
// editor, the first time it names them (`Names`). A sentence true of only some markdown files
// names them by their kind (".md files").

import { listed } from '../../core/listText';
import type { AssociationLevel } from './editorAssociations';
import { TEXT_EDITOR } from './editorIds';
import { MARKDOWN_PATTERNS } from './glob';
import { fill } from './templates';

export type Setting = 'opening' | 'comparing';

export const SETTING_KEYS: Record<Setting, string> = {
  opening: 'workbench.editorAssociations',
  comparing: 'workbench.diffEditorAssociations',
};

export const DONT_CHANGE = "Don't change";
export const OPEN_USER_SETTINGS = 'Open user settings';
export const OPEN_WORKSPACE_SETTINGS = 'Open workspace settings';

/** VS Code's command, as its Command Palette names it, whose list sets a kind of file's default editor. */
const REOPEN_WITH = 'View: Reopen Editor With...';

/** How VS Code's Reopen Editor With list names its text editor and this extension's custom editor. */
const PICKED_LABELS = { source: 'Text Editor', rich: 'Rich Editor' } as const;

const USER_SETTINGS_BY_COMMAND =
  'VS Code\'s command "Preferences: Open User Settings (JSON)" opens your user settings.';

/**
 * Every sentence and name of the question and its answers, «name» marking what is filled in; the
 * functions below choose among them and fill them in.
 */
export const DEFAULTS_WORDS = {
  // How a screen names the two views and the files.
  sourceFirst: "Source (VS Code's text editor)",
  source: 'Source',
  richFirst: "Tandem Markdown's «rich»",
  richAgain: 'the «rich»',
  markdownFiles: 'markdown files',
  markdownFilesStart: 'Markdown files',
  kindFiles: '«kinds» files',
  yourFiles: 'Your «files»',
  filesMatching: 'markdown files that match «pattern»',
  filesIn: '«files» in «editor»',
  namedEditor: '«name» («viewType»)',
  userChoose: 'your user settings choose',
  extensionChooses: 'the default settings of «extension» choose',
  defaultChooses: 'a default setting chooses',
  valueSource: `"«value»", VS Code's name for «source»`,
  valueRich: '"«value»", «rich»',
  notAnObject: "Your «key» setting is in a form Tandem Markdown can't change, so nothing was changed.",

  // The question.
  question: 'Open «files» in «place» by default?',
  useRich: 'Use «rich»',
  useSource: 'Use Source',
  willStay:
    '«files» will stay in «editor», since «whose» it for «pattern», and VS Code uses the longest pattern that matches a file.',
  richEditable: 'The «rich» shows each file as a formatted page you can edit.',
  richReadOnly: 'The «rich» shows each file as a formatted page, read-only except for checkboxes.',
  onlyComparisons:
    'Your user settings already open «files» in «rich», so this changes only the setting for their comparisons.',
  settingsOpenNow: 'Your user settings open «chosen» now.',
  passedOver:
    "Your user settings choose «passed» for «files», but it isn't installed or is disabled, so they open in «editor» now.",
  passedOverRemoved:
    "Your user settings choose «passed» for «files», but it isn't installed or is disabled, so they open in «editor» now, and this removes that entry.",
  opensByItself: '«editor» opens «files» now, by itself, since no setting chooses an editor for them.',
  openNow: '«files» open in «editor» now.',
  linesNotKept:
    'Search results and links to a line will open the file where you were last in it, or at its top, not at the line.',
  comparisonsStay: "Comparisons, such as git's, will still open where they do now.",
  comparisonsLeave: "Comparisons, such as git's, will open in VS Code's own comparison view instead of «editors».",
  replacesOne:
    "For comparisons, this replaces «editors» in your user settings: that editor isn't installed or is disabled, so VS Code passes over it now.",
  replacesMany:
    "For comparisons, this replaces «editors» in your user settings: those editors aren't installed or are disabled, so VS Code passes over them now.",
  workspaceWillStayFile:
    'In this workspace, «files» will still open in «editor», since its settings file, «file», chooses that; the message after this one says how to change it.',
  workspaceWillStayOwn:
    'In this workspace, «files» will still open in «editor», since its own settings choose that; the message after this one says how to change them.',
  switchButton: 'A button at the right end of the row of tabs switches the active tab to «place».',

  // How to undo the change.
  command: { rich: 'Use Tandem Markdown by Default', source: 'Use Source by Default' },
  steps: `open a «kind» file, run "${REOPEN_WITH}", choose "Configure default editor for '«pattern»'...", and choose «label»`,
  stepsAgain: 'then do the same in a «kind» file, choosing «label»',
  chooseIt: 'it',
  chooseAgain: 'To choose it again once it is installed, «steps».',
  undoComparisons: `To undo this, remove the entries for «patterns» under "${SETTING_KEYS.comparing}" in your user settings.`,
  undoSteps: 'To undo this, «steps».',
  undoCommand: 'To undo this, run Tandem Markdown: «command».',
  undoCommandThen: 'To undo this, run Tandem Markdown: «command», then «steps».',
  /** Where VS Code's steps would write the workspace's settings (undoneByHand): each entry «changes» names. */
  undoByHand: `To undo this, edit "${SETTING_KEYS.opening}" in your user settings: «changes». ${USER_SETTINGS_BY_COMMAND}`,
  entryBack: 'set the entry for «pattern» back to "«entry»"',
  entryOut: 'remove the entry for «pattern»',

  // The answers.
  nowOpenRich: 'Your user settings now open «files» in «rich».',
  nowOpenCleared: '«files» now open in «source», since your user settings no longer choose another editor for them.',
  nowOpenChosen: 'Your user settings now open «files» in «source».',
  tabsStay: 'Tabs that are open now stay as they are.',
  nothingChanged: 'Nothing was changed.',
  alreadyByUser: 'Nothing was changed: your user settings already open «files» in «place».',
  alreadyByNone:
    'Nothing was changed: «files» already open in «source», since your user settings choose no other editor for them.',
  alreadyMixed:
    'Nothing was changed: «files» already open in «source», as your user settings choose it for «chosen» and no other editor for «none».',
  workspaceStillOwn: `In this workspace, «files» still open in «editor», since its own settings choose that. The button "${OPEN_WORKSPACE_SETTINGS}" opens those settings. To change them, edit their entry for «pattern» under "${SETTING_KEYS.opening}": set it to «value», or remove the line.`,
  workspaceStillFile:
    'In this workspace, «files» still open in «editor», since its settings file, «file», chooses that.',
  sharedFile: 'That file belongs to the project and may be shared with others.',
  changeItsEntry: `To change it, edit its entry for «pattern» under "${SETTING_KEYS.opening}": set it to «value», or remove the line.`,
  whoDecides:
    "Removing it lets each person's own settings decide; setting it chooses for everyone who opens the project.",
  buttonOpensFile: `The button "${OPEN_WORKSPACE_SETTINGS}" opens that file.`,
  stillOpen:
    '«files» still open in «editor», since «whose» it for «pattern», and VS Code uses the longest pattern that matches a file.',
  changeEntry: 'To open them in «place», change that entry to "«want»".',
  changeOrRemoveEntry: 'To open them in «place», change that entry to "«want»", or remove it.',
  addLine: `To open them in «place», add this line under "${SETTING_KEYS.opening}" in your user settings: "«pattern»": "«want»". ${USER_SETTINGS_BY_COMMAND}`,
} as const;
const W = DEFAULTS_WORDS;

type EditorKind = 'source' | 'rich' | 'other';

/**
 * An editor as the words name it: Source or the rich view by its kind, any other by `name`
 * ("Markdown Writer (markdownWriter.editor)"), and in VS Code's list of editors by `label`
 * ("Markdown Writer").
 */
export interface NamedEditor {
  kind: EditorKind;
  name: string;
  label: string;
}

/** The rich view markdown files open in, the one Default Rich Mode opens first: its name, and whether it is read-only. */
export interface RichView {
  name: string;
  readOnly: boolean;
}

/** Where the files of one markdown pattern the change writes open now. */
export interface Now {
  pattern: string;
  opens: NamedEditor;
  /**
   * Why: the user's settings choose it; it is VS Code's text editor, which opens them while no
   * setting chooses another; or the editor opens them by itself.
   */
  by: 'settings' | 'vscode' | 'itself';
  /** An editor the user's settings choose for them that VS Code passes over, since it is not installed or is disabled. */
  passedOver?: NamedEditor;
  /** The user's own entry for the pattern before the change, where they had one: what undoing it by hand sets back. */
  entry?: string;
}

/** What Use Tandem Markdown by Default does to comparisons of markdown files. */
export interface Comparisons {
  /** Editors the user's settings choose for comparisons that VS Code passes over, which it replaces. */
  replaced: readonly NamedEditor[];
  /**
   * The editors comparisons open in now, on a VS Code that opens one in the editor that opens the
   * file, that they will leave for VS Code's own comparison view: the rich view, or another
   * extension's editor where workspace folders open the files in different editors.
   */
  left: readonly NamedEditor[];
  /** The patterns (`*.md`) whose comparisons entries it writes. */
  written: readonly string[];
}

/**
 * For Use Source by Default's answers, what the user's settings hold for markdown patterns
 * (`*.md`): `chosen`, those where an entry of theirs gives Source and decides (after writing,
 * those the command set to it); `cleared`, those whose entry for another editor the command took
 * out. A pattern in neither opens in Source since no entry of theirs chooses another editor.
 */
export interface SourceHeld {
  chosen: readonly string[];
  cleared: readonly string[];
}

/** An entry the command does not write that still decides where markdown files open. */
export interface Winner {
  level: AssociationLevel;
  pattern: string;
  editor: NamedEditor;
  /** The editor the command sets for them, by its id: the value the words say to set. */
  want: string;
  /** The markdown patterns (`*.md`) all of whose files it decides. */
  covers: readonly string[];
  /** For an entry of the user's own: removing it opens what it covers where the command asks. */
  removable: boolean;
  /** For a default, the extension that adds it, when known. */
  extension?: string;
}

/**
 * Where the winning workspace entry is kept: the workspace's settings file by its name
 * (`.vscode/settings.json`, or the `.code-workspace` file's), or null for an untitled workspace,
 * whose settings have no file of their own.
 */
export type WorkspaceFile = string | null;

export type Target = 'rich' | 'source';

/**
 * The names one screen gives the two views of a markdown file: the rich view as Tandem
 * Markdown's and Source as VS Code's text editor the first time, and shortly after that.
 */
class Names {
  private sourceNamed = false;
  private richNamed = false;

  constructor(readonly richName: string) {}

  source(): string {
    const first = !this.sourceNamed;
    this.sourceNamed = true;
    return first ? W.sourceFirst : W.source;
  }

  rich(): string {
    const first = !this.richNamed;
    this.richNamed = true;
    return fill(first ? W.richFirst : W.richAgain, { rich: this.richName });
  }

  editor(e: NamedEditor): string {
    return e.kind === 'source' ? this.source() : e.kind === 'rich' ? this.rich() : e.name;
  }

  place(target: Target): string {
    return target === 'rich' ? this.rich() : this.source();
  }
}

function startOf(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function kindOf(pattern: string): string {
  return pattern.replace(/^\*/, '');
}

/** "markdown files" when every markdown pattern is covered, else ".md files". */
function filesOf(patterns: readonly string[]): string {
  return MARKDOWN_PATTERNS.every((p) => patterns.includes(p))
    ? W.markdownFiles
    : fill(W.kindFiles, { kinds: listed(patterns.map(kindOf)) });
}

function startFilesOf(patterns: readonly string[]): string {
  const files = filesOf(patterns);
  return files === W.markdownFiles ? W.markdownFilesStart : fill(W.yourFiles, { files });
}

function leftBy(w: Winner): string[] {
  return MARKDOWN_PATTERNS.filter((p) => !w.covers.includes(p));
}

function filesWon(w: Winner): string {
  return w.covers.length > 0 ? filesOf(w.covers) : fill(W.filesMatching, { pattern: w.pattern });
}

function startFilesWon(w: Winner): string {
  return w.covers.length > 0 ? startFilesOf(w.covers) : startOf(filesWon(w));
}

function whoseChoice(w: Winner): string {
  if (w.level === 'user') return W.userChoose;
  return w.extension ? fill(W.extensionChooses, { extension: w.extension }) : W.defaultChooses;
}

function valueFor(w: Winner, names: Names): string {
  return w.want === TEXT_EDITOR
    ? fill(W.valueSource, { value: TEXT_EDITOR, source: names.source() })
    : fill(W.valueRich, { value: w.want, rich: names.rich() });
}

/**
 * The settings the answer's button opens: the workspace's where an entry of the workspace's still
 * decides, the user's where one of theirs does; none for a default's, which no file of the
 * user's holds.
 */
export function settingsToOpen(winner: Winner | null): 'workspace' | 'user' | null {
  return winner?.level === 'workspace' ? 'workspace' : winner?.level === 'user' ? 'user' : null;
}

export function namedEditor(name: string, viewType: string): string {
  return fill(W.namedEditor, { name, viewType });
}

export function notAnObject(key: string): string {
  return fill(W.notAnObject, { key });
}

// ---------------------------------------------------------------------------
// The question

/**
 * The question, its detail and its button, for markdown files to open where `target` asks: `now`
 * is where the files of each pattern the change writes open now, `kept` the markdown patterns it
 * leaves since they already give what was asked, `comparisons` what it does to comparisons, and
 * `winner` an entry the change does not write that will still decide. `workspaceSetsOpening`: the
 * workspace's settings set `workbench.editorAssociations`, so VS Code's own steps to choose a
 * default editor would write the choice there (undoing).
 */
export function question(
  target: Target,
  rich: RichView,
  now: readonly Now[],
  kept: readonly string[],
  comparisons: Comparisons,
  winner: Winner | null,
  file: WorkspaceFile,
  workspaceSetsOpening = false,
): { message: string; detail: string; button: string } {
  const names = new Names(rich.name);
  const elsewhere = winner !== null && winner.level !== 'workspace' ? winner : null;
  const reached = elsewhere ? leftBy(elsewhere) : MARKDOWN_PATTERNS;
  // In the order they are shown, since a screen names Source and the rich view in full the first time.
  const message = fill(W.question, { files: filesOf(reached), place: names.place(target) });
  const parts: string[] = [];
  if (elsewhere)
    parts.push(
      fill(W.willStay, {
        files: startFilesWon(elsewhere),
        editor: names.editor(elsewhere.editor),
        whose: whoseChoice(elsewhere),
        pattern: elsewhere.pattern,
      }),
    );
  if (target === 'rich') parts.push(fill(rich.readOnly ? W.richReadOnly : W.richEditable, { rich: rich.name }));
  parts.push(
    ...(now.length > 0
      ? whereNow(target, now, names)
      : [fill(W.onlyComparisons, { files: filesOf(reached), rich: names.rich() })]),
  );
  if (target === 'rich') {
    parts.push(
      W.linesNotKept,
      comparisons.left.length > 0
        ? fill(W.comparisonsLeave, { editors: listed(comparisons.left.map((e) => names.editor(e))) })
        : W.comparisonsStay,
      ...comparisonsSentence(comparisons.replaced),
    );
  }
  if (winner?.level === 'workspace') {
    const where = { files: filesWon(winner), editor: names.editor(winner.editor) };
    parts.push(file !== null ? fill(W.workspaceWillStayFile, { ...where, file }) : fill(W.workspaceWillStayOwn, where));
  }
  parts.push(fill(W.switchButton, { place: target === 'rich' ? names.source() : names.rich() }));
  parts.push(undoing(target, now, kept, comparisons.written, workspaceSetsOpening));
  return {
    message,
    detail: parts.join(' '),
    button: target === 'rich' ? fill(W.useRich, { rich: rich.name }) : W.useSource,
  };
}

/**
 * Where the files the change writes for open now, and why, in the order of `now`, one sentence
 * for each editor. For Source, an entry for an editor VS Code passes over changes nothing it
 * opens, and the words say that the change removes it.
 */
function whereNow(target: Target, now: readonly Now[], names: Names): string[] {
  const groups: { first: Now; patterns: string[] }[] = [];
  for (const n of now) {
    const same = groups.find(
      (g) =>
        g.first.opens.kind === n.opens.kind &&
        g.first.opens.name === n.opens.name &&
        g.first.by === n.by &&
        g.first.passedOver?.name === n.passedOver?.name,
    );
    if (same) same.patterns.push(n.pattern);
    else groups.push({ first: n, patterns: [n.pattern] });
  }
  // The editors the user's settings choose, in one sentence however many there are, where the first stands.
  const chosen = groups.filter((g) => g.first.by === 'settings' && !g.first.passedOver);
  const settingsSentence = () =>
    fill(W.settingsOpenNow, {
      chosen: listed(
        chosen.map((g) => fill(W.filesIn, { files: filesOf(g.patterns), editor: names.editor(g.first.opens) })),
      ),
    });
  return groups.flatMap(({ first, patterns }) => {
    const files = filesOf(patterns);
    if (first.passedOver) {
      const removed = target === 'source' && first.opens.kind === 'source';
      return fill(removed ? W.passedOverRemoved : W.passedOver, {
        passed: first.passedOver.name,
        files,
        editor: names.editor(first.opens),
      });
    }
    if (first.by === 'settings') return first === chosen[0]!.first ? [settingsSentence()] : [];
    if (first.by === 'itself') return fill(W.opensByItself, { editor: startOf(names.editor(first.opens)), files });
    return fill(W.openNow, { files: startFilesOf(patterns), editor: names.editor(first.opens) });
  });
}

function comparisonsSentence(replaced: readonly NamedEditor[]): string[] {
  if (replaced.length === 0) return [];
  return [
    fill(replaced.length === 1 ? W.replacesOne : W.replacesMany, { editors: listed(replaced.map((e) => e.name)) }),
  ];
}

function stepsFor(pattern: string, label: string): string {
  return fill(W.steps, { kind: kindOf(pattern), pattern, label });
}

function stepsInTurn(back: readonly { pattern: string; label: string }[]): string {
  const [first, ...rest] = back;
  if (!first) return '';
  return [
    stepsFor(first.pattern, first.label),
    ...rest.map((b) => fill(W.stepsAgain, { kind: kindOf(b.pattern), label: b.label })),
  ].join(', ');
}

function labelOf(e: NamedEditor): string {
  return e.kind === 'other' ? e.label : PICKED_LABELS[e.kind];
}

/**
 * How to undo the change, for each pattern it writes: by the other command where its files go back
 * to what that command opens them in, and by VS Code's list for each other editor. The other
 * command writes every markdown pattern it can, so where this one kept one that already gave what
 * was asked (`kept`), the words give VS Code's steps for each pattern instead. For Source, files
 * whose editor VS Code passes over open in Source before and after: where those are all it
 * changes, the words say how to choose that editor once it is installed. VS Code's list saves the
 * choice in the most specific settings that set `workbench.editorAssociations`, so where the
 * workspace's do (`byHand`), the words give the user settings' entries to edit instead.
 */
function undoing(
  target: Target,
  now: readonly Now[],
  kept: readonly string[],
  comparing: readonly string[],
  byHand: boolean,
): string {
  // Use Tandem Markdown by Default where markdown files already open in the rich view: it writes only comparisons entries.
  if (now.length === 0) return fill(W.undoComparisons, { patterns: listed(comparing) });
  const theirs = target === 'rich' ? 'source' : 'rich';
  const command = W.command[theirs];
  const back = now.filter((n) => target === 'rich' || n.opens.kind !== 'source');
  const others = back.filter((n) => n.opens.kind !== theirs);
  if (back.length > 0 && kept.length === 0 && others.length === 0) return fill(W.undoCommand, { command });
  if (byHand) return undoneByHand(now);
  if (back.length === 0) {
    const passed = now.find((n) => n.passedOver);
    return fill(W.chooseAgain, { steps: stepsFor(passed?.pattern ?? MARKDOWN_PATTERNS[0]!, W.chooseIt) });
  }
  const steps = (of: readonly Now[]) => stepsInTurn(of.map((n) => ({ pattern: n.pattern, label: labelOf(n.opens) })));
  if (kept.length > 0) return fill(W.undoSteps, { steps: steps(back) });
  return others.length === back.length
    ? fill(W.undoSteps, { steps: steps(others) })
    : fill(W.undoCommandThen, { command, steps: steps(others) });
}

/** The undo by hand: each entry of the user settings the change wrote, set back to what it was, or taken out where they had none. */
function undoneByHand(now: readonly Now[]): string {
  const changes = now.map((n) =>
    n.entry === undefined
      ? fill(W.entryOut, { pattern: n.pattern })
      : fill(W.entryBack, { pattern: n.pattern, entry: n.entry }),
  );
  return fill(W.undoByHand, { changes: listed(changes) });
}

// ---------------------------------------------------------------------------
// The answers

function among(patterns: readonly string[], of: readonly string[]): string[] {
  return patterns.filter((p) => of.includes(p));
}

/**
 * What the user's settings now open where `target` asks, for the files of `reached`. For Source,
 * by what the command did to each kind (`held`): took out an entry for another editor, or set
 * Source.
 */
function nowOpen(target: Target, reached: readonly string[], held: SourceHeld, names: Names): string {
  if (target === 'rich') return fill(W.nowOpenRich, { files: filesOf(reached), rich: names.rich() });
  const cleared = among(reached, held.cleared);
  const chosen = among(reached, held.chosen);
  const sentences: string[] = [];
  if (cleared.length > 0)
    sentences.push(fill(W.nowOpenCleared, { files: startFilesOf(cleared), source: names.source() }));
  if (chosen.length > 0) sentences.push(fill(W.nowOpenChosen, { files: filesOf(chosen), source: names.source() }));
  return sentences.join(' ');
}

/**
 * That nothing was changed, for the files of `reached`, and why. For Source, where an entry of
 * the user's gives it (`held.chosen`), or no entry of theirs chooses another editor.
 */
function alreadyOpen(target: Target, reached: readonly string[], held: SourceHeld, names: Names): string {
  const files = filesOf(reached);
  if (target === 'rich') return fill(W.alreadyByUser, { files, place: names.rich() });
  const chosen = among(reached, held.chosen);
  const none = reached.filter((p) => !chosen.includes(p));
  if (none.length === 0) return fill(W.alreadyByUser, { files, place: names.source() });
  if (chosen.length === 0) return fill(W.alreadyByNone, { files, source: names.source() });
  return fill(W.alreadyMixed, { files, source: names.source(), chosen: filesOf(chosen), none: filesOf(none) });
}

/** The answer when markdown files already open where `target` asks, and nothing else decides. `held`: for Source. */
export function alreadyThere(target: Target, rich: RichView, held: SourceHeld): string {
  return alreadyOpen(target, MARKDOWN_PATTERNS, held, new Names(rich.name));
}

/** The answer after writing, when nothing else decides. `held`: for Source, what the command did to each kind. */
export function fromNowOn(target: Target, rich: RichView, held: SourceHeld): string {
  return `${nowOpen(target, MARKDOWN_PATTERNS, held, new Names(rich.name))} ${W.tabsStay}`;
}

/** What the command says after writing, where `winner` still decides: for markdown files to open where `target` asks. */
export function afterWriting(
  target: Target,
  rich: RichView,
  winner: Winner,
  file: WorkspaceFile,
  held: SourceHeld,
): string {
  return withWinner(target, rich, winner, file, (reached, names) => nowOpen(target, reached, held, names));
}

/** What the command says when the user's settings already say what was asked, where `winner` still decides. */
export function alreadySet(
  target: Target,
  rich: RichView,
  winner: Winner,
  file: WorkspaceFile,
  held: SourceHeld,
): string {
  return withWinner(target, rich, winner, file, (reached, names) =>
    reached.length > 0 ? alreadyOpen(target, reached, held, names) : W.nothingChanged,
  );
}

/**
 * An answer where `winner` still decides: `confirm` says what the user's settings hold for the
 * files they reach (all, or those a longer entry of the user's or a default's leaves them), then
 * where `winner` opens what it decides.
 */
function withWinner(
  target: Target,
  rich: RichView,
  winner: Winner,
  file: WorkspaceFile,
  confirm: (reached: readonly string[], names: Names) => string,
): string {
  const names = new Names(rich.name);
  const reached = winner.level === 'workspace' ? MARKDOWN_PATTERNS : leftBy(winner);
  return [confirm(reached, names), stillDeciding(target, winner, file, names)].join(' ');
}

function stillDeciding(target: Target, winner: Winner, file: WorkspaceFile, names: Names): string {
  return winner.level === 'workspace' ? inThisWorkspace(winner, file, names) : stillEverywhere(target, winner, names);
}

function inThisWorkspace(w: Winner, file: WorkspaceFile, names: Names): string {
  const files = filesWon(w);
  const editor = names.editor(w.editor);
  const entry = { pattern: w.pattern, value: valueFor(w, names) };
  if (file === null) return fill(W.workspaceStillOwn, { files, editor, ...entry });
  return [
    fill(W.workspaceStillFile, { files, editor, file }),
    W.sharedFile,
    fill(W.changeItsEntry, entry),
    W.whoDecides,
    W.buttonOpensFile,
  ].join(' ');
}

function stillEverywhere(target: Target, w: Winner, names: Names): string {
  const stays = fill(W.stillOpen, {
    files: startFilesWon(w),
    editor: names.editor(w.editor),
    whose: whoseChoice(w),
    pattern: w.pattern,
  });
  const place = names.place(target);
  const change =
    w.level !== 'user'
      ? fill(W.addLine, { place, pattern: w.pattern, want: w.want })
      : fill(w.removable ? W.changeOrRemoveEntry : W.changeEntry, { place, want: w.want });
  return `${stays} ${change}`;
}
