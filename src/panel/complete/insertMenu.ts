// The insert menu: what the Rich editor can insert, in the editor's completion list. A `/` typed
// at the start of a line or after a space opens it, and so does the toolbar's Insert button
// (`openInsertMenu`), with nothing typed. Typing narrows it to the entries with a word, in the
// label or among the other words it is found by, that starts with what was typed; it closes when
// none has. Enter or a click inserts the entry in place of the `/` and what was typed after it;
// Escape closes it and leaves them. Not offered in code, a table, front matter or Rich view.
//
// A heading, list, task or quote entry makes the line it is typed on one, unless it is one
// already (a heading entry sets the level); another block goes on its own line below, or in place
// of a blank line; an inline entry goes where the `/` was. An entry for an optional syntax is
// offered only while that syntax is on. No entry writes HTML.

import {
  autocompletion,
  currentCompletions,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { isSpaceOrTab } from '../../core/markdownText';
import { LETTER_OR_DIGIT } from '../../core/wordChars';
import { headingChanges, insertCodeBlock, insertRule, toggleQuote } from '../commands/blocks';
import { emptyPair, insertPair, type PairMember } from '../commands/inline';
import { columnOf, lineInfo, markerOf, type LineMarks, type ListKind } from '../commands/lineInfo';
import { newItemMarker, toggleBulletList, toggleNumberedList, toggleTaskList } from '../commands/lists';
import { blockAtLine, lineOfItsOwn } from '../commands/placeBlock';
import { runCommand, type PanelCommand } from '../commands/registry';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { footnoteLabel } from '../links/footnotes';
import { codeAt, treeFor, treeForLine } from '../markdown/tree';
import { canEdit } from '../modes';
import { calloutIcon } from '../render/callouts';
import { syntaxOn, type SyntaxId } from '../syntax';
import { openWhenDrawn } from '../tables/commands';
import { newTable } from '../tables/edits';
import {
  BOLD,
  BULLET_LIST,
  CODE_BLOCK,
  IMAGE,
  INLINE_CODE,
  ITALIC,
  LINK,
  NUMBERED_LIST,
  QUOTE,
  RULE,
  STRIKETHROUGH,
  TABLE,
  TASK_LIST,
  type Action,
} from '../ui/actions';
import { icon } from '../ui/dom';

/** What an entry does once the text typed for the menu is taken away: the change, and what follows it in the editor. */
interface Insertion {
  /** The change, on the state with the typed text taken away; null when taking it away is all. */
  tr: Transaction | null;
  /** What happens next in the editor: a table's first cell opened, a picture chosen. */
  then?: (view: EditorView) => void;
}

interface Entry {
  label: string;
  /** The markdown it writes, shown faint at the right of its row. */
  hint: string;
  /** A codicon; ui/actions.ts holds the ones the toolbar shows too. */
  icon: string;
  also: readonly string[];
  /**
   * `line` changes the line it is typed on, `block` adds a block of its own, `inline` goes where
   * the `/` was. A line or block entry also takes away the spaces before the `/` that would be
   * left at the end of the line.
   */
  place: 'line' | 'block' | 'inline';
  syntax?: SyntaxId;
  /** Extra visibility guard beyond `syntax` being enabled. */
  offered?(state: EditorState): boolean;
  insert(state: EditorState): Insertion;
}

// ---------------------------------------------------------------------------
// What the entries write

function cursorLine(state: EditorState): { tree: Tree; info: LineMarks } {
  const line = state.doc.lineAt(state.selection.main.head);
  const tree = treeForLine(state, line.from);
  return { tree, info: lineInfo(state, tree, line) };
}

/**
 * `marks` put at the start of a blank line's text, the cursor after them; on a line with text,
 * `change` makes it a line of the kind, the cursor where the `/` was.
 */
function lineEntry(
  state: EditorState,
  marks: (info: LineMarks, tree: Tree) => string,
  change: (state: EditorState, info: LineMarks, tree: Tree) => Transaction | null,
): Insertion {
  const { tree, info } = cursorLine(state);
  const head = state.selection.main.head;
  if (info.blank) {
    const insert = marks(info, tree);
    return {
      tr: state.update({
        changes: { from: info.textFrom, insert },
        selection: EditorSelection.cursor(info.textFrom + insert.length),
      }),
    };
  }
  const tr = change(state, info, tree);
  if (!tr) return { tr: null };
  return { tr: state.update({ changes: tr.changes, selection: EditorSelection.cursor(tr.changes.mapPos(head, 1)) }) };
}

function heading(level: number): Entry {
  return {
    label: `Heading ${level}`,
    hint: '#'.repeat(level),
    icon: 'text-size',
    also: [`h${level}`],
    place: 'line',
    insert: (state) =>
      lineEntry(
        state,
        () => `${'#'.repeat(level)} `,
        (s, info, tree) => {
          const changes = headingChanges(s, tree, [info], () => level);
          return changes.length ? s.update({ changes }) : null;
        },
      ),
  };
}

const TOGGLES = { bullet: toggleBulletList, ordered: toggleNumberedList, task: toggleTaskList };

function list(kind: ListKind, action: Action, hint: string, also: string[]): Entry {
  return {
    ...action,
    hint,
    also,
    place: 'line',
    insert: (state) =>
      lineEntry(
        state,
        (info, tree) => newItemMarker(state, tree, info.line, columnOf(state, info.textFrom), kind),
        (s, info, tree) => {
          const marker = info.marker ?? (info.owner ? markerOf(s, tree, info.owner) : null);
          return marker?.kind === kind ? null : TOGGLES[kind](s);
        },
      ),
  };
}

const QUOTE_ENTRY: Entry = {
  ...QUOTE,
  hint: '>',
  also: ['blockquote'],
  place: 'line',
  insert: (state) => (cursorLine(state).info.inQuote ? { tr: null } : lineEntry(state, () => '> ', toggleQuote)),
};

function lines(text: readonly string[], cursor: { line: number; column: number }): (state: EditorState) => Insertion {
  return (state) => ({ tr: blockAtLine(state, text, cursor) });
}

function callout(type: string, label: string): Entry {
  return {
    label,
    hint: `> [!${type}]`,
    icon: calloutIcon(type.toLowerCase()),
    also: ['alert', 'admonition'],
    place: 'block',
    syntax: 'callouts',
    insert: lines([`> [!${type}]`, '> '], { line: 1, column: 2 }),
  };
}

function pair(action: Action, hint: string, also: string[], member: PairMember): Entry {
  return {
    ...action,
    hint,
    also,
    place: 'inline',
    insert: (state) => ({ tr: state.update(insertPair(state, state.selection.main.head, member)) }),
  };
}

/**
 * A footnote: `[^n]` at the cursor, n one past the highest number a footnote's label has in the
 * note, and its definition at the end of the note after a blank line, the cursor there.
 */
function insertFootnote(state: EditorState): Insertion {
  const doc = state.doc;
  let highest = 0;
  treeFor(state, doc.length).iterate({
    enter: (ref) => {
      if (ref.name !== 'FootnoteRef' && ref.name !== 'FootnoteLabel') return;
      const label = footnoteLabel(doc, ref.node);
      if (/^\d+$/.test(label)) highest = Math.max(highest, Number(label));
    },
  });
  const reference = `[^${highest + 1}]`;
  const ending = /\n{0,2}$/.exec(doc.sliceString(Math.max(0, doc.length - 2)))![0].length;
  const definition = `${'\n'.repeat(Math.max(0, 2 - ending))}${reference}: `;
  // The note keeps a final line break where it had one.
  const insert = ending > 0 ? `${definition}\n` : definition;
  const pos = state.selection.main.head;
  return {
    tr: state.update({
      changes: [
        { from: pos, insert: reference },
        { from: doc.length, insert },
      ],
      selection: EditorSelection.cursor(doc.length + reference.length + definition.length),
    }),
  };
}

function hasFrontmatter(state: EditorState): boolean {
  return treeFor(state, 1).topNode.firstChild?.name === 'Frontmatter';
}

function insertFrontmatter(state: EditorState): Insertion {
  const insert = state.doc.length ? '---\n\n---\n' : '---\n\n---';
  return {
    tr: state.update({ changes: { from: 0, insert }, selection: EditorSelection.cursor(4) }),
  };
}

/** The pair inline math leaves at a cursor, gone again when the cursor leaves it with nothing typed. */
const MATH_PAIR: PairMember = { id: 'math', open: '$', close: '$' };

const ENTRIES: readonly Entry[] = [
  heading(1),
  heading(2),
  heading(3),
  heading(4),
  heading(5),
  heading(6),
  list('bullet', BULLET_LIST, '-', ['ul', 'unordered']),
  list('ordered', NUMBERED_LIST, '1.', ['ol', 'ordered']),
  list('task', TASK_LIST, '- [ ]', ['todo', 'checkbox']),
  QUOTE_ENTRY,
  callout('NOTE', 'Note callout'),
  callout('TIP', 'Tip callout'),
  callout('IMPORTANT', 'Important callout'),
  callout('WARNING', 'Warning callout'),
  callout('CAUTION', 'Caution callout'),
  {
    ...CODE_BLOCK,
    hint: '```',
    also: ['fence'],
    place: 'block',
    insert: (state) => ({ tr: insertCodeBlock(state) }),
  },
  {
    label: 'Mermaid diagram',
    hint: '```mermaid',
    icon: 'type-hierarchy',
    also: ['flowchart', 'chart', 'graph'],
    place: 'block',
    syntax: 'mermaid',
    // Two boxes, so that a diagram draws at once rather than Mermaid's message for an empty one.
    insert: lines(['```mermaid', 'flowchart LR', '    A --> B', '```'], { line: 2, column: 11 }),
  },
  {
    label: 'Math block',
    hint: '$$',
    icon: 'symbol-operator',
    also: ['math', 'equation', 'latex'],
    place: 'block',
    syntax: 'math',
    insert: lines(['$$', '', '$$'], { line: 1, column: 0 }),
  },
  {
    ...TABLE,
    hint: '| --- |',
    also: ['grid'],
    place: 'block',
    insert: (state) => {
      const plan = newTable(state);
      return {
        tr: state.update({ changes: plan.changes, selection: EditorSelection.cursor(plan.cursor) }),
        then: (view) => openWhenDrawn(view, plan.tableFrom),
      };
    },
  },
  {
    ...IMAGE,
    hint: '![]()',
    also: ['picture', 'photo'],
    place: 'inline',
    insert: () => ({ tr: null, then: (view) => void runCommand(view, 'insertImage') }),
  },
  pair(LINK, '[]()', ['url'], emptyPair('link')),
  {
    label: 'Footnote',
    hint: '[^1]',
    icon: 'note',
    also: ['reference'],
    place: 'inline',
    syntax: 'footnotes',
    insert: insertFootnote,
  },
  {
    ...pair({ label: 'Inline math', icon: 'symbol-operator' }, '$', ['math', 'equation'], MATH_PAIR),
    syntax: 'math',
  },
  {
    ...RULE,
    hint: '---',
    also: ['divider', 'line', 'hr'],
    place: 'block',
    insert: (state) => ({ tr: insertRule(state) }),
  },
  {
    label: 'Contents list',
    hint: '[TOC]',
    icon: 'list-tree',
    also: ['toc', 'table of contents'],
    place: 'block',
    syntax: 'contents',
    insert: (state) => ({ tr: lineOfItsOwn(state, '[TOC]') }),
  },
  {
    label: 'Definition list',
    hint: ':',
    icon: 'symbol-key',
    also: ['term', 'glossary'],
    place: 'block',
    syntax: 'definitionLists',
    insert: lines(['', ': '], { line: 0, column: 0 }),
  },
  {
    label: 'Front matter',
    hint: '--- … ---',
    icon: 'symbol-property',
    also: ['yaml', 'properties', 'metadata'],
    place: 'block',
    offered: (state) => !hasFrontmatter(state),
    insert: insertFrontmatter,
  },
  pair(BOLD, '**', ['strong'], emptyPair('bold')),
  pair(ITALIC, '*', ['emphasis'], emptyPair('italic')),
  pair(STRIKETHROUGH, '~~', ['strike'], emptyPair('strikethrough')),
  pair(INLINE_CODE, '`', ['monospace'], emptyPair('code')),
  {
    ...pair({ label: 'Highlight', icon: 'symbol-color' }, '==', ['mark'], emptyPair('highlight')),
    syntax: 'highlight',
  },
];

// ---------------------------------------------------------------------------
// Inserting an entry

/**
 * What choosing an entry takes away, from `from` (the `/`, or where the Insert button opened the
 * menu) to `to`. A line or block entry also takes the spaces that would be left at an end of the
 * line's text: before it, when text stands before it and nothing follows; after it, when it
 * starts the line's text, so `/h1 Intro` becomes `# Intro`.
 */
function typedRange(state: EditorState, entry: Entry, from: number, to: number): { from: number; to: number } {
  if (entry.place === 'inline') return { from, to };
  const doc = state.doc;
  const line = doc.lineAt(from);
  const start = lineInfo(state, treeForLine(state, line.from), line).contentFrom;
  const spaceAt = (pos: number) => isSpaceOrTab(doc.sliceString(pos, pos + 1).charCodeAt(0));
  if (doc.sliceString(start, from).trim() === '') {
    let end = to;
    while (end < line.to && spaceAt(end)) end++;
    return { from, to: end };
  }
  if (doc.sliceString(to, line.to).trim() !== '') return { from, to };
  let at = from;
  while (at > start && spaceAt(at - 1)) at--;
  return { from: at, to };
}

/**
 * The entry labeled `label` chosen with the menu open from `from` to `to` in `state`: one
 * change that takes the typed text away and inserts the entry, with what follows in the
 * editor. Null for a label no entry has.
 */
export function insertEntry(
  state: EditorState,
  label: string,
  from: number,
  to: number,
): { spec: TransactionSpec; then?: (view: EditorView) => void } | null {
  const entry = ENTRIES.find((e) => e.label === label);
  if (!entry) return null;
  const typed = typedRange(state, entry, from, to);
  const taken = state.changes({ from: typed.from, to: typed.to });
  const cleared = state.update({ changes: taken, selection: EditorSelection.cursor(typed.from) }).state;
  const { tr, then } = entry.insert(cleared);
  return {
    spec: {
      changes: tr ? taken.compose(tr.changes) : taken,
      selection: tr ? tr.newSelection : EditorSelection.cursor(typed.from),
      effects: tr ? [...tr.effects] : [],
      userEvent: 'input.complete',
      scrollIntoView: true,
    },
    ...(then && { then }),
  };
}

// ---------------------------------------------------------------------------
// The menu

/** The longest query looked for after a `/`; a longer word matches no entry. */
const MAX_QUERY = 30;

/** What may be typed after the `/` while the menu narrows: letters and digits. */
const QUERY = new RegExp(`^[${LETTER_OR_DIGIT}]*$`, 'u');

const setAnchor = StateEffect.define<number | null>();

/** Where the Insert button opened the menu, while the cursor stays after it on its line; null otherwise. */
const anchorField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setAnchor)) return effect.value;
    if (value === null || (!tr.docChanged && !tr.selection)) return value;
    const at = tr.changes.mapPos(value, -1);
    const head = tr.newSelection.main.head;
    return head >= at && tr.newDoc.lineAt(head).from === tr.newDoc.lineAt(at).from ? at : null;
  },
});

/** Not in code (a code block, HTML, front matter, a code span or a formula), nor in a table. */
function menuAllowedAt(state: EditorState, pos: number): boolean {
  if (!canEdit(state)) return false;
  const tree = treeForLine(state, pos);
  if (codeAt(tree, pos)) return false;
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent)
    if (n.name === 'Table' || n.name === 'GridTable') return false;
  return true;
}

/** Where the menu stands and what was typed for it: after a `/`, or after where the button opened it. */
function typedAt(context: CompletionContext): { from: number; query: string } | null {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const anchor = state.field(anchorField, false);
  if (context.explicit && anchor !== null && anchor !== undefined && anchor >= line.from && anchor <= pos) {
    const query = state.sliceDoc(anchor, pos);
    if (QUERY.test(query)) return { from: anchor, query };
  }
  const before = state.sliceDoc(Math.max(line.from, pos - MAX_QUERY - 1), pos);
  const slash = before.lastIndexOf('/');
  if (slash < 0) return null;
  const at = pos - before.length + slash;
  const query = before.slice(slash + 1);
  if (!QUERY.test(query)) return null;
  if (at > line.from && !isSpaceOrTab(state.doc.sliceString(at - 1, at).charCodeAt(0))) return null;
  return { from: at, query };
}

const WORDS = new Map<Entry, string[]>(
  ENTRIES.map((e) => [e, [e.label, ...e.also].flatMap((phrase) => phrase.toLowerCase().split(' '))]),
);

function entriesFor(state: EditorState, query: string): Entry[] {
  const settings = state.facet(panelContext)?.settings;
  const lower = query.toLowerCase();
  return ENTRIES.filter(
    (e) =>
      (!e.syntax || syntaxOn(settings, e.syntax)) &&
      (!e.offered || e.offered(state)) &&
      WORDS.get(e)!.some((word) => word.startsWith(lower)),
  );
}

const OPTIONS = new Map<Entry, Completion>(
  ENTRIES.map((entry) => [
    entry,
    {
      label: entry.label,
      apply: (view: EditorView, completion: Completion, from: number, to: number) => {
        const chosen = insertEntry(view.state, entry.label, from, to);
        if (!chosen) return;
        view.dispatch({ ...chosen.spec, annotations: pickedCompletion.of(completion) });
        chosen.then?.(view);
      },
    },
  ]),
);

const ENTRY_OF = new Map<Completion, Entry>([...OPTIONS].map(([entry, option]) => [option, entry]));

/** The completion source: the entries for what was typed after a `/`, or after the Insert button. */
export function insertMenuSource(context: CompletionContext): CompletionResult | null {
  const { state } = context;
  if (state.selection.ranges.length !== 1) return null;
  const typed = typedAt(context);
  if (!typed || !menuAllowedAt(state, typed.from)) return null;
  const options = entriesFor(state, typed.query).map((e) => OPTIONS.get(e)!);
  return options.length ? { from: typed.from, options, filter: false } : null;
}

/** The toolbar's Insert button: the menu at the cursor, with nothing typed. */
const openInsertMenu: PanelCommand = (view) => {
  const head = view.state.selection.main.head;
  if (!menuAllowedAt(view.state, head)) return false;
  view.dispatch({ selection: EditorSelection.cursor(head), effects: setAnchor.of(head) });
  view.focus();
  return startCompletion(view);
};

const MENU_PHRASES = { Completions: 'Insert' };
const NO_PHRASES = {};

/** The list is named "Insert" for a screen reader while it shows the menu, as the toolbar is named "Formatting". */
const listName = EditorState.phrases.compute([showTooltip], (state) => {
  const shown = currentCompletions(state);
  return shown.length > 0 && shown.every((option) => ENTRY_OF.has(option)) ? MENU_PHRASES : NO_PHRASES;
});

function optionIcon(option: Completion, _state: EditorState, view: EditorView): Node | null {
  const entry = ENTRY_OF.get(option);
  return entry ? icon(view.dom.ownerDocument, entry.icon) : null;
}

/** The markdown an entry writes, faint at the end of its row, which a screen reader would read out as symbols. */
function optionHint(option: Completion, _state: EditorState, view: EditorView): Node | null {
  const entry = ENTRY_OF.get(option);
  if (!entry) return null;
  const hint = view.dom.ownerDocument.createElement('span');
  hint.className = 'tm-insert-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = entry.hint;
  return hint;
}

export const insertMenu: Feature = {
  id: 'insertMenu',
  extension: () => [
    anchorField,
    listName,
    autocompletion({
      addToOptions: [
        { render: optionIcon, position: 20 },
        { render: optionHint, position: 80 },
      ],
      optionClass: (option) => (ENTRY_OF.has(option) ? 'tm-insert-option' : ''),
    }),
    EditorView.baseTheme({
      '& .tm-complete > ul > li.tm-insert-option': { display: 'flex', alignItems: 'center', gap: '6px' },
      '& .tm-insert-hint': {
        marginLeft: 'auto',
        paddingLeft: '24px',
        color: 'var(--tm-faded)',
        fontFamily: 'var(--tm-mono)',
        fontSize: '12px',
        whiteSpace: 'pre',
      },
    }),
  ],
  commands: { openInsertMenu },
};
