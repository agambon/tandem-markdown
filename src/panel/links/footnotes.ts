// The file's footnotes: every reference in order, notes written in place included, and where
// each label is defined; from them, each note's number, as GitHub numbers them: by the order of
// its first reference. Labels match with no regard to case, as reference link labels do, and the
// first definition of a label wins. A reference to a label the file does not define is not a
// footnote, and a note no reference points to has no number.
//
// The index is built the first time something asks for it and kept in step with every change
// (`Index.next`). Definitions past the stored parse come from farDefinitions.ts's reading
// (`farNotes`); references there are counted once the parse reaches them, after every reference
// before. A grid table is one block of the file's tree: the references in its cells are read from
// the cells' markdown (tables/gridCells.ts), in the order Pandoc reads it (`gridReferences`).
// Also here: following a footnote.

import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { CODE_OPEN_BRACKET } from '../../core/markdownText';
import { treeForLine } from '../markdown/tree';
import { getMode } from '../modes';
import { docDamage } from '../render/damage';
import { filePart, fileState, type FilePart } from '../render/framework';
import type { Span } from '../render/lines';
import { drawnInCell, fileGrid, gridCells, parseCell } from '../tables/gridCells';
import { farDefinitions, farDefinitionsExtension, farVersion } from './farDefinitions';

/** A reference: `[^label]`, or a note written in place (`^[text]`, label null). */
interface FootnoteReference {
  readonly from: number;
  readonly to: number;
  readonly label: string | null;
  /** For one in a grid table's cell: that reading of the table, the same for each of its references. */
  readonly table?: object;
  /** With `table`: its place among the table's references, cell by cell. */
  readonly rank?: number;
}

/** A definition's `[^label]:`. */
interface FootnoteDefinition {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

/** How labels are compared. */
function labelKey(label: string): string {
  return label.toLowerCase().toUpperCase();
}

/** The label of a `[^label]` reference or a `[^label]:` definition, as compared. */
export function footnoteLabel(doc: Text, node: SyntaxNode): string {
  const end = node.name === 'FootnoteLabel' ? node.to - 2 : node.to - 1;
  return labelKey(doc.sliceString(node.from + 2, end));
}

/**
 * The references in the cells of the grid table `node` of `state`, in the order they stand in
 * the file, each with its place in the order Pandoc reads the table: row by row, cell by cell,
 * each cell's text from its start.
 */
function gridReferences(state: EditorState, node: SyntaxNode): FootnoteReference[] {
  const grid = fileGrid(state, node);
  if (!grid) return [];
  const found: FootnoteReference[] = [];
  const table = {};
  for (const cell of gridCells(grid)) {
    const parsed = cell.text.includes('^') ? parseCell(state, grid, cell) : null;
    parsed?.tree.iterate({
      enter: (ref) => {
        if (ref.name !== 'FootnoteRef' && ref.name !== 'InlineFootnote') return true;
        if (!drawnInCell(ref.node)) return false;
        const label = ref.name === 'FootnoteRef' ? footnoteLabel(parsed.doc, ref.node) : null;
        found.push({ from: parsed.at(ref.from), to: parsed.at(ref.to), label, table, rank: found.length });
        return true;
      },
    });
  }
  return found.sort((a, b) => a.from - b.from);
}

/**
 * Reads the references and definitions in [from, to), as far as `tree` is parsed; with `grids`,
 * the state whose text `tree` is of, the references in its grid tables' cells too.
 */
function scan(
  tree: Tree,
  doc: Text,
  from: number,
  to: number,
  refs: FootnoteReference[],
  defs: FootnoteDefinition[],
  grids: EditorState | null,
): void {
  const end = Math.min(to, tree.length, doc.length);
  if (end <= from) return;
  const text = doc.sliceString(from, end);
  // Every node of a footnote starts with `[^` or `^[`; the text is cheaper to search than the tree.
  for (let i = text.indexOf('^'); i >= 0; i = text.indexOf('^', i + 1)) {
    const opensNote = text.charCodeAt(i + 1) === CODE_OPEN_BRACKET;
    const inLabel = i > 0 && text.charCodeAt(i - 1) === CODE_OPEN_BRACKET;
    if (!opensNote && !inLabel) continue;
    const at = from + i - (inLabel ? 1 : 0);
    const inner = tree.resolveInner(at, 1);
    if (inner.name === 'GridTable') {
      if (grids) refs.push(...gridReferences(grids, inner));
      i = inner.to - from;
      continue;
    }
    for (let node: SyntaxNode | null = inner; node && node.from === at; node = node.parent) {
      if (node.name === 'FootnoteRef') refs.push({ from: node.from, to: node.to, label: footnoteLabel(doc, node) });
      else if (node.name === 'InlineFootnote') refs.push({ from: node.from, to: node.to, label: null });
      else if (node.name === 'FootnoteLabel')
        defs.push({ from: node.from, to: node.to, label: footnoteLabel(doc, node) });
      else continue;
      break;
    }
  }
}

/** Keeps the items of `items` outside every span, mapped through `tr`, and adds `found` in order. */
function carry<T extends { from: number; to: number }>(
  items: readonly T[],
  tr: Transaction,
  spans: readonly Span[],
  found: readonly T[],
): T[] {
  const out: T[] = [];
  let next = 0;
  for (const item of items) {
    const from = tr.changes.mapPos(item.from, 1);
    const to = tr.changes.mapPos(item.to, -1);
    if (to <= from || spans.some((s) => from <= s.to && to >= s.from)) continue;
    while (next < found.length && found[next]!.from < from) out.push(found[next++]!);
    out.push(from === item.from && to === item.to ? item : { ...item, from, to });
  }
  while (next < found.length) out.push(found[next++]!);
  return out;
}

/** The references and definitions in a state's stored tree, kept in step with every change. */
class Index {
  private ordered: readonly FootnoteReference[] | null = null;

  constructor(
    /** In the order they stand in the file. */
    readonly refs: readonly FootnoteReference[],
    readonly defs: readonly FootnoteDefinition[],
  ) {}

  /** The references in the order notes are numbered: as they stand, a grid table's cell by cell. */
  inOrder(): readonly FootnoteReference[] {
    if (!this.ordered) {
      const refs = this.refs;
      const out: FootnoteReference[] = [];
      // A table's references stand together, since they all lie within it.
      for (let i = 0; i < refs.length;) {
        const table = refs[i]!.table;
        let end = i + 1;
        while (table && end < refs.length && refs[end]!.table === table) end++;
        out.push(...refs.slice(i, end).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)));
        i = end;
      }
      this.ordered = out;
    }
    return this.ordered;
  }

  static build(state: EditorState): Index {
    const refs: FootnoteReference[] = [];
    const defs: FootnoteDefinition[] = [];
    scan(syntaxTree(state), state.doc, 0, state.doc.length, refs, defs, state);
    return new Index(refs, defs);
  }

  /**
   * The index after `tr`, or null when it is cheaper to build it again when next asked for. Only
   * the blocks the change touched (`docDamage`) are read again, so a keystroke costs what they
   * hold, not what the file holds.
   */
  next(tr: Transaction): Index | null {
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) return this;
    const damage = docDamage(tr);
    if (!damage) return null;
    if (damage.length === 0 && !tr.docChanged) return this;
    const refs: FootnoteReference[] = [];
    const defs: FootnoteDefinition[] = [];
    const tree = syntaxTree(tr.state);
    for (const span of damage) scan(tree, tr.state.doc, span.from, span.to, refs, defs, tr.state);
    return new Index(carry(this.refs, tr, damage, refs), carry(this.defs, tr, damage, defs));
  }
}

/** The definitions of the last reading past the stored parse asked about, counted from where it starts. */
let farRead: { version: number; defs: readonly FootnoteDefinition[] } | null = null;

/**
 * The definitions past `state`'s stored parse, from where its reading takes over; null when the
 * tree covers the file. The reading is made only when a note is numbered or followed, so a note
 * works wherever it is defined and a block with no reference reads none.
 */
function farNotes(state: EditorState): { from: number; defs: FootnoteDefinition[] } | null {
  const far = farDefinitions(state);
  if (!far) return null;
  let read = farRead;
  if (!read || read.version !== far.version) {
    const found: FootnoteDefinition[] = [];
    scan(far.tree, state.doc, far.start, state.doc.length, [], found, null);
    read = farRead = {
      version: far.version,
      defs: found.map((d) => ({ ...d, from: d.from - far.start, to: d.to - far.start })),
    };
  }
  const defs: FootnoteDefinition[] = [];
  for (const d of read.defs) {
    if (far.start + d.from >= far.from) defs.push({ ...d, from: far.start + d.from, to: far.start + d.to });
  }
  return { from: far.from, defs };
}

/** The footnotes of one state: its stored tree's, and the definitions past that tree, read when first needed. */
class Notes {
  private numbering: { byLabel: Map<string, number>; inPlace: Map<number, number> } | null = null;
  private definitionByLabel: Map<string, FootnoteDefinition> | null = null;

  constructor(
    readonly index: Index,
    private readonly state: EditorState,
    /** That of the reading past the stored parse when these were made (`farVersion`). */
    readonly version: number,
  ) {}

  /** Each label's first definition: the stored tree's before the reading past it takes over, then the reading's. */
  definitions(): Map<string, FootnoteDefinition> {
    if (!this.definitionByLabel) {
      const byLabel = new Map<string, FootnoteDefinition>();
      const far = farNotes(this.state);
      const until = far ? far.from : Infinity;
      for (const def of this.index.defs) if (def.from < until && !byLabel.has(def.label)) byLabel.set(def.label, def);
      for (const def of far?.defs ?? []) if (!byLabel.has(def.label)) byLabel.set(def.label, def);
      this.definitionByLabel = byLabel;
    }
    return this.definitionByLabel;
  }

  private numbers(): { byLabel: Map<string, number>; inPlace: Map<number, number> } {
    if (!this.numbering) {
      const byLabel = new Map<string, number>();
      const inPlace = new Map<number, number>();
      const defined = this.definitions();
      let next = 1;
      for (const ref of this.index.inOrder()) {
        if (ref.label === null) inPlace.set(ref.from, next++);
        else if (defined.has(ref.label) && !byLabel.has(ref.label)) byLabel.set(ref.label, next++);
      }
      this.numbering = { byLabel, inPlace };
    }
    return this.numbering;
  }

  /** The number of the note `label` names; null when no definition or no reference has it. */
  number(label: string): number | null {
    return this.numbers().byLabel.get(label) ?? null;
  }

  /** The number of the note written in place at `from`. */
  inPlaceNumber(from: number): number | null {
    return this.numbers().inPlace.get(from) ?? null;
  }

  /**
   * The numbers of the references within [from, to), in order, as one key: a label with no
   * note as `-`. Empty when there is none.
   */
  numbersIn(from: number, to: number): string {
    const refs = this.index.refs;
    let lo = 0;
    let hi = refs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (refs[mid]!.from < from) lo = mid + 1;
      else hi = mid;
    }
    let key = '';
    for (let i = lo; i < refs.length && refs[i]!.from < to; i++) {
      const ref = refs[i]!;
      key += `${(ref.label === null ? this.inPlaceNumber(ref.from) : this.number(ref.label)) ?? '-'},`;
    }
    return key;
  }

  /** Where `label`'s definition is: its `[^label]:`, or null. */
  definition(label: string): Span | null {
    return this.definitions().get(label) ?? null;
  }

  /**
   * The first reference to `label`: the stored tree's, or when it has none, the first past the
   * stored parse, the text parsed as far as it.
   */
  firstReference(label: string): FootnoteReference | null {
    return this.index.inOrder().find((ref) => ref.label === label) ?? referencePastParse(this.state, label);
  }
}

/**
 * The first reference to `label` past `state`'s stored parse, from the start of the line where
 * its last top-level block starts (the parse may have cut that block short): each `[^label]` in
 * the text, in order, is read as far as the text parsed for its line (`treeForLine`, as a
 * command reads), until one is a reference. Null when none is.
 */
function referencePastParse(state: EditorState, label: string): FootnoteReference | null {
  const doc = state.doc;
  const stored = syntaxTree(state);
  if (stored.length >= doc.length) return null;
  const last = stored.topNode.lastChild;
  const from = last ? doc.lineAt(last.from).from : 0;
  const text = doc.sliceString(from);
  for (let i = text.indexOf('[^'); i >= 0; i = text.indexOf('[^', i + 2)) {
    const end = text.indexOf(']', i + 2);
    if (end < 0) break;
    if (labelKey(text.slice(i + 2, end)) !== label) continue;
    const at = from + i;
    const line = doc.lineAt(at);
    const refs: FootnoteReference[] = [];
    scan(treeForLine(state, at), doc, line.from, line.to, refs, [], state);
    const found = refs.find((ref) => ref.from === at && ref.label === label);
    if (found) return found;
  }
  return null;
}

/**
 * The footnotes of one state: the index, built when first asked for and then kept in step with
 * every change, and the notes made from it, kept while neither it nor the reading past it changes.
 */
class Holder {
  private notes: Notes | null = null;

  constructor(
    private readonly state: EditorState,
    private index: Index | null,
    private readonly before: Notes | null,
  ) {}

  get(fresh: boolean): Notes {
    // A command reads a stale reading again first; drawing takes the reading as it is.
    if (fresh) farDefinitions(this.state, true);
    const version = farVersion(this.state);
    if (this.notes?.version !== version) {
      const index = (this.index ??= Index.build(this.state));
      const before = this.before;
      this.notes =
        before && before.index === index && before.version === version ? before : new Notes(index, this.state, version);
    }
    return this.notes;
  }

  next(tr: Transaction): Holder {
    return new Holder(tr.state, this.index?.next(tr) ?? null, this.notes ?? this.before);
  }
}

/** The file's footnotes, in every state of an editor that draws them. */
export const footnoteIndexField = StateField.define<Holder>({
  create: (state) => new Holder(state, null, null),
  update: (holder, tr) => holder.next(tr),
  provide: () => farDefinitionsExtension,
});

export type FootnoteIndex = Pick<Notes, 'number' | 'inPlaceNumber' | 'numbersIn' | 'definition' | 'firstReference'>;

const numberingKeys = new WeakMap<Notes, string>();

/**
 * What the notes' numbers depend on, as one comparable string: the labels of the references in
 * order and the labels defined. It changes when a note's number or its being a note can.
 */
export function footnotesKey(state: EditorState): string {
  const notes = fileState(state).field(footnoteIndexField, false)?.get(false);
  if (!notes) return '';
  let key = numberingKeys.get(notes);
  if (key === undefined) {
    const refs = notes.index
      .inOrder()
      .map((ref) => ref.label ?? '\u0002')
      .join('\u0001');
    const defined = [...notes.definitions().keys()].sort().join('\u0001');
    key = `${refs}\u0000${defined}`;
    numberingKeys.set(notes, key);
  }
  return key;
}

/** The file's footnotes as a part of it asks for them (`FilePart`): its positions placed in the file. */
function inPart(index: FootnoteIndex, part: FilePart): FootnoteIndex {
  return {
    number: (label) => index.number(label),
    inPlaceNumber: (from) => index.inPlaceNumber(part.at(from)),
    numbersIn: (from, to) => part.spans(from, to).reduce((key, span) => key + index.numbersIn(span.from, span.to), ''),
    definition: (label) => index.definition(label),
    firstReference: (label) => index.firstReference(label),
  };
}

/**
 * The file's footnotes, or null in a state that does not keep them. Past the stored parse they
 * may lag a change until the page is next idle; with `fresh` they do not, as a command needs.
 * For a state that holds a part of a file, the file's, asked at the part's positions; the
 * positions they give are the file's.
 */
export function footnoteIndex(state: EditorState, fresh = false): FootnoteIndex | null {
  const part = state.facet(filePart);
  if (part) {
    const index = footnoteIndex(part.state, fresh);
    return index && inPart(index, part);
  }
  return state.field(footnoteIndexField, false)?.get(fresh) ?? null;
}

/** Where a definition's text starts: after its `[^label]:` and the spaces after it, on its line. */
export function noteTextStart(doc: Text, label: Span): number {
  const line = doc.lineAt(label.to);
  let at = label.to;
  while (at < line.to && /[ \t]/.test(doc.sliceString(at, at + 1))) at++;
  return at;
}

/**
 * Follows a footnote to `at`: scrolls it into the middle of the window, and in Rich editor
 * puts the cursor there and focuses the editor.
 */
export function goToFootnote(view: EditorView, at: number): void {
  const pos = Math.max(0, Math.min(view.state.doc.length, at));
  const scroll = EditorView.scrollIntoView(pos, { y: 'center' });
  if (getMode(view.state) !== 'edit') {
    view.dispatch({ effects: scroll });
    return;
  }
  view.dispatch({ selection: { anchor: pos }, effects: scroll, userEvent: 'select' });
  view.focus();
}
