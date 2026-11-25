// Reading links from the syntax tree, for the features that draw, open or describe them: the
// link at a position (wikilinks and footnotes included) or under the pointer, a link's parts,
// and the file's link definitions. Also whether a piece of text is one web address, for the
// features that make links.
//
// A reference link is a link only when the file defines its label (`[label]: address`,
// matched as CommonMark does: case and runs of spaces do not matter, the first definition
// wins), wherever in the file that is: past the stored parse, the definitions are read from
// farDefinitions.ts's reading, which is made only for a label the stored tree's lack
// (`Definitions`). Every feature that reads them includes `definitionsField`. A state that
// holds a part of a file (`filePart`, a grid table's cell) reads the file's, and a link in a
// grid table's cell is found in the cell's markdown (tables/gridCells.ts).

import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { IterMode, type SyntaxNode, type Tree, type TreeCursor } from '@lezer/common';
import type { LinkKind } from '../../core/featureProtocol';
import { isImagePath } from '../../core/fileKinds';
import { stripAngles, unescapeMarkdown } from '../../core/markdownText';
import { parseWikilink, type Wikilink } from '../../core/wikilinks';
import { panelContext } from '../context';
import { htmlLinksIn } from '../html/links';
import { OPAQUE_BLOCKS } from '../markdown/nodes';
import { treeForLine } from '../markdown/tree';
import { damageTouches } from '../render/damage';
import { fileState } from '../render/framework';
import { cellAt, drawnInCell, fileGrid } from '../tables/gridCells';
import { farDefinitions, farDefinitionsExtension, farSplit } from './farDefinitions';
import { footnoteIndex, footnoteLabel, noteTextStart } from './footnotes';

/**
 * A footnote followed as a link: a reference, which goes to its note; a note written in place,
 * which goes nowhere; or a definition's number, which goes back to the first reference.
 */
interface FootnoteLink {
  role: 'reference' | 'inPlace' | 'number';
  /** Where following it puts the cursor, or null. */
  goTo: number | null;
  /** Where the note's text is: the start of its `[^id]:`, or of the note written in place; null for a number. */
  note: number | null;
}

/** A link found at a position: what opening it does, and what the hover card shows. */
export interface LinkTarget {
  /** How the host is asked to open it; `footnote` is followed in the panel itself. */
  kind: LinkKind | 'footnote';
  /** The address as written (angle brackets removed); for a wikilink, `Target#Heading`. */
  href: string;
  /** The link's whole source range. */
  from: number;
  to: number;
  title?: string | undefined;
  /** For a wikilink: its target without the heading, as the resolution cache knows it. */
  target?: string;
  footnote?: FootnoteLink;
}

// ---------------------------------------------------------------------------
// Definitions

interface Definition {
  /** The address as written, angle brackets removed. */
  href: string;
  title?: string | undefined;
}

/** Blocks a definition can sit inside. */
const DEFINITION_CONTAINERS = new Set(['Blockquote', 'BulletList', 'OrderedList', 'ListItem', 'FootnoteDef']);

/** A reference label as CommonMark compares them: trimmed, spaces collapsed, case folded. */
export function normalizeLabel(label: string): string {
  // Lower then upper case approximates Unicode case folding, as commonmark.js and markdown-it do.
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

/** A title's text: the quotes or parentheses around it removed, escapes read. */
function titleText(raw: string): string {
  const inner = raw.length >= 2 ? raw.slice(1, -1) : raw;
  return unescapeMarkdown(inner);
}

/**
 * Calls `found` for every `LinkReference` node among `cursor`'s children and the blocks that
 * can hold one, in document order. Returns early when `found` returns true.
 */
function eachDefinitionNode(cursor: TreeCursor, found: (node: SyntaxNode) => boolean | void): boolean {
  if (!cursor.firstChild()) return false;
  try {
    do {
      if (cursor.name === 'LinkReference') {
        if (found(cursor.node)) return true;
      } else if (DEFINITION_CONTAINERS.has(cursor.name) && eachDefinitionNode(cursor, found)) {
        return true;
      }
    } while (cursor.nextSibling());
    return false;
  } finally {
    cursor.parent();
  }
}

/**
 * Adds to `defs` the definitions in the top-level blocks of `tree` that start from `from` up to
 * `to`, in document order, keeping each label's first definition. True when it added any.
 */
function readDefinitions(tree: Tree, doc: Text, from: number, to: number, defs: Map<string, Definition>): boolean {
  let added = false;
  const add = (node: SyntaxNode) => {
    const label = node.getChild('LinkLabel');
    const url = node.getChild('URL');
    if (!label || !url) return;
    const key = normalizeLabel(doc.sliceString(label.from + 1, label.to - 1));
    if (!key || defs.has(key)) return;
    const title = node.getChild('LinkTitle');
    defs.set(key, {
      href: stripAngles(doc.sliceString(url.from, url.to)),
      title: title ? titleText(doc.sliceString(title.from, title.to)) : undefined,
    });
    added = true;
  };
  const cursor = tree.cursor(IterMode.IgnoreMounts);
  if (!cursor.childAfter(from - 1)) return added;
  do {
    if (cursor.from >= to) break;
    if (cursor.from < from) continue;
    if (cursor.name === 'LinkReference') add(cursor.node);
    else if (DEFINITION_CONTAINERS.has(cursor.name)) eachDefinitionNode(cursor, add);
  } while (cursor.nextSibling());
  return added;
}

/** Whether the top-level block at `top` is or holds a definition. */
function holdsDefinition(top: TreeCursor): boolean {
  return top.name === 'LinkReference' || (DEFINITION_CONTAINERS.has(top.name) && eachDefinitionNode(top, () => true));
}

const NO_DEFINITIONS: ReadonlyMap<string, Definition> = new Map();
const definitionKeys = new WeakMap<Map<string, Definition>, string>();

/**
 * The definitions of one state, in two parts, each read when first asked for: the stored tree's,
 * before the reading past it takes over (`farSplit`), carried over from the state before while
 * no edit touches one; and the reading's, kept while the reading stays the same. A label is
 * looked for in the second only when the first lacks it, so the reading is made only then.
 */
class Definitions {
  constructor(
    private readonly state: EditorState,
    /** The stored tree's definitions before `storedTo`. */
    private stored: Map<string, Definition> | null,
    private storedTo: number,
    private far: { map: Map<string, Definition>; version: number } | null,
  ) {}

  /** The stored tree's definitions before the reading takes over: nothing past the parse is read. */
  private storedPart(): ReadonlyMap<string, Definition> {
    const to = farSplit(this.state) ?? Infinity;
    const tree = syntaxTree(this.state);
    if (!this.stored || to < this.storedTo) {
      this.stored = new Map();
      readDefinitions(tree, this.state.doc, 0, to, this.stored);
    } else if (to > this.storedTo) {
      // The parse went on: the blocks it took over from the reading are added.
      const more = new Map(this.stored);
      if (readDefinitions(tree, this.state.doc, this.storedTo, to, more)) this.stored = more;
    }
    this.storedTo = to;
    return this.stored;
  }

  /**
   * The reading's definitions; the reading is made now when it has not been. They are read from
   * where the reading starts, not from where it takes over: what lies between is the stored
   * tree's too, read alike, and looked for there first. So they stay right while the parse goes
   * on or an edit before them moves them, and are read again only with the reading.
   */
  private farPart(fresh: boolean): ReadonlyMap<string, Definition> {
    const far = farDefinitions(this.state, fresh);
    if (!far) return NO_DEFINITIONS;
    if (this.far?.version !== far.version) {
      const map = new Map<string, Definition>();
      readDefinitions(far.tree, this.state.doc, far.start, Infinity, map);
      this.far = { map, version: far.version };
    }
    return this.far.map;
  }

  /** The definition of `label` (normalized). With `fresh`, a stale reading past the parse is read again first. */
  get(label: string, fresh: boolean): Definition | undefined {
    if (fresh) farDefinitions(this.state, true);
    return this.storedPart().get(label) ?? this.farPart(fresh).get(label);
  }

  /** The stored tree's part as one comparable string. */
  storedKey(): string {
    const stored = this.storedPart() as Map<string, Definition>;
    let key = definitionKeys.get(stored);
    if (key === undefined) {
      key = [...stored].map(([label, def]) => `${label}\u0000${def.href}\u0000${def.title ?? ''}`).join('\u0001');
      definitionKeys.set(stored, key);
    }
    return key;
  }

  /** The definitions after `tr`: the stored tree's part carried when no edit can have changed one. */
  next(tr: Transaction): Definitions {
    const changed = tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState);
    const carried = this.stored && !(changed && damageTouches(tr, holdsDefinition));
    const to = this.storedTo === Infinity ? Infinity : tr.changes.mapPos(this.storedTo);
    return new Definitions(tr.state, carried ? this.stored : null, carried ? to : 0, this.far);
  }
}

/** The file's link definitions, kept across edits that touch none. */
export const definitionsField = StateField.define<Definitions>({
  create: (state) => new Definitions(state, null, 0, null),
  update: (defs, tr) => defs.next(tr),
  provide: () => farDefinitionsExtension,
});

/**
 * Where a reference link's label is looked up: the file's link definitions. Past the stored
 * parse they are read only when a label is not among the stored tree's, and may lag a change
 * until the page is next idle (drawing is done again then); with `fresh` they do not, as a
 * command needs.
 */
export function definitionLookup(state: EditorState, fresh = false): DefinitionLookup {
  const defs = fileState(state).field(definitionsField);
  return { get: (label) => defs.get(label, fresh) };
}

/**
 * What the drawing of reference links reads of the definitions, as one comparable string: the
 * stored tree's. Asking reads nothing past the parse; a change to the reading draws the
 * features that show definitions again (farDefinitions.ts).
 */
export function definitionsKey(state: EditorState): string {
  return fileState(state).field(definitionsField).storedKey();
}

// ---------------------------------------------------------------------------
// Links

/** The pieces of a `Link` or `Image` node, and where it goes. Null for a reference to an undefined label. */
interface LinkParts {
  /** `[` or `![`. */
  open: SyntaxNode;
  /** The `]` after the text. */
  close: SyntaxNode;
  /** The text between them (the alt text of an image). */
  textFrom: number;
  textTo: number;
  href: string;
  title?: string | undefined;
  url: SyntaxNode | null;
}

/** Where `linkParts` looks up a reference's label (normalized): the file's definitions. */
export interface DefinitionLookup {
  get(label: string): Definition | undefined;
}

export function linkParts(doc: Text, node: SyntaxNode, defs: DefinitionLookup): LinkParts | null {
  const marks: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c);
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return null;
  const base = { open, close, textFrom: open.to, textTo: close.from };
  const paren = marks[2];
  if (paren && paren.from === close.to && doc.sliceString(paren.from, paren.to) === '(') {
    const url = node.getChild('URL');
    const title = node.getChild('LinkTitle');
    return {
      ...base,
      url,
      href: url ? stripAngles(doc.sliceString(url.from, url.to)) : '',
      title: title ? titleText(doc.sliceString(title.from, title.to)) : undefined,
    };
  }
  const label = node.getChild('LinkLabel');
  const key =
    label && label.to - label.from > 2
      ? doc.sliceString(label.from + 1, label.to - 1)
      : doc.sliceString(open.to, close.from);
  const def = defs.get(normalizeLabel(key));
  if (!def) return null;
  return { ...base, url: null, href: def.href, title: def.title };
}

/**
 * A scheme of two characters or more, so `C:` reads as a drive. The host's `readAddress`
 * takes one-letter schemes and tests for a drive first; the host decides how a link opens.
 */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

/** How the host is asked to open an address. */
export function kindOf(href: string): LinkKind {
  if (href.startsWith('#')) return 'anchor';
  if (SCHEME.test(href)) return 'web';
  return 'file';
}

/** A bare address or the inside of `<...>`: `www.` gets `http://`, an email gets `mailto:`. */
function bareHref(text: string): string {
  if (SCHEME.test(text)) return text;
  if (/^www\./i.test(text)) return `http://${text}`;
  if (text.includes('@')) return `mailto:${text}`;
  return text;
}

const WEB_ADDRESS = /^(?:(?:https?|ftp):\/\/|mailto:)[^\s<>]+$/i;
const WWW_ADDRESS = /^www\.[^\s<>]+\.[^\s<>]+$/i;

/**
 * The address to link to when `text` is one web address and nothing else (`www.` gains
 * `https://`), else null.
 */
export function webAddress(text: string): string | null {
  const t = text.trim();
  if (WEB_ADDRESS.test(t)) return t;
  return WWW_ADDRESS.test(t) ? `https://${t}` : null;
}

// ---------------------------------------------------------------------------
// Wikilinks

interface WikilinkParts {
  open: SyntaxNode;
  close: SyntaxNode | null;
  bar: SyntaxNode | null;
  target: SyntaxNode | null;
  alias: SyntaxNode | null;
  /** Between `[[` and `]]`. */
  inner: string;
  /** The target, heading and shown text, as the parser placed them (in either order around the bar). */
  link: Wikilink;
}

/** A `Wikilink` or `Embed` node's target, heading and shown text, read from its children. */
export function wikilinkOf(doc: Text, node: SyntaxNode): Wikilink {
  const target = node.getChild('WikilinkTarget');
  const alias = node.getChild('WikilinkAlias');
  const link = target ? parseWikilink(doc.sliceString(target.from, target.to)) : { target: '' };
  const shown = alias ? doc.sliceString(alias.from, alias.to).trim() : '';
  if (shown) link.alias = shown;
  return link;
}

/**
 * The marks and parts of a `Wikilink` or `Embed` node; null when it has no opening mark. `bar` is
 * null when the link has no `|`, and `alias` when its shown text is empty.
 */
export function wikilinkParts(state: EditorState, node: SyntaxNode): WikilinkParts | null {
  const marks = node.getChildren('WikilinkMark');
  const open = marks[0];
  if (!open) return null;
  const last = marks[marks.length - 1]!;
  const close = marks.length > 1 && state.doc.sliceString(last.from, last.to) === ']]' ? last : null;
  const bar = marks.length > 2 ? marks[1]! : null;
  return {
    open,
    close,
    bar,
    target: node.getChild('WikilinkTarget'),
    alias: node.getChild('WikilinkAlias'),
    inner: state.doc.sliceString(open.to, close ? close.from : node.to),
    link: wikilinkOf(state.doc, node),
  };
}

/** A wikilink found in plain text, its place counted from the text's start. */
interface TextWikilink {
  from: number;
  to: number;
  link: Wikilink;
}

/**
 * The wikilinks in a piece of plain text, such as a front matter value, by the parser's rule:
 * `[[`, then on one line with no bracket, a target, `]]`. `textFirst` reads the shown text
 * before the bar, as the setting `wikilinks: textFirst` does.
 */
export function wikilinksIn(text: string, textFirst: boolean): TextWikilink[] {
  const out: TextWikilink[] = [];
  for (let open = text.indexOf('[['); open >= 0; open = text.indexOf('[[', open + 1)) {
    const close = text.indexOf(']]', open + 2);
    if (close < 0) break;
    const inner = text.slice(open + 2, close);
    if (/[[\]\n]/.test(inner)) {
      // Only the last `[[` before this `]]` can still open a link that ends here.
      const last = text.lastIndexOf('[[', close - 1);
      open = last > open ? last - 1 : close + 1;
      continue;
    }
    const bar = inner.indexOf('|');
    let link = parseWikilink(inner);
    if (textFirst && bar >= 0) {
      link = parseWikilink(inner.slice(bar + 1));
      const shown = inner.slice(0, bar).replace(/\\$/, '').trim();
      if (shown) link.alias = shown;
    }
    if (!link.target.trim() && !link.heading) continue;
    out.push({ from: open, to: close + 2, link });
    open = close + 1;
  }
  return out;
}

/**
 * The markers GitLab and Azure DevOps wikis write for a contents list (`[[_TOC_]]`) and a list
 * of a wiki page's sub-pages (`[[_TOSP_]]`), which are not links to notes.
 */
const CONTENTS_MARKERS: ReadonlySet<string> = new Set(['_TOC_', '_TOSP_']);

/** Whether a wikilink is one of the wiki contents markers, which are not links. */
export function isContentsMarker(link: Wikilink): boolean {
  return CONTENTS_MARKERS.has(link.target) && !link.heading && !link.alias;
}

/**
 * Where the positions of a node lie in the file: the same positions for a node of the file's
 * own tree, the cell's map for a node of a grid table's cell.
 */
type Place = (pos: number) => number;

const IN_FILE: Place = (pos) => pos;

/** The link a `Wikilink` or non-image `Embed` node stands for (undefined for an image embed or a contents marker). */
function wikilinkAt(doc: Text, node: SyntaxNode, at: Place): LinkTarget | undefined {
  if (!node.getChild('WikilinkMark')) return undefined;
  const link = wikilinkOf(doc, node);
  if (node.name === 'Embed' && isImagePath(link.target)) return undefined;
  if (isContentsMarker(link)) return undefined;
  const href = link.heading ? `${link.target}#${link.heading}` : link.target;
  return { kind: 'wikilink', href, from: at(node.from), to: at(node.to), target: link.target };
}

// ---------------------------------------------------------------------------
// Footnotes

/**
 * The footnote a reference, a definition's label or a note written in place stands for; null
 * when it is text. `node` is a node of `doc`, whose positions lie in `file`'s text at `at`.
 */
function footnoteAt(file: EditorState, doc: Text, node: SyntaxNode, at: Place): LinkTarget | null {
  const index = footnoteIndex(file, true);
  if (!index) return null;
  const from = at(node.from);
  const found = { kind: 'footnote' as const, href: '', from, to: at(node.to) };
  if (node.name === 'InlineFootnote') return { ...found, footnote: { role: 'inPlace', goTo: null, note: from } };
  const label = footnoteLabel(doc, node);
  if (node.name === 'FootnoteRef') {
    if (index.number(label) === null) return null;
    const definition = index.definition(label)!;
    return {
      ...found,
      footnote: { role: 'reference', goTo: noteTextStart(file.doc, definition), note: definition.from },
    };
  }
  // A definition's number goes back to the first reference, which may lie past the stored parse.
  const first = index.firstReference(label);
  return first ? { ...found, footnote: { role: 'number', goTo: first.to, note: null } } : null;
}

// ---------------------------------------------------------------------------
// The link at a position

/** Nodes whose links are drawn by someone else (a table and a grid table draw their own cells). */
const OWN_DRAWING = new Set([...OPAQUE_BLOCKS, 'Table', 'GridTable']);

/**
 * The link node `n` of `doc` stands for, its positions placed in `file` by `at`: undefined when
 * it is no link node, null when it is one that is text.
 */
function targetOfNode(file: EditorState, doc: Text, n: SyntaxNode, at: Place): LinkTarget | null | undefined {
  switch (n.name) {
    case 'Link': {
      const parts = linkParts(doc, n, definitionLookup(file, true));
      if (!parts) return null;
      return { kind: kindOf(parts.href), href: parts.href, from: at(n.from), to: at(n.to), title: parts.title };
    }
    case 'Autolink': {
      const url = n.getChild('URL');
      if (!url) return null;
      const href = bareHref(doc.sliceString(url.from, url.to));
      return { kind: kindOf(href), href, from: at(n.from), to: at(n.to) };
    }
    case 'URL': {
      const parent = n.parent?.name;
      if (parent === 'Link' || parent === 'Image' || parent === 'Autolink') return undefined;
      if (parent === 'LinkReference') {
        const href = stripAngles(doc.sliceString(n.from, n.to));
        return { kind: kindOf(href), href, from: at(n.from), to: at(n.to) };
      }
      const href = bareHref(doc.sliceString(n.from, n.to));
      return { kind: kindOf(href), href, from: at(n.from), to: at(n.to) };
    }
    case 'Wikilink':
    case 'Embed':
      return wikilinkAt(doc, n, at);
    case 'FootnoteRef':
    case 'FootnoteLabel':
    case 'InlineFootnote':
      return footnoteAt(file, doc, n, at);
    default:
      return undefined;
  }
}

/**
 * The `<a href>` link written as HTML among `block`'s inline nodes (of `doc`, placed in `file`
 * by `at`) that holds `pos` on `side`, when VS Code trusts the workspace (HTML is drawn only then).
 */
function htmlLinkAt(
  file: EditorState,
  doc: Text,
  block: SyntaxNode,
  pos: number,
  side: -1 | 1,
  at: Place,
): LinkTarget | undefined {
  if (!(block.type.is('Block') || block.name === 'TableCell') || !file.facet(panelContext)?.settings.workspaceTrusted)
    return undefined;
  for (const link of htmlLinksIn(doc, block)) {
    if (side > 0 ? pos >= link.from && pos < link.to : pos > link.from && pos <= link.to)
      return { kind: kindOf(link.href), href: link.href, from: at(link.from), to: at(link.to) };
  }
  return undefined;
}

/** The link at `pos` on `side` in the cell of the grid table `node` that holds it, as the cell draws it. */
function gridLinkAt(state: EditorState, node: SyntaxNode, pos: number, side: -1 | 1): LinkTarget | null {
  const grid = fileGrid(state, node);
  const hit = grid && cellAt(state, grid, pos);
  if (!hit) return null;
  const { doc, tree, at } = hit.parsed;
  for (let n: SyntaxNode | null = tree.resolveInner(hit.pos, side); n && !n.type.isTop; n = n.parent) {
    if (!drawnInCell(n)) return null;
    const here = targetOfNode(state, doc, n, at);
    if (here === null) return null;
    const link = here ?? htmlLinkAt(state, doc, n, hit.pos, side, at);
    if (link) return link;
  }
  return null;
}

/**
 * The link at `pos`: the innermost link holding the position on that side (1: the character
 * after `pos`, -1: before it, 0: either), a link written as HTML (`<a href>`) included. Null
 * when there is none, or when it is a reference to an undefined label, or inside a table,
 * which draws its own: the table asks with `inCell` for the link a click in a cell is on.
 */
export function linkAt(state: EditorState, pos: number, side: -1 | 0 | 1 = 0, inCell = false): LinkTarget | null {
  const tree = treeForLine(state, pos);
  const doc = state.doc;
  for (const s of side === 0 ? ([1, -1] as const) : [side]) {
    let found: LinkTarget | null = null;
    for (let n: SyntaxNode | null = tree.resolveInner(pos, s); n; n = n.parent) {
      if (inCell && n.name === 'TableCell') {
        found ??= htmlLinkAt(state, doc, n, pos, s, IN_FILE) ?? null;
        break;
      }
      if (inCell && n.name === 'GridTable') {
        found = gridLinkAt(state, n, pos, s);
        break;
      }
      if (OWN_DRAWING.has(n.name)) {
        found = null;
        break;
      }
      if (found) continue; // still climbing, to see whether a table holds it
      const here = targetOfNode(state, doc, n, IN_FILE);
      if (here === null) break;
      const link = here ?? htmlLinkAt(state, doc, n, pos, s, IN_FILE);
      if (link) found = link;
    }
    if (found) return found;
  }
  return null;
}

/** `read`, a reading of the link under the pointer in `state`: a failure is logged and gives null. */
export function readPointerLink<T>(state: EditorState, read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    state.facet(panelContext)?.log('error', 'Reading the link under the pointer failed', error);
    return null;
  }
}
