// The link and footnote definitions in the part of a note the editor has not parsed yet.
//
// CodeMirror parses a long note only so far past what is on screen (render/framework.ts parses
// the rest only for notes under its BACKGROUND_PARSE_LIMIT), but a reference link or a footnote
// works wherever its definition is, and definitions are often all written at the end. So the
// text past the stored parse is read here by the same block parsers with no inline syntax: where
// a definition can stand (not in code, an HTML block, front matter or a block that keeps its
// lines as text) is a matter of block structure alone, and reading only the blocks takes about a
// tenth of the time of a whole parse.
//
// The reading is made the first time something asks for it (`farDefinitions`), or before that
// when the page is idle (`farReader`), which also reads it again after a change leaves it stale.

import { language, syntaxTree, type Language } from '@codemirror/language';
import { StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { Tree, TreeFragment, type PartialParse } from '@lezer/common';
import type { MarkdownConfig, MarkdownParser } from '@lezer/markdown';
import { panelContext } from '../context';
import { parserFor } from '../markdown';
import { redrawFeatureEffect } from '../render/framework';

/** Takes every run of inline text whole and makes nothing of it, so a parse reads only blocks. */
const BLOCKS_ONLY: MarkdownConfig = {
  parseInline: [{ name: 'BlocksOnly', parse: (cx) => cx.end, before: 'Escape' }],
};

/** The blocks-only parser of each markdown language the editor has had (one per set of optional syntax). */
const blockParsers = new WeakMap<Language, MarkdownParser>();

function blockParser(state: EditorState, lang: Language): MarkdownParser {
  let parser = blockParsers.get(lang);
  if (!parser) {
    parser = parserFor(state.facet(panelContext)?.settings).configure(BLOCKS_ONLY);
    blockParsers.set(lang, parser);
  }
  return parser;
}

/**
 * The start of the line where the stored tree's last top-level block starts, the block the parse
 * may have cut short: where the reading starts (a block's node may start after the line's indent,
 * which the reading needs). Null when the tree covers the whole text. Markdown is read line by
 * line and a top-level block does not depend on the text before it, so the reading and the stored
 * tree agree wherever both exist: definitions before that block are read from the stored tree,
 * those from it on from the reading, by the same code (test/panel/links/farDefinitions.test.ts
 * reads every sample both ways).
 */
function boundary(state: EditorState): number | null {
  const tree = syntaxTree(state);
  if (tree.length >= state.doc.length) return null;
  const last = tree.topNode.lastChild;
  return last ? state.doc.lineAt(last.from).from : 0;
}

/**
 * Every definition is written with one of these: a label's end and the colon after it, which
 * an abbreviation may hold apart by a space or a tab (`*[HTML] : ...`).
 */
const DEFINITION_MARKS = [']:', '] :', ']\t:'];

let versions = 0;

/** A reading of the text from `start` to the end, or the want of one. */
class Far {
  /** A reading made at once in the state that holds this one; the states after it start from it. */
  refreshed: Far | null = null;
  private placed: Tree | null = null;

  constructor(
    /** Where the reading starts: where the stored tree's last top-level block started. */
    readonly start: number,
    /** The reading, its positions counted from `start`; null before it is made. */
    readonly tree: Tree | null,
    /** What the last reading's tree can lend the next one, mapped through every change since. */
    readonly fragments: readonly TreeFragment[],
    /** A change since the reading may have changed what it says. */
    readonly stale: boolean,
    /** Changes with what the reading says. */
    readonly version: number,
  ) {}

  /** The reading with its positions as in the text. */
  placedTree(): Tree {
    const tree = this.tree!;
    return (this.placed ??= new Tree(
      tree.type,
      tree.children,
      tree.positions.map((p) => p + this.start),
      this.start + tree.length,
    ));
  }
}

/** No reading: the stored tree covers the whole text, or the text is not markdown. */
const NONE = new Far(0, null, [], false, 0);

/** A reading not made yet, from where `state`'s stored tree ends, with what `fragments` can lend. */
function unread(state: EditorState, fragments: readonly TreeFragment[]): Far {
  const start = boundary(state);
  return start === null || !state.facet(language) ? NONE : new Far(start, null, fragments, false, ++versions);
}

/** A parse of `text` from `start` to its end, reading blocks only. Null when no definition can be there. */
function startRead(
  state: EditorState,
  text: string,
  start: number,
  fragments: readonly TreeFragment[],
): PartialParse | null {
  const lang = state.facet(language);
  if (!lang || DEFINITION_MARKS.every((mark) => text.indexOf(mark, start) < 0)) return null;
  return blockParser(state, lang).startParse(text, fragments, [{ from: start, to: text.length }]);
}

function finished(start: number, tree: Tree | null): Far {
  if (!tree) return new Far(start, Tree.empty, [], false, ++versions);
  return new Far(start, tree, [new TreeFragment(start, start + tree.length, tree, -start)], false, ++versions);
}

/** Reads `state`'s text from `start` to the end, at once. */
function readNow(state: EditorState, start: number, fragments: readonly TreeFragment[]): Far {
  const parse = startRead(state, state.doc.toString(), start, fragments);
  let tree: Tree | null = null;
  if (parse) while (!(tree = parse.advance()));
  return finished(start, tree);
}

/** A reading made when the page was idle, for the state whose text is `doc`. */
const farRead = StateEffect.define<{ doc: Text; far: Far }>();

/**
 * The reading a state holds. An edit before its start moves it with the text while the stored
 * tree's last block still starts there; any other change leaves it stale until it is read again,
 * from what the change left of the last reading.
 */
const farField = StateField.define<Far>({
  create: (state) => unread(state, []),
  update(value, tr) {
    let far = value.refreshed ?? value;
    for (const e of tr.effects) if (e.is(farRead) && e.value.doc === tr.startState.doc) far = e.value.far;
    const state = tr.state;
    const lang = state.facet(language);
    if (!lang) return NONE;
    if (lang !== tr.startState.facet(language)) return unread(state, []);
    const start = boundary(state);
    if (start === null) return NONE;
    if (far === NONE) return unread(state, []);
    let fragments = far.fragments;
    let from = far.start;
    let stale = far.stale;
    if (tr.docChanged) {
      const ranges: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        ranges.push({ fromA, toA, fromB, toB });
        if (toA >= far.start) stale = true;
      });
      fragments = TreeFragment.applyChanges(fragments, ranges);
      from = tr.changes.mapPos(far.start, 1);
    }
    if (!far.tree) return !tr.docChanged && from === start ? far : new Far(start, null, fragments, false, far.version);
    if (from !== start) stale = true;
    if (!tr.docChanged && stale === far.stale) return far;
    return new Far(from, far.tree, fragments, stale, far.version);
  },
});

/** The reading `value` stands for now, without making one. */
function current(value: Far): Far {
  return value.refreshed ?? value;
}

/** What the definitions past the stored parse are read from. */
interface FarDefinitions {
  /**
   * Where the stored tree's definitions end and these begin: the start of the top-level block
   * the reading takes over from (the stored tree's last, or a later one while the reading waits
   * to be made again).
   */
  readonly from: number;
  /**
   * Where the reading starts. What it holds keeps its place counted from here until it is
   * read again (`version` changes then).
   */
  readonly start: number;
  /** Blocks only, with no inline content: a tree to read definitions from, from `from` on. */
  readonly tree: Tree;
  /** Changes when what the reading says may have changed. */
  readonly version: number;
}

/**
 * What `state`'s definitions past its stored parse are read from; null when the stored tree
 * covers the whole text. The reading is made now when it has not been. It may be stale after a
 * change until the page is next idle; with `fresh` it is read again now, as a command needs.
 */
export function farDefinitions(state: EditorState, fresh = false): FarDefinitions | null {
  const value = state.field(farField, false);
  if (!value || value === NONE) return null;
  const start = boundary(state)!;
  let far = current(value);
  if (!far.tree || (fresh && far.stale)) far = value.refreshed = readNow(state, start, far.fragments);
  return { from: Math.max(start, far.start), start: far.start, tree: far.placedTree(), version: far.version };
}

/** What `farDefinitions` gives once the reading has been made, stale or not, without making one; else null. */
export function madeFarDefinitions(state: EditorState): FarDefinitions | null {
  const value = state.field(farField, false);
  const far = value && value !== NONE ? current(value) : null;
  if (!far?.tree) return null;
  return {
    from: Math.max(boundary(state)!, far.start),
    start: far.start,
    tree: far.placedTree(),
    version: far.version,
  };
}

/** Changes when what `farDefinitions` gives for `state` may have; asking does not make a reading. */
export function farVersion(state: EditorState): number {
  const value = state.field(farField, false);
  return value ? current(value).version : 0;
}

/** The version of the reading `state` holds once it has been made; 0 before that, or when there is none to make. */
function madeVersion(state: EditorState): number {
  const value = state.field(farField, false);
  const far = value && value !== NONE ? current(value) : null;
  return far?.tree ? far.version : 0;
}

/**
 * Where the stored tree's definitions end and the reading's begin, as `farDefinitions` gives it
 * (`from`), without making a reading; null when the stored tree covers the whole text.
 */
export function farSplit(state: EditorState): number | null {
  const value = state.field(farField, false);
  if (!value || value === NONE) return null;
  return Math.max(boundary(state)!, current(value).start);
}

/** The drawing features that show what definitions say (render/links.ts, images.ts, contents.ts, footnotes.ts, abbreviations.ts). */
const DRAWN_FROM_DEFINITIONS = ['links', 'images', 'contents', 'footnotes', 'abbreviations'];

/**
 * Those of them that need every definition to draw anything (the abbreviations, which are looked
 * for in all the text): they never make the reading, draw with the one made
 * (`madeFarDefinitions`), and are drawn again whenever one is made.
 */
const DRAWN_WITH_READING = ['abbreviations'];

/** How long a slice of reading may take when the page gives no deadline. */
const SLICE_MS = 10;

/** Makes the reading when the page is idle, a slice at a time, and hands it to the state. */
const farReader = ViewPlugin.fromClass(
  class {
    private cancel: (() => void) | null = null;
    private reading: { doc: Text; start: number; parse: PartialParse | null } | null = null;
    /** The version of the last reading what draws with the reading it finds was drawn again for. */
    private shown = 0;
    private showing = false;
    private destroyed = false;

    constructor(readonly view: EditorView) {
      this.schedule();
      this.show();
    }

    update(): void {
      this.schedule();
      this.show();
    }

    /**
     * After a reading made by what needed it (a link to a label defined far down, a command), what
     * draws with the reading it finds is drawn again; not in the update under way, which may
     * have drawn it before the reading was made.
     */
    private show(): void {
      if (this.showing || madeVersion(this.view.state) === this.shown) return;
      this.showing = true;
      queueMicrotask(() => {
        this.showing = false;
        const version = madeVersion(this.view.state);
        if (this.destroyed || version === 0 || version === this.shown) return;
        this.shown = version;
        this.view.dispatch({ effects: DRAWN_WITH_READING.map((feature) => redrawFeatureEffect.of(feature)) });
      });
    }

    private wanted(): Far | null {
      const value = this.view.state.field(farField, false);
      if (!value || value === NONE) return null;
      const far = current(value);
      return !far.tree || far.stale ? far : null;
    }

    private schedule(): void {
      if (this.cancel || !this.wanted()) return;
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback((deadline) => this.run(() => deadline.timeRemaining() > 1));
        this.cancel = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(() => {
          const until = performance.now() + SLICE_MS;
          this.run(() => performance.now() < until);
        }, 0);
        this.cancel = () => clearTimeout(id);
      }
    }

    private run(hasTime: () => boolean): void {
      this.cancel = null;
      const far = this.wanted();
      if (!far) {
        this.reading = null;
        return;
      }
      const state = this.view.state;
      const start = boundary(state)!;
      let reading = this.reading;
      if (!reading || reading.doc !== state.doc || reading.start !== start) {
        reading = { doc: state.doc, start, parse: startRead(state, state.doc.toString(), start, far.fragments) };
        this.reading = reading;
      }
      let tree: Tree | null = null;
      if (reading.parse) {
        while (!(tree = reading.parse.advance())) {
          if (!hasTime()) {
            this.schedule();
            return;
          }
        }
      }
      this.reading = null;
      const read = finished(start, tree);
      const effects: StateEffect<unknown>[] = [farRead.of({ doc: state.doc, far: read })];
      // What was drawn with a stale reading is drawn again, and what draws with the reading it
      // finds when the first one holds anything.
      const redraw = far.tree ? DRAWN_FROM_DEFINITIONS : tree ? DRAWN_WITH_READING : [];
      for (const feature of redraw) effects.push(redrawFeatureEffect.of(feature));
      this.shown = read.version;
      this.view.dispatch({ effects });
    }

    destroy(): void {
      this.destroyed = true;
      this.cancel?.();
      this.cancel = null;
    }
  },
);

/** The reading and what keeps it made: included by every state field that reads definitions. */
export const farDefinitionsExtension: Extension = [farField, farReader];
