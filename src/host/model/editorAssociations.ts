// Which editor VS Code opens a file in, or a comparison of one, by an editor associations setting
// (`workbench.editorAssociations`, `workbench.diffEditorAssociations`), as VS Code 1.120 to 1.146
// works it out: for one pattern the workspace's entry wins over the user's and the user's over a
// default's; of the patterns that match the file, the longest wins, wherever it came from; an
// entry for an editor VS Code has not registered (registeredEditors) is passed over. Both settings
// are the window's, so a folder's own value never counts. A pattern with a `/` is matched against
// the file's scheme and path (`file:/w/notes/a.md`), any other against its name, letter case
// ignored. With no entry for a file, VS Code opens it in an editor whose priority lets it open
// files by itself (editorsOpeningByThemselves), and in its text editor when there is none.

import { TEXT_EDITOR, VIEW_TYPE } from './editorIds';
import { globToRegExp } from './glob';

/** Where an entry comes from: the workspace's settings, the user's, or a default an extension adds. */
export type AssociationLevel = 'workspace' | 'user' | 'default';

/** What each level of one setting holds, as `inspect()` gives it; a value that is not an object of patterns holds none. */
export type AssociationLevels = Partial<Record<AssociationLevel, unknown>>;

/** The entry VS Code takes for a file. */
export interface Association {
  pattern: string;
  viewType: string;
  level: AssociationLevel;
}

export interface AssociatedFile {
  scheme: string;
  path: string;
}

/**
 * The entry VS Code opens `file` by, or undefined when none matches and VS Code chooses by itself.
 * `registered` is true for an editor VS Code has registered (registeredEditors).
 */
export function associationFor(
  levels: AssociationLevels,
  file: AssociatedFile,
  registered: (viewType: string) => boolean,
): Association | undefined {
  const workspace = patternsOf(levels.workspace) ?? {};
  const user = patternsOf(levels.user) ?? {};
  const below = { ...patternsOf(levels.default), ...user };
  const entries: { pattern: string; viewType: unknown; level: AssociationLevel }[] = [
    ...Object.entries(workspace).map(([pattern, viewType]) => ({ pattern, viewType, level: 'workspace' as const })),
    ...Object.entries(below)
      .filter(([pattern]) => workspace[pattern] === undefined)
      .map(([pattern, viewType]) => ({
        pattern,
        viewType,
        level: pattern in user ? ('user' as const) : ('default' as const),
      })),
  ];
  const found = entries
    .filter((e) => e.pattern !== '' && matches(e.pattern, file))
    .sort((a, b) => b.pattern.length - a.pattern.length)
    .find((e) => typeof e.viewType === 'string' && registered(e.viewType));
  return found && { pattern: found.pattern, viewType: found.viewType as string, level: found.level };
}

/**
 * The editors VS Code registers itself, not from an extension's manifest, in 1.120 to 1.146 (the
 * `registerEditor` calls of its workbench): its text editor and those of its own parts. The image,
 * video and sound previews are its own from 1.146; before, the manifest of its media-preview
 * extension declares them.
 */
const VSCODE_EDITORS: readonly string[] = [
  TEXT_EDITOR,
  'imagePreview.previewEditor',
  'vscode.videoPreview',
  'vscode.audioPreview',
  'workbench.editorinputs.searchEditorInput',
  'workbench.editorinputs.sidebysideEditorInput',
  'workbench.editors.gettingStartedInput',
  'workbench.editor.browser',
  'workbench.editor.chatSession',
  'workbench.editor.chatDebug',
  'workbench.editor.processExplorer',
  'agentSessionsWelcomePage',
  'terminalEditor',
  'interactive',
  'vscode-interactive-input',
  'repl',
  'notebookOutputEditor',
];

/**
 * Every editor VS Code counts an entry for: its own, and the custom editors and notebooks that the
 * manifests in `packages` declare (each extension's `package.json`). VS Code registers a notebook
 * as an editor by its `type`.
 */
export function registeredEditors(packages: readonly unknown[]): Set<string> {
  const editors = new Set(VSCODE_EDITORS);
  for (const editor of contributed(packages, 'customEditors'))
    if (typeof editor.viewType === 'string') editors.add(editor.viewType);
  for (const notebook of contributed(packages, 'notebooks'))
    if (typeof notebook.type === 'string') editors.add(notebook.type);
  return editors;
}

/**
 * True when an entry of the user's settings or a default's, for an editor that `registered` is
 * true of, has a pattern longer than `pattern` (`*.md`) that matches every file `pattern` does,
 * such as `*.{md,markdown}`, or `pattern` in every folder: VS Code then never opens a file by an
 * entry for `pattern`.
 */
export function patternOutranked(
  levels: Pick<AssociationLevels, 'user' | 'default'>,
  pattern: string,
  registered: (viewType: string) => boolean,
): boolean {
  const entries = { ...patternsOf(levels.default), ...patternsOf(levels.user) };
  return Object.entries(entries).some(
    ([other, viewType]) =>
      other.length > pattern.length &&
      typeof viewType === 'string' &&
      registered(viewType) &&
      matchesEvery(other, pattern),
  );
}

/** True when `glob` matches every file that `pattern` (`*.md`) matches, as `*.md`, `*.{md,markdown}` and `pattern` in every folder do. */
export function matchesEvery(glob: string, pattern: string): boolean {
  const same = [pattern, `**/${pattern}`].map((p) => p.toLowerCase());
  return withoutBraces(glob).some((one) => same.includes(one.toLowerCase()));
}

/** The globs `glob` stands for with its braces read out: `*.{md,txt}` is `*.md` and `*.txt`. */
function withoutBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open < 0) return [glob];
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') depth++;
    else if (c === ',' && depth === 1) {
      parts.push(glob.slice(start, i));
      start = i + 1;
    } else if (c === '}' && --depth === 0) {
      parts.push(glob.slice(start, i));
      const before = glob.slice(0, open);
      const after = glob.slice(i + 1);
      return parts.flatMap((part) => withoutBraces(`${before}${part}${after}`));
    }
  }
  return [glob];
}

/** The name a custom editor or notebook of `packages` shows for itself, when its manifest gives one. */
export function editorDisplayName(packages: readonly unknown[], viewType: string): string | undefined {
  const found =
    contributed(packages, 'customEditors').find((editor) => editor.viewType === viewType) ??
    contributed(packages, 'notebooks').find((notebook) => notebook.type === viewType);
  return typeof found?.displayName === 'string' && found.displayName !== '' ? found.displayName : undefined;
}

/**
 * The custom editors and notebooks in `packages`, by view type, that VS Code `version` (such as
 * "1.146.0") opens `file` in by themselves when no association names an editor for it: those
 * whose priority it reads as "default" or "builtin" and one of whose selectors' patterns matches
 * the file. VS Code's resolver ignores a notebook selector's `excludeFileNamePattern`.
 */
export function editorsOpeningByThemselves(
  packages: readonly unknown[],
  file: AssociatedFile,
  version: string,
): string[] {
  const customEditors = contributed(packages, 'customEditors')
    .filter((editor) => customEditorOpensByItself(editor.priority, version) && selects(editor.selector, file))
    .map((editor) => editor.viewType);
  const notebooks = contributed(packages, 'notebooks')
    .filter((notebook) => notebookOpensByItself(notebook.priority) && selects(notebook.selector, file))
    .map((notebook) => notebook.type);
  return [...customEditors, ...notebooks].filter((viewType): viewType is string => typeof viewType === 'string');
}

type Release = readonly [major: number, minor: number];
/** The first release that reads a custom editor's priority object by its `textEditor` field. */
const TEXT_EDITOR_FIELD_FROM: Release = [1, 126];
/** The first release that reads the custom editor priority "explicit". */
const EXPLICIT_FROM: Release = [1, 132];
/**
 * The first release that, where no entry chooses an editor for comparisons, keeps its text
 * comparison for an editor whose priority is a string; before it, a comparison opens in the editor
 * that opens the file.
 */
const TEXT_COMPARISON_FROM: Release = [1, 129];

/**
 * What Use Tandem Markdown by Default sets the comparisons entry for one markdown pattern to, so
 * that comparisons never fall to this extension's editor and otherwise stay where they are: `now`,
 * the user's entry, where it names an editor `registered` is true of, since that is their choice
 * for comparisons alone; else, on a VS Code `version` that opens a comparison in the editor that
 * opens the file (1.120 to 1.128), `opener`, the editor the pattern's files open in now, where it
 * is another extension's; else VS Code's text comparison.
 */
export function comparisonEntry(
  now: unknown,
  opener: string,
  registered: (viewType: string) => boolean,
  version: string,
): string {
  if (typeof now === 'string' && registered(now)) return now;
  if (comparisonsFollowOpening(version) && opener !== VIEW_TYPE && opener !== TEXT_EDITOR && registered(opener))
    return opener;
  return TEXT_EDITOR;
}

/** True when VS Code `version` opens a comparison, where no entry chooses an editor for it, in the editor that opens the file: 1.120 to 1.128. */
export function comparisonsFollowOpening(version: string): boolean {
  return !atLeast(version, TEXT_COMPARISON_FROM);
}

function atLeast(version: string, [major, minor]: Release): boolean {
  const [ownMajor = 0, ownMinor = 0] = version.split('.').map((part) => parseInt(part, 10));
  return ownMajor > major || (ownMajor === major && ownMinor >= minor);
}

/**
 * True when VS Code `version` reads a custom editor's `priority` as opening files by itself.
 * Every release reads "option" as not, and from 1.132 "explicit"; any other value as "default",
 * or "builtin" for a built-in extension, and both do. From 1.126 an object gives its `textEditor`
 * value; an earlier release reads an object as "default" or by another field. A value some
 * release reads as not opening ("never", in 1.129 to 1.131; an object, before 1.126) counts here
 * as opening, which at worst has Use Source by Default write an entry it did not need.
 */
function customEditorOpensByItself(priority: unknown, version: string): boolean {
  const read =
    typeof priority === 'string'
      ? priority
      : atLeast(version, TEXT_EDITOR_FIELD_FROM)
        ? (priority as { textEditor?: unknown } | null | undefined)?.textEditor
        : undefined;
  return read !== 'option' && !(read === 'explicit' && atLeast(version, EXPLICIT_FROM));
}

/** True when VS Code reads a notebook's `priority` as opening files by itself: none given, or "default"; anything else it reads as "option". */
function notebookOpensByItself(priority: unknown): boolean {
  return !priority || priority === 'default';
}

/** True when the pattern of one of an editor's `selector` entries matches `file`; an entry with no pattern is passed over, as VS Code does. */
function selects(selector: unknown, file: AssociatedFile): boolean {
  return objectsIn(selector).some(
    (entry) =>
      typeof entry.filenamePattern === 'string' && entry.filenamePattern !== '' && matches(entry.filenamePattern, file),
  );
}

/** A setting's value as an object of patterns; null when it is not one (an old list form, or anything else). */
export function patternsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contributed(packages: readonly unknown[], point: 'customEditors' | 'notebooks'): Record<string, unknown>[] {
  return packages.flatMap((json) =>
    objectsIn((json as { contributes?: Record<string, unknown> } | null | undefined)?.contributes?.[point]),
  );
}

function matches(pattern: string, file: AssociatedFile): boolean {
  const target = pattern.includes('/')
    ? `${file.scheme}:${file.path}`
    : file.path.slice(file.path.lastIndexOf('/') + 1);
  return globToRegExp(pattern).test(target);
}

function objectsIn(list: unknown): Record<string, unknown>[] {
  return Array.isArray(list)
    ? list.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    : [];
}
