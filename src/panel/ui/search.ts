// Find and replace: CodeMirror's search, with a panel of our own drawn like VS Code's find
// widget at the top right of the editor, under the toolbar.
//
// Commands: `find` opens it (and focuses the find field); `replace` opens it with the
// replace row showing. Rich view has find only: no replace row and no button to show one.
//
// A match inside hidden marks: in Rich editor the match becomes the selection, so the
// normal reveal rule shows the marks around it. In Rich view nothing reveals, so the line is
// scrolled to and the nearest visible text is highlighted (`tm-find-near`); a table's cell,
// which never reveals, does the same in both views (`whenHidden`, render/inlineDom.ts).

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search as searchState,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type SelectionRange,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type Panel,
  type ViewUpdate,
} from '@codemirror/view';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { getMode } from '../modes';
import { markSources, type MarkSource } from '../render/framework';
import { nearestVisible, NEAR_WINDOW, type Covered } from '../render/inlineDom';
import { closeDiagramView } from './diagramView';
import { iconButton } from './dom';
import { keyMatches, keyName } from './keys';

// ---------------------------------------------------------------------------
// Counting (pure; tested headless)

/** Matches past this many are not counted; the label then reads "9999+". */
export const COUNT_LIMIT = 9999;

interface MatchList {
  starts: number[];
  ends: number[];
  /** True when counting stopped at the limit. */
  capped: boolean;
}

const NO_MATCHES: MatchList = { starts: [], ends: [], capped: false };

/** Every match of `query` in `state`, up to COUNT_LIMIT. Nothing for an empty or invalid query. */
export function listMatches(state: EditorState, query: SearchQuery): MatchList {
  if (!query.valid) return NO_MATCHES;
  const starts: number[] = [];
  const ends: number[] = [];
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (starts.length >= COUNT_LIMIT) return { starts, ends, capped: true };
    starts.push(next.value.from);
    ends.push(next.value.to);
  }
  return { starts, ends, capped: false };
}

/** The 1-based number of the match the selection is exactly on, or 0 when it is on none. */
export function currentMatch(list: MatchList, selection: SelectionRange): number {
  const { starts, ends } = list;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! < selection.from) lo = mid + 1;
    else hi = mid - 1;
  }
  // Zero-length matches can share a start; look along the run that starts here.
  for (let i = lo; i < starts.length && starts[i] === selection.from; i++) if (ends[i] === selection.to) return i + 1;
  return 0;
}

/** What the count shows: "3 of 12", "? of 12" when the selection is on no match, "No results", or nothing. */
export function countLabel(query: SearchQuery, list: MatchList, current: number): string {
  if (!query.search) return '';
  if (!query.valid) return 'Invalid expression';
  const total = list.starts.length;
  if (total === 0) return 'No results';
  const of = `${total}${list.capped ? '+' : ''}`;
  return `${current > 0 ? current : '?'} of ${of}`;
}

/** The first match at or after `pos`, wrapping to the start of the document. */
export function matchFrom(state: EditorState, query: SearchQuery, pos: number): { from: number; to: number } | null {
  if (!query.valid) return null;
  let next = query.getCursor(state, pos).next();
  if (next.done && pos > 0) next = query.getCursor(state, 0, pos).next();
  return next.done ? null : { from: next.value.from, to: next.value.to };
}

export function withQuery(
  query: SearchQuery,
  change: Partial<Pick<SearchQuery, 'search' | 'caseSensitive' | 'wholeWord' | 'regexp' | 'replace'>>,
): SearchQuery {
  return new SearchQuery({
    search: change.search ?? query.search,
    caseSensitive: change.caseSensitive ?? query.caseSensitive,
    wholeWord: change.wholeWord ?? query.wholeWord,
    regexp: change.regexp ?? query.regexp,
    replace: change.replace ?? query.replace,
    literal: query.literal,
  });
}

// ---------------------------------------------------------------------------
// Whether the replace row is showing (held in the state so a command can set it)

const setReplaceOpen = StateEffect.define<boolean>();

const replaceOpenField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setReplaceOpen)) value = effect.value;
    return value;
  },
});

/** Replace is offered only in Rich editor on a document that can be changed. */
function canReplace(state: EditorState): boolean {
  return getMode(state) === 'edit' && !state.readOnly;
}

function replaceShowing(state: EditorState): boolean {
  return canReplace(state) && state.field(replaceOpenField, false) === true;
}

// ---------------------------------------------------------------------------
// Scrolling to a match: the nearest edge when it is already on screen, the middle otherwise
// (as VS Code does)

function scrollToMatch(range: SelectionRange, view: EditorView): StateEffect<unknown> {
  let onScreen = false;
  try {
    const rect = view.scrollDOM.getBoundingClientRect();
    const top = view.documentTop + view.lineBlockAt(range.from).top;
    const bottom = view.documentTop + view.lineBlockAt(range.to).bottom;
    onScreen = top >= rect.top && bottom <= rect.bottom;
  } catch {
    onScreen = false;
  }
  return EditorView.scrollIntoView(range, onScreen ? { y: 'nearest', yMargin: 24 } : { y: 'center' });
}

// ---------------------------------------------------------------------------
// The panel

type ToggleName = 'caseSensitive' | 'wholeWord' | 'regexp';

const TOGGLES: readonly ToggleName[] = ['caseSensitive', 'wholeWord', 'regexp'];

/**
 * The find box's keys, as VS Code's find widget binds them. On a Mac the option toggles and
 * Replace All take Option with Cmd, so Option with a letter still types its character.
 */
const FIND_KEYS = {
  caseSensitive: { key: 'alt+c', mac: 'alt+cmd+c' },
  wholeWord: { key: 'alt+w', mac: 'alt+cmd+w' },
  regexp: { key: 'alt+r', mac: 'alt+cmd+r' },
  next: { key: 'enter' },
  previous: { key: 'shift+enter' },
  close: { key: 'escape' },
  replace: { key: 'enter' },
  replaceAll: { key: 'ctrl+alt+enter', mac: 'alt+cmd+enter' },
};

const panels = new WeakMap<EditorView, FindPanel>();

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly findField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly replaceToggle: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly toggles: Record<ToggleName, HTMLButtonElement>;
  private readonly stepButtons: HTMLButtonElement[];
  private readonly replaceButtons: HTMLButtonElement[];
  private query: SearchQuery;
  private matches: MatchList = NO_MATCHES;
  private focusOnMount: 'find' | 'replace' = 'find';

  constructor(private readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    this.query = getSearchQuery(view.state);

    this.dom = doc.createElement('div');
    this.dom.className = 'tm-find';
    this.dom.setAttribute('role', 'dialog');
    this.dom.setAttribute('aria-label', 'Find');

    this.replaceToggle = iconButton(doc, {
      icon: 'chevron-right',
      label: 'Toggle Replace',
      className: 'tm-find-expand',
      keepFocus: true,
    });
    this.replaceToggle.addEventListener('click', () => {
      const open = !replaceShowing(this.view.state);
      this.view.dispatch({ effects: setReplaceOpen.of(open) });
      (open ? this.replaceField : this.findField).focus();
    });

    // Find row. A plain text field, so its own Ctrl+Z works (the page reports that a field has
    // focus, and the host sends Ctrl+Z to the field); `syncFields` sets its value only when the
    // query really changed, so typing keeps its undo history.
    this.findField = doc.createElement('input');
    this.findField.type = 'text';
    this.findField.className = 'tm-find-field';
    this.findField.placeholder = 'Find';
    this.findField.setAttribute('aria-label', 'Find');
    this.findField.setAttribute('main-field', 'true');
    this.findField.spellcheck = false;
    this.findField.value = this.query.search;
    this.findField.addEventListener('input', () => this.typedSearch());

    this.toggles = {
      caseSensitive: this.toggle(doc, 'case-sensitive', 'Match Case', 'caseSensitive'),
      wholeWord: this.toggle(doc, 'whole-word', 'Match Whole Word', 'wholeWord'),
      regexp: this.toggle(doc, 'regex', 'Use Regular Expression', 'regexp'),
    };

    const findBox = doc.createElement('div');
    findBox.className = 'tm-find-box';
    findBox.append(this.findField, this.toggles.caseSensitive, this.toggles.wholeWord, this.toggles.regexp);

    this.count = doc.createElement('span');
    this.count.className = 'tm-find-count';

    const previous = iconButton(doc, {
      icon: 'arrow-up',
      label: `Previous Match (${keyName(FIND_KEYS.previous)})`,
      className: 'tm-find-action',
      keepFocus: true,
    });
    previous.addEventListener('click', () => this.step(-1));
    const next = iconButton(doc, {
      icon: 'arrow-down',
      label: `Next Match (${keyName(FIND_KEYS.next)})`,
      className: 'tm-find-action',
      keepFocus: true,
    });
    next.addEventListener('click', () => this.step(1));
    const close = iconButton(doc, {
      icon: 'close',
      label: `Close (${keyName(FIND_KEYS.close)})`,
      className: 'tm-find-action tm-find-close',
      keepFocus: true,
    });
    close.addEventListener('click', () => closeSearchPanel(this.view));
    this.stepButtons = [previous, next];

    const findRow = doc.createElement('div');
    findRow.className = 'tm-find-row';
    findRow.append(findBox, this.count, previous, next, close);

    // Replace row
    this.replaceField = doc.createElement('input');
    this.replaceField.type = 'text';
    this.replaceField.className = 'tm-replace-field';
    this.replaceField.placeholder = 'Replace';
    this.replaceField.setAttribute('aria-label', 'Replace');
    this.replaceField.spellcheck = false;
    this.replaceField.value = this.query.replace;
    this.replaceField.addEventListener('input', () =>
      this.commit(withQuery(this.query, { replace: this.replaceField.value })),
    );

    const replaceBox = doc.createElement('div');
    replaceBox.className = 'tm-find-box';
    replaceBox.append(this.replaceField);

    const replaceOne = iconButton(doc, {
      icon: 'replace',
      label: `Replace (${keyName(FIND_KEYS.replace)})`,
      className: 'tm-find-action',
      keepFocus: true,
    });
    replaceOne.addEventListener('click', () => this.replaceOne());
    const replaceEvery = iconButton(doc, {
      icon: 'replace-all',
      label: `Replace All (${keyName(FIND_KEYS.replaceAll)})`,
      className: 'tm-find-action',
      keepFocus: true,
    });
    replaceEvery.addEventListener('click', () => this.replaceEvery());
    this.replaceButtons = [replaceOne, replaceEvery];

    this.replaceRow = doc.createElement('div');
    this.replaceRow.className = 'tm-find-row tm-replace-row';
    this.replaceRow.append(replaceBox, replaceOne, replaceEvery);

    const rows = doc.createElement('div');
    rows.className = 'tm-find-rows';
    rows.append(findRow, this.replaceRow);

    this.dom.append(this.replaceToggle, rows);
    this.dom.addEventListener('keydown', (event) => this.keydown(event));

    panels.set(view, this);
    this.syncToggles();
    this.syncReplace(view.state);
    this.recount(view.state);
  }

  mount(): void {
    this.focus(this.focusOnMount);
  }

  update(update: ViewUpdate): void {
    const query = getSearchQuery(update.state);
    const queryChanged = !query.eq(this.query);
    if (queryChanged) {
      this.query = query;
      this.syncFields();
    }
    if (queryChanged || update.docChanged) this.recount(update.state);
    else if (update.selectionSet) this.showCount(update.state);
    if (
      getMode(update.startState) !== getMode(update.state) ||
      update.startState.readOnly !== update.state.readOnly ||
      update.startState.field(replaceOpenField, false) !== update.state.field(replaceOpenField, false)
    ) {
      this.syncReplace(update.state);
    }
  }

  destroy(): void {
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  /** Puts focus in the find field (all of it selected), or in the replace field when it shows. */
  focus(which: 'find' | 'replace'): void {
    const field = which === 'replace' && replaceShowing(this.view.state) ? this.replaceField : this.findField;
    if (!field.isConnected) {
      this.focusOnMount = which;
      return;
    }
    field.focus();
    field.select();
  }

  private toggle(doc: Document, iconName: string, label: string, name: ToggleName): HTMLButtonElement {
    const button = iconButton(doc, {
      icon: iconName,
      label: `${label} (${keyName(FIND_KEYS[name])})`,
      className: 'tm-find-option',
      keepFocus: true,
    });
    button.addEventListener('click', () => this.flip(name));
    return button;
  }

  private flip(name: ToggleName): void {
    const change: Partial<Record<ToggleName, boolean>> = {};
    change[name] = !this.query[name];
    this.commit(withQuery(this.query, change));
    this.searchFromSelection();
  }

  /** Sends a new query to the state when it differs. `update` then takes it in and counts. */
  private commit(query: SearchQuery): void {
    if (query.eq(this.query)) return;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  /** Typing in the find field: search again and move to the first match from the selection's start. */
  private typedSearch(): void {
    this.commit(withQuery(this.query, { search: this.findField.value }));
    this.searchFromSelection();
  }

  private searchFromSelection(): void {
    const { state } = this.view;
    const match = matchFrom(state, this.query, state.selection.main.from);
    if (!match) return;
    const main = state.selection.main;
    if (state.selection.ranges.length === 1 && main.from === match.from && main.to === match.to) return;
    const selection = EditorSelection.single(match.from, match.to);
    this.view.dispatch({ selection, effects: scrollToMatch(selection.main, this.view), userEvent: 'select.search' });
  }

  /** Next (1) or previous (-1) match. CodeMirror selects the field's text after a step; put the caret back. */
  private step(direction: 1 | -1): void {
    const field = this.findField;
    const focused = field.ownerDocument.activeElement === field;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const direct = field.selectionDirection ?? undefined;
    (direction > 0 ? findNext : findPrevious)(this.view);
    if (focused && start !== null && end !== null) field.setSelectionRange(start, end, direct);
  }

  /**
   * CodeMirror's replace commands give `input.replace` and `input.replace.all`: not typing, so
   * each is sent to the document at once, and Replace all is one change.
   */
  private replaceOne(): void {
    if (!canReplace(this.view.state)) return;
    replaceNext(this.view);
  }

  private replaceEvery(): void {
    if (!canReplace(this.view.state)) return;
    replaceAll(this.view);
  }

  /**
   * Keys inside the panel (`FIND_KEYS`): Enter and Shift+Enter (and F3, Shift+F3) step through
   * the matches; Escape closes it and puts focus back in the editor; the toggle keys switch
   * match case, whole word and regular expression; Enter in the replace field replaces the
   * current match, and the Replace All key replaces every one.
   */
  private keydown(event: KeyboardEvent): void {
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(this.view);
      return;
    }
    if (keyMatches(event, FIND_KEYS.replaceAll)) {
      event.preventDefault();
      this.replaceEvery();
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      if (event.target === this.replaceField) this.replaceOne();
      else this.step(event.shiftKey ? -1 : 1);
      return;
    }
    if (key === 'F3') {
      event.preventDefault();
      this.step(event.shiftKey ? -1 : 1);
      return;
    }
    const toggle = TOGGLES.find((name) => keyMatches(event, FIND_KEYS[name]));
    if (toggle) {
      event.preventDefault();
      this.flip(toggle);
    }
  }

  /** Brings the fields and toggles in line with a query that changed from outside. */
  private syncFields(): void {
    if (this.findField.value !== this.query.search) this.findField.value = this.query.search;
    if (this.replaceField.value !== this.query.replace) this.replaceField.value = this.query.replace;
    this.syncToggles();
  }

  private syncToggles(): void {
    for (const name of Object.keys(this.toggles) as ToggleName[]) {
      const on = this.query[name];
      const button = this.toggles[name];
      button.classList.toggle('tm-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  private syncReplace(state: EditorState): void {
    const offered = canReplace(state);
    const showing = replaceShowing(state);
    this.replaceToggle.hidden = !offered;
    this.replaceRow.hidden = !showing;
    this.dom.classList.toggle('tm-find-replacing', showing);
    this.dom.classList.toggle('tm-find-view', !offered);
    this.replaceToggle.setAttribute('aria-expanded', showing ? 'true' : 'false');
    const chevron = this.replaceToggle.firstElementChild;
    if (chevron) chevron.className = `codicon codicon-${showing ? 'chevron-down' : 'chevron-right'}`;
    this.dom.setAttribute('aria-label', showing ? 'Find and replace' : 'Find');
    if (!showing && this.replaceField.ownerDocument.activeElement === this.replaceField) this.findField.focus();
  }

  private recount(state: EditorState): void {
    try {
      this.matches = listMatches(state, this.query);
    } catch (error) {
      this.matches = NO_MATCHES;
      state.facet(panelContext)?.log('warn', 'Find could not count the matches', error);
    }
    this.showCount(state);
  }

  private showCount(state: EditorState): void {
    const current = currentMatch(this.matches, state.selection.main);
    this.count.textContent = countLabel(this.query, this.matches, current);
    const none = !!this.query.search && (!this.query.valid || this.matches.starts.length === 0);
    this.dom.classList.toggle('tm-find-none', none);
    this.dom.classList.toggle('tm-find-invalid', !!this.query.search && !this.query.valid);
    this.findField.title = this.query.search && !this.query.valid ? invalidReason(this.query.search) : '';
    const total = this.matches.starts.length;
    for (const button of this.stepButtons) button.disabled = total === 0;
    for (const button of this.replaceButtons) button.disabled = total === 0 || !canReplace(state);
  }
}

function invalidReason(pattern: string): string {
  try {
    new RegExp(pattern, 'u');
    return 'This regular expression is not valid.';
  } catch (error) {
    return error instanceof Error ? error.message : 'This regular expression is not valid.';
  }
}

// ---------------------------------------------------------------------------
// Opening, the commands

function openFind(view: EditorView, withReplace: boolean): boolean {
  closeDiagramView(view);
  const state = view.state;
  const before = getSearchQuery(state);
  const wasOpen = searchPanelOpen(state);
  const wantReplace = withReplace && canReplace(state);
  // `find` on a closed panel opens it without the replace row; on an open panel it leaves
  // the row as it is. `replace` shows the row.
  if (wantReplace || !wasOpen) view.dispatch({ effects: setReplaceOpen.of(wantReplace) });
  openSearchPanel(view);
  // CodeMirror fills the field from the selection. A selection over several lines cannot
  // be shown in a one-line field, so keep the earlier search then.
  const now = getSearchQuery(view.state);
  if (!now.regexp && /[\r\n]/.test(now.search))
    view.dispatch({ effects: setSearchQuery.of(withQuery(now, { search: before.search })) });
  const panel = panels.get(view);
  const which = wantReplace && getSearchQuery(view.state).search ? 'replace' : 'find';
  panel?.focus(which);
  return true;
}

// ---------------------------------------------------------------------------
// Matches in text drawn outside the lines

/** What marks the visible text nearest the current match when the match is hidden. */
const NEAR_CLASS = 'tm-find-near';

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const selectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected', whenHidden: NEAR_CLASS });

/**
 * Find's matches over [from, to] as CodeMirror marks them in a line, the one the selection
 * holds marked as selected: for a table's cells, which CodeMirror's own highlighter does not
 * reach. At most COUNT_LIMIT.
 */
const findMarks: MarkSource = {
  marks(state, from, to) {
    const query = getSearchQuery(state);
    if (!searchPanelOpen(state) || !query.valid) return Decoration.none;
    const main = state.selection.main;
    const ranges: Range<Decoration>[] = [];
    const cursor = query.getCursor(state, from, to);
    for (let next = cursor.next(); !next.done && ranges.length < COUNT_LIMIT; next = cursor.next()) {
      const match = next.value;
      if (match.to <= match.from) continue;
      const selected = match.from === main.from && match.to === main.to;
      ranges.push((selected ? selectedMatchMark : matchMark).range(match.from, match.to));
    }
    return Decoration.set(ranges);
  },
  changed(tr) {
    const open = searchPanelOpen(tr.state);
    return (
      open !== searchPanelOpen(tr.startState) ||
      (open &&
        (getSearchQuery(tr.state) !== getSearchQuery(tr.startState) ||
          !tr.state.selection.main.eq(tr.startState.selection.main)))
    );
  },
};

// ---------------------------------------------------------------------------
// Rich view: highlight the visible text nearest a match that is hidden

const nearMark = Decoration.mark({ class: NEAR_CLASS });

/** What every feature hides or replaces near [from, to], read from the editor's atomic ranges. */
function coveredNear(view: EditorView, from: number, to: number): Covered[] {
  const winFrom = Math.max(0, from - NEAR_WINDOW);
  const winTo = Math.min(view.state.doc.length, to + NEAR_WINDOW);
  const out: Covered[] = [];
  for (const get of view.state.facet(EditorView.atomicRanges)) {
    get(view).between(winFrom, winTo, (f, t, value) => {
      out.push({ from: f, to: t, widget: !!value.spec.widget });
    });
  }
  return out;
}

const nearMatch = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private failed = false;
    constructor(view: EditorView) {
      this.decorations = this.compute(view);
    }
    update(update: ViewUpdate): void {
      if (
        update.selectionSet ||
        update.docChanged ||
        update.viewportChanged ||
        getMode(update.startState) !== getMode(update.state) ||
        searchPanelOpen(update.startState) !== searchPanelOpen(update.state)
      ) {
        this.decorations = this.compute(update.view);
      }
    }
    compute(view: EditorView): DecorationSet {
      const state = view.state;
      if (this.failed || getMode(state) !== 'view' || !searchPanelOpen(state)) return Decoration.none;
      const main = state.selection.main;
      if (main.empty) return Decoration.none;
      try {
        const near = nearestVisible(state.doc, coveredNear(view, main.from, main.to), main.from, main.to);
        return near ? Decoration.set([nearMark.range(near.from, near.to)]) : Decoration.none;
      } catch (error) {
        this.failed = true;
        state.facet(panelContext)?.log('error', 'Find could not mark the text nearest a hidden match', error);
        return Decoration.none;
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ---------------------------------------------------------------------------
// Look: VS Code's find widget, from VS Code's theme variables

const theme = EditorView.baseTheme({
  // The panel floats over the top right of the text, as VS Code's does, clear of the scrollbar.
  '& .cm-panels.cm-panels-top:has(> .tm-find)': {
    position: 'absolute',
    top: '0',
    left: 'auto',
    right: '18px',
    maxWidth: 'calc(100% - 36px)',
    background: 'transparent',
    border: 'none',
    color: 'inherit',
  },
  '& .tm-find': {
    display: 'flex',
    alignItems: 'stretch',
    boxSizing: 'border-box',
    padding: '4px 4px 4px 0',
    background: 'var(--vscode-editorWidget-background, var(--tm-widget-bg))',
    color: 'var(--vscode-editorWidget-foreground, var(--tm-widget-fg))',
    boxShadow: '0 0 8px 2px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36))',
    borderBottomLeftRadius: '4px',
    borderBottomRightRadius: '4px',
    fontFamily: 'var(--tm-ui-font)',
    fontSize: 'var(--tm-ui-font-size)',
    lineHeight: '1.4',
  },
  '& .tm-find.tm-find-view': { paddingLeft: '4px' },
  '& .tm-find-rows': { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' },
  '& .tm-find-row': { display: 'flex', alignItems: 'center', gap: '2px' },
  '& .tm-find-row[hidden]': { display: 'none' },
  '& .tm-find-box': {
    display: 'flex',
    alignItems: 'center',
    width: '260px',
    maxWidth: '50vw',
    boxSizing: 'border-box',
    height: '26px',
    padding: '0 2px 0 0',
    background: 'var(--vscode-input-background, var(--tm-bg))',
    color: 'var(--vscode-input-foreground, var(--tm-fg))',
    border: '1px solid var(--vscode-input-border, var(--tm-border))',
    borderRadius: '2px',
  },
  '& .tm-find-box:focus-within': { borderColor: 'var(--tm-focus)' },
  '& .tm-find-invalid .tm-find-row:first-child .tm-find-box': {
    borderColor: 'var(--vscode-inputValidation-errorBorder, var(--tm-error))',
  },
  '& .tm-find-field, & .tm-replace-field': {
    flex: '1 1 auto',
    minWidth: '0',
    height: '100%',
    boxSizing: 'border-box',
    padding: '0 6px',
    margin: '0',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  },
  '& .tm-find-field::placeholder, & .tm-replace-field::placeholder': {
    color: 'var(--vscode-input-placeholderForeground, var(--tm-faded))',
  },
  '& .tm-find-option, & .tm-find-action, & .tm-find-expand': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    padding: '0',
    margin: '0',
    border: '1px solid transparent',
    borderRadius: '3px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  '& .tm-find-option': { width: '22px', height: '20px', flex: '0 0 auto' },
  '& .tm-find-action': { width: '24px', height: '24px', flex: '0 0 auto' },
  '& .tm-find-expand': { width: '18px', alignSelf: 'stretch', marginRight: '2px', borderRadius: '0' },
  '& .tm-find-expand[hidden]': { display: 'none' },
  '& .tm-find-option:hover, & .tm-find-action:hover:not(:disabled), & .tm-find-expand:hover': {
    background: 'var(--vscode-toolbar-hoverBackground, var(--tm-button2-bg))',
  },
  '& .tm-find-option.tm-on': {
    background: 'var(--vscode-inputOption-activeBackground, color-mix(in srgb, var(--tm-focus) 35%, transparent))',
    borderColor: 'var(--vscode-inputOption-activeBorder, var(--tm-focus))',
    color: 'var(--vscode-inputOption-activeForeground, inherit)',
  },
  '& .tm-find-action:disabled': { opacity: '0.4', cursor: 'default' },
  '& .tm-find-option:focus-visible, & .tm-find-action:focus-visible, & .tm-find-expand:focus-visible': {
    outline: '1px solid var(--tm-focus)',
    outlineOffset: '-1px',
  },
  '& .tm-find-count': {
    minWidth: '72px',
    padding: '0 6px',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    color: 'var(--tm-faded)',
  },
  '& .tm-find-none .tm-find-count': { color: 'var(--vscode-errorForeground, var(--tm-error))' },
  '& .tm-find .codicon': { fontSize: '16px' },

  // Matches in the text: VS Code's find match colors.
  '& .cm-content .cm-searchMatch': {
    backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.3))',
    outline: '1px solid var(--vscode-editor-findMatchHighlightBorder, transparent)',
  },
  '& .cm-content .cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--vscode-editor-findMatchBackground, rgba(255, 170, 60, 0.6))',
    outline: '1px solid var(--vscode-editor-findMatchBorder, transparent)',
  },
  '& .cm-content .tm-find-near': {
    backgroundColor: 'var(--vscode-editor-findMatchBackground, rgba(255, 170, 60, 0.6))',
    outline: '1px dashed var(--vscode-editor-findMatchBorder, var(--tm-faded))',
    borderRadius: '2px',
  },
});

// ---------------------------------------------------------------------------
// The feature

export const search: Feature = {
  id: 'search',
  extension: (): Extension => [
    searchState({ top: true, literal: true, createPanel: (view) => new FindPanel(view), scrollToMatch }),
    replaceOpenField,
    // Above the base keymap, whose Escape collapses the selection (the match) and would win.
    Prec.high(keymap.of([{ key: 'Escape', run: closeSearchPanel }])),
    nearMatch,
    markSources.of(findMarks),
    theme,
  ],
  commands: {
    find: (view) => openFind(view, false),
    replace: (view) => openFind(view, true),
  },
};
