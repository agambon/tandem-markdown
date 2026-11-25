// Headless helpers for the panel's tests: a panel context with no host and no DOM, a state with
// every feature and a fully parsed tree (its selection marked in the text), a stand-in for a view,
// a panel over the real PanelSync with a host log that sends it updates, readers that turn
// decorations and tables' cells back into what a reader of the page would see, and random edits
// checked against a state read from scratch.

import { syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  RangeSet,
  Text,
  type EditorState,
  type Extension,
  type SelectionRange,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import type { Decoration, EditorView } from '@codemirror/view';
import { expect } from 'vitest';
import { stampOf } from '../../src/core/hash';
import {
  SETTING_DEFAULTS,
  type DocInfo,
  type Mode,
  type PanelSettings,
  type UpdateReason,
} from '../../src/core/protocol';
import type { Notice, PanelContext } from '../../src/panel/context';
import { createEditorState } from '../../src/panel/editor';
import { withFullTree, type InlineDrawing, type RichWidget } from '../../src/panel/render/framework';
import { PanelSync } from '../../src/panel/sync';
import { gridOf, type GridView } from '../../src/panel/tables/grid';
import { readTable } from '../../src/panel/tables/model';
import type { Rng } from '../sync/world';
import { drawHeadless } from './headless';

export const testSettings: PanelSettings = { ...SETTING_DEFAULTS, workspaceTrusted: true };

export interface FakeContext {
  ctx: PanelContext;
  logs: { level: string; message: string; detail?: unknown }[];
  notices: Notice[];
  posted: unknown[];
}

export function fakeContext(
  options: { settings?: Partial<PanelSettings> | undefined; readOnly?: boolean | undefined } = {},
): FakeContext {
  const logs: FakeContext['logs'] = [];
  const notices: Notice[] = [];
  const posted: unknown[] = [];
  const doc: DocInfo = {
    uri: 'file:///w/test.md',
    fileName: 'test.md',
    workspacePath: 'test.md',
    readOnly: options.readOnly ?? false,
  };
  const ctx: PanelContext = {
    bridge: { post: (m) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} },
    doc,
    slots: {} as PanelContext['slots'],
    settings: { ...testSettings, ...options.settings },
    onSettingsChange: () => () => {},
    request: () => Promise.reject(new Error('No host in tests')),
    notify: (notice) => notices.push(notice),
    log: (level, message, detail) => logs.push({ level, message, detail }),
    view: () => {
      throw new Error('No view in tests');
    },
    dispatch: () => {},
  };
  return { ctx, logs, notices, posted };
}

/** Splits marked text into the document and its selection ranges. */
export function parseMarked(marked: string): { doc: string; ranges: SelectionRange[] } {
  let doc = '';
  const ranges: SelectionRange[] = [];
  let anchor: number | null = null;
  let head: number | null = null;
  for (const ch of marked) {
    if (ch === '‸') ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === '«') anchor = doc.length;
    else if (ch === '»') head = doc.length;
    else doc += ch;
    if (anchor !== null && head !== null) {
      ranges.push(EditorSelection.range(anchor, head));
      anchor = head = null;
    }
  }
  if (!ranges.length) ranges.push(EditorSelection.cursor(doc.length));
  return { doc, ranges };
}

/**
 * A state with every feature, parsed to the end, its main selection written into `text` as
 * `parseMarked` reads it: `‸` a cursor, `«` and `»` a selection's anchor and head; with none,
 * the cursor is at the end.
 */
export function stateOf(text: string, options: { mode?: Mode; ctx?: PanelContext } = {}): EditorState {
  const { doc, ranges } = parseMarked(text);
  const main = ranges[ranges.length - 1]!;
  const ctx = options.ctx ?? fakeContext().ctx;
  return withFullTree(
    createEditorState({
      ctx,
      text: doc,
      mode: options.mode ?? 'edit',
      selection: { anchor: main.anchor, head: main.head },
    }),
  );
}

export interface DrawnItem {
  feature: string;
  from: number;
  to: number;
  kind: 'mark' | 'line' | 'hide' | 'replace' | 'widget' | 'hideLines' | 'replaceLines' | 'blockWidget';
  className: string;
  widget?: string;
}

function kindOf(deco: Decoration): DrawnItem['kind'] {
  const d = deco as Decoration & { point: boolean; isReplace?: boolean; block?: boolean };
  const widget = !!deco.spec.widget;
  if (!d.point) return 'mark';
  if (d.isReplace === undefined) return 'line';
  if (d.isReplace) return d.block ? (widget ? 'replaceLines' : 'hideLines') : widget ? 'replace' : 'hide';
  return d.block ? 'blockWidget' : 'widget';
}

/** Every decoration every feature draws for `state`, as plain data. */
export function drawn(state: EditorState): DrawnItem[] {
  const out: DrawnItem[] = [];
  for (const f of drawHeadless(state)) {
    f.decorations.between(0, state.doc.length, (from, to, deco) => {
      out.push({
        feature: f.feature,
        from,
        to,
        kind: kindOf(deco),
        className: (deco.spec.class as string | undefined) ?? '',
        widget: deco.spec.widget?.constructor.name,
      });
    });
  }
  return out;
}

/** The decorations of `state` that `keep` takes, each as one line, sorted: two drawings that draw the same give the same lines. */
export function drawnLines(state: EditorState, keep: (item: DrawnItem) => boolean): string[] {
  return drawn(state)
    .filter(keep)
    .map((d) => `${d.feature} ${d.kind} ${d.from}-${d.to} ${d.className} ${d.widget ?? ''}`)
    .sort();
}

/**
 * The document text as drawn: hidden ranges and replaced ranges removed (a replacing widget
 * shows as `[Name]`), whole hidden lines removed with their line break.
 */
export function visibleText(state: EditorState): string {
  const items = drawn(state).filter(
    (d) => d.kind !== 'mark' && d.kind !== 'line' && d.kind !== 'widget' && d.kind !== 'blockWidget',
  );
  const text = state.doc.toString();
  const cut: { from: number; to: number; insert: string }[] = items.map((d) => {
    const whole = d.kind === 'hideLines' || d.kind === 'replaceLines';
    // A removed line takes its line break with it.
    const to = whole && d.to < text.length ? d.to + 1 : d.to;
    return { from: d.from, to, insert: d.widget ? `[${d.widget}]` : '' };
  });
  cut.sort((a, b) => a.from - b.from || b.to - a.to);
  let out = '';
  let pos = 0;
  for (const c of cut) {
    if (c.from < pos) continue;
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

/** The classes on the given 1-based line, from every feature. */
export function lineClasses(state: EditorState, lineNumber: number): string[] {
  const from = state.doc.line(lineNumber).from;
  return drawn(state)
    .filter((d) => d.kind === 'line' && d.from === from)
    .flatMap((d) => d.className.split(' '));
}

export function moveTo(state: EditorState, pos: number): EditorState {
  return state.update({ selection: { anchor: pos } }).state;
}

/** Inline content as drawn, read without a DOM: its text, each widget as `[Name]`, and the classes over it. */
export interface InlineReading {
  text: string;
  classes: string[];
  widgets: RichWidget[];
}

/** Reads [from, to] of `text` as `drawing` draws it. */
export function readInline(drawing: InlineDrawing, text: string, from: number, to: number): InlineReading {
  const reading: InlineReading = { text: '', classes: [], widgets: [] };
  const classes = new Set<string>();
  const note = (active: readonly Decoration[]) => {
    for (const mark of active) for (const c of String(mark.spec.class ?? '').split(' ')) if (c) classes.add(c);
  };
  RangeSet.spans(drawing, from, to, {
    span(start, end, active) {
      reading.text += text.slice(start, end);
      note(active);
    },
    point(_start, _end, deco, active) {
      const widget = deco.spec.widget as RichWidget | undefined;
      note(active);
      if (!widget) return;
      reading.text += `[${widget.constructor.name}]`;
      reading.widgets.push(widget);
    },
  });
  reading.classes = [...classes].sort();
  return reading;
}

/** The grid of each table `state` draws as a grid, in document order. */
export function gridsOf(state: EditorState): GridView[] {
  const grids: GridView[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      const info = readTable(state.doc, node.node);
      if (info?.drawable) grids.push(gridOf(state, info));
      return false;
    },
  });
  return grids;
}

/** What each cell of `grid` draws, by row and column. */
export function cellReadings(grid: GridView): InlineReading[][] {
  return grid.rows.map((row) => row.cells.map(([from, to]) => readInline(row.drawing, row.source, from, to)));
}

export interface StandInView {
  state: EditorState;
  /** Everything dispatched to it, in order. */
  specs: TransactionSpec[];
  contentDOM: object;
  dom: { ownerDocument: { activeElement: unknown; execCommand: (c: string) => boolean } };
  dispatch(spec: TransactionSpec | Transaction): void;
  plugin(): null;
  focus(): void;
}

/**
 * A stand-in for an editor view over `state`: enough of one for code that reads the state,
 * dispatches and looks at the focused element.
 */
export function standInView(state: EditorState): StandInView & EditorView {
  const view: StandInView = {
    state,
    specs: [],
    contentDOM: {},
    dom: { ownerDocument: { activeElement: null, execCommand: () => true } },
    dispatch(spec) {
      // A Transaction (made with state.update) or a spec.
      const tr = 'startState' in spec ? spec : view.state.update(spec);
      view.specs.push(spec);
      view.state = tr.state;
    },
    plugin: () => null,
    focus: () => {},
  };
  return view as StandInView & EditorView;
}

// ---------------------------------------------------------------------------
// A panel over PanelSync, and a host log that sends it updates

/** One change to the host's text, at offsets in it. */
export interface HostChange {
  from: number;
  to?: number;
  insert?: string;
}

/**
 * A panel's state over the real PanelSync, made by `make` with the sync extension, and a host log
 * that sends it updates: `update` makes one on the host's text, with its reason, `receive` sends
 * the panel one message holding some, in order, and `type` is typing in the panel that has not
 * reached the host.
 */
export class SyncedPanel {
  state: EditorState;
  private readonly sync = new PanelSync({
    post: () => {},
    schedule: { setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 },
  });
  private host: string;
  private version = 0;

  constructor(text: string, make: (sync: Extension) => EditorState) {
    this.host = text;
    this.state = make(this.sync.start({ clientId: 'panel', version: 0 }));
    this.sync.bind(this);
  }

  /** What PanelSync applies, and the panel's own transactions, land here. */
  dispatch(tr: Transaction): void {
    this.state = tr.state;
  }

  apply(spec: TransactionSpec): void {
    this.dispatch(this.state.update(spec));
  }

  update(changes: readonly HostChange[], reason?: UpdateReason) {
    const cs = ChangeSet.of(
      changes.map((c) => ({ from: c.from, to: c.to ?? c.from, insert: c.insert ?? '' })),
      this.host.length,
    );
    this.host = cs.apply(Text.of(this.host.split('\n'))).toString();
    return { clientId: '@host', changes: cs.toJSON(), ...(reason ? { reason } : {}) };
  }

  receive(...updates: ReturnType<SyncedPanel['update']>[]): void {
    this.sync.handle({
      type: 'updates',
      fromVersion: this.version,
      updates,
      version: this.version + updates.length,
      ...stampOf(this.host),
    });
    this.version += updates.length;
  }

  type(at: number, insert: string): void {
    this.apply({ changes: { from: at, insert }, userEvent: 'input.type' });
  }
}

// ---------------------------------------------------------------------------
// Random edits, read against a fresh state

/**
 * One step the user takes in a note, drawn by `rng`: one of `snippets` inserted with the cursor
 * after it, up to 12 characters deleted, or the cursor moved. With `twoChanges`, some steps
 * insert in two places in one transaction, as a command over several lines does.
 */
export function randomEdit(state: EditorState, rng: Rng, snippets: readonly string[], twoChanges = false): EditorState {
  const len = state.doc.length;
  const roll = rng.next();
  if (roll < 0.45) {
    const at = rng.int(len + 1);
    const insert = rng.pick(snippets);
    return state.update({ changes: { from: at, insert }, selection: { anchor: at + insert.length } }).state;
  }
  if (roll < 0.7 && len > 0) {
    const from = rng.int(len);
    const to = Math.min(len, from + 1 + rng.int(12));
    return state.update({ changes: { from, to }, selection: { anchor: from } }).state;
  }
  if (twoChanges && roll < 0.8) {
    const a = rng.int(len + 1);
    const b = Math.min(len, a + rng.int(80));
    const insert = rng.pick(snippets);
    return state.update({
      changes: [
        { from: a, insert },
        { from: b, insert: '\n' },
      ],
    }).state;
  }
  return state.update({ selection: { anchor: rng.int(len + 1) } }).state;
}

/** A state made from scratch with `state`'s text and selection, in `mode`, its whole tree parsed: what a full redraw draws from. */
export function freshState(state: EditorState, ctx: PanelContext, mode: Mode): EditorState {
  const { anchor, head } = state.selection.main;
  return withFullTree(createEditorState({ ctx, text: state.doc.toString(), mode, selection: { anchor, head } }));
}

/**
 * Edits `start` `steps` times by `edit`, and after each step expects `read` to give of the edited
 * state what it gives of `fresh(state)`, the same text read from scratch; the first step that
 * differs fails, with its number and the text.
 */
export function expectSameAsFresh(options: {
  start: EditorState;
  steps: number;
  edit: (state: EditorState) => EditorState;
  fresh: (state: EditorState) => EditorState;
  read: (state: EditorState) => string[];
}): void {
  let state = options.start;
  for (let step = 0; step < options.steps; step++) {
    state = withFullTree(options.edit(state));
    const got = options.read(state);
    const want = options.read(options.fresh(state));
    if (got.join('\n') !== want.join('\n'))
      expect({ step, text: state.doc.toString(), got }).toEqual({ step, text: state.doc.toString(), got: want });
  }
}
