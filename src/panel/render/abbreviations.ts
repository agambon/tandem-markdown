// Abbreviations (markdown/abbreviations.ts): where an abbreviation the file defines stands in
// the text as a word of its own, it is underlined with dots and what it stands for is its
// tooltip, as a browser draws `<abbr title>`. Not in code, addresses or HTML. The definition
// lines are faded in Rich editor and left out of Rich view, as the programs that read them do.
//
// The definitions are read from the top-level blocks, kept across edits that touch none, and
// matched with one pattern of all their labels, longest first, case as written. Past the stored
// parse they are read from the reading of links/farDefinitions.ts once one has been made. This
// feature never makes that reading: any word can be an abbreviation, so every note would need
// one. It draws again when one is made. A state that holds a part of a file (a grid table's
// cell) marks the file's abbreviations.

import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { IterMode, type SyntaxNode, type Tree, type TreeCursor } from '@lezer/common';
import type { Feature } from '../features';
import { farDefinitionsExtension, madeFarDefinitions } from '../links/farDefinitions';
import { damageTouches } from './damage';
import { blockFeature, fileState, inlineFeature, type InlineDraw } from './framework';
import { hideWithGap } from './layout';

/** What text an abbreviation is not looked for in. */
const NOT_TEXT = new Set([
  'InlineCode',
  'InlineMath',
  'DisplayMath',
  'URL',
  'Autolink',
  'HTMLTag',
  'Comment',
  'LinkLabel',
  'Wikilink',
  'Embed',
  'Attributes',
]);

/** Blocks whose text is looked through. */
const TEXT_BLOCKS = /^(?:Paragraph|ATXHeading\d|SetextHeading\d|TableCell|BoxTitle)$/;

interface Found {
  titles: Map<string, string>;
  /** All the labels, longest first, as one pattern; null for none. */
  pattern: RegExp | null;
  /** How far the tree they were read from reached. */
  to: number;
}

/** The definitions in the top-level blocks of `tree` that end after `from`, added to `titles`. */
function read(tree: Tree, doc: Text, from = 0, titles = new Map<string, string>()): Found {
  const cursor = tree.cursor(IterMode.IgnoreMounts);
  if (cursor.childAfter(from - 1)) {
    do {
      if (cursor.name !== 'Abbreviation') continue;
      const label = cursor.node.getChild('AbbreviationLabel');
      const title = cursor.node.getChild('AbbreviationTitle');
      if (!label || !title) continue;
      const text = doc.sliceString(label.from, label.to);
      // The last definition of a label is the one that holds, as in Python-Markdown.
      titles.set(text, doc.sliceString(title.from, title.to));
    } while (cursor.nextSibling());
  }
  const labels = [...titles.keys()].sort((a, b) => b.length - a.length);
  const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = labels.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
    : null;
  return { titles, pattern, to: tree.length };
}

const isAbbreviation = (top: TreeCursor): boolean => top.name === 'Abbreviation';

/**
 * One tree's definitions, read when first asked for: carried over from the tree before when an
 * edit touches none, or, when the same text is parsed further, read on from where that stopped.
 */
class Definitions {
  constructor(
    private readonly tree: Tree,
    private readonly doc: Text,
    private found: Found | null,
    private readonly before: Found | null,
  ) {}

  get(): Found {
    const before = this.before;
    return (this.found ??= before
      ? read(this.tree, this.doc, before.to, new Map(before.titles))
      : read(this.tree, this.doc));
  }

  next(tr: Transaction): Definitions {
    const tree = syntaxTree(tr.state);
    if (tree === this.tree && !tr.docChanged) return this;
    if (!tr.docChanged) return new Definitions(tree, tr.state.doc, null, this.found ?? this.before);
    const carried =
      this.found && !damageTouches(tr, isAbbreviation) ? { ...this.found, to: tr.changes.mapPos(this.found.to) } : null;
    return new Definitions(tree, tr.state.doc, carried, null);
  }
}

const definitionsField = StateField.define<Definitions>({
  create: (state) => new Definitions(syntaxTree(state), state.doc, null, null),
  update: (defs, tr) => defs.next(tr),
  provide: () => farDefinitionsExtension,
});

/** The stored tree's definitions with the reading's after them, by the version of the reading. */
const withReading = new WeakMap<Found, { version: number; found: Found }>();

/**
 * The file's abbreviations: the stored tree's, then those of the reading past it when one has
 * been made, which come later in the file and so hold over them.
 */
function fileTitles(state: EditorState): Found | null {
  const file = fileState(state);
  const stored = file.field(definitionsField, false)?.get();
  const far = stored && madeFarDefinitions(file);
  if (!stored || !far) return stored ?? null;
  let known = withReading.get(stored);
  if (known?.version !== far.version) {
    known = { version: far.version, found: read(far.tree, file.doc, far.start, new Map(stored.titles)) };
    withReading.set(stored, known);
  }
  return known.found;
}

const titleKeys = new WeakMap<Found, string>();

/** The file's abbreviations and what they stand for, as one comparable string. */
function titlesKey(state: EditorState): string {
  const found = fileTitles(state);
  if (!found) return '';
  let key = titleKeys.get(found);
  if (key === undefined) {
    key = JSON.stringify([...found.titles]);
    titleKeys.set(found, key);
  }
  return key;
}

/** Marks each use of an abbreviation in the text of `from` to `to`. */
function markUses(d: InlineDraw, found: Found, from: number, to: number): void {
  const pattern = found.pattern!;
  const text = d.doc.sliceString(from, to);
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const at = from + match.index;
    let inside = false;
    for (let n: SyntaxNode | null = d.tree.resolveInner(at, 1); n; n = n.parent) {
      if (NOT_TEXT.has(n.name)) inside = true;
      if (inside || n.from <= from) break;
    }
    if (!inside) d.mark(at, at + match[0].length, 'tm-abbr', { title: found.titles.get(match[0])! });
  }
}

export const abbreviations: Feature = {
  id: 'abbreviations',
  extension: () => [
    definitionsField,
    inlineFeature(
      'abbreviations',
      (d) => {
        const found = fileTitles(d.state);
        if (!found?.pattern) return;
        d.iterate((node) => {
          // Into containers and tables; past every other block.
          if (!TEXT_BLOCKS.test(node.name)) return !node.type.is('LeafBlock') || node.name === 'Table';
          markUses(d, found, Math.max(node.from, d.from), Math.min(node.to, d.to));
          return false;
        });
      },
      { reads: titlesKey },
    ),
    blockFeature('abbreviations', (d) => {
      d.blocks((block) => {
        if (block.name !== 'Abbreviation') return;
        if (d.mode === 'view') hideWithGap(d, block);
        else d.line(block.from, 'tm-abbr-def');
      });
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-abbr': { textDecoration: 'underline dotted', textUnderlineOffset: '0.2em', cursor: 'help' },
      '& .cm-content .tm-abbr-def': { color: 'var(--tm-faded)' },
    }),
  ],
};
