// Front matter: the block of data at the start of the file (YAML between `---` lines, TOML
// between `+++` lines, JSON behind a setting), drawn by `settings.frontmatterDisplay`:
//   table   (default) a table of names and values; nested maps draw as nested tables and lists
//           as lists. A pencil button (Rich editor), or the selection entering the block, shows
//           the raw text. YAML that does not parse, or is not a map of names, shows as raw text.
//   source  always the raw text, faded monospace.
//   hidden  not drawn in Rich view; in Rich editor a one-line "Front matter" bar that opens it.
//
// YAML is read by the `yaml` package, loaded when a file with YAML front matter is first drawn
// (until then the block shows as raw text), TOML by render/toml.ts and JSON by the browser, for
// display only. Names and values go in with textContent; a plain scalar shows as written (`3.0`
// stays `3.0`), a quoted or block one as its text. Value wikilinks: render/frontmatterLinks.ts.

import { EditorView } from '@codemirror/view';
import type * as Yaml from 'yaml';
import type { Feature } from '../features';
import { frontmatterForm } from '../markdown/frontmatter';
import { onDemand } from '../onDemand';
import { iconButton } from '../ui/dom';
import { CORNER_BUTTON, CORNER_BUTTON_HOVER } from './drawnBlock';
import { blockFeature, leaveSelectionOnClick, posOf, RichWidget, type BlockDraw } from './framework';
import { linkedText, valueLinks, type ValueLinks } from './frontmatterLinks';
import type { BlockEntry } from './lines';
import { tomlEntries } from './toml';

/** The YAML reader, which `frontmatterEntries` needs. */
export const yamlReader = onDemand(() => import('yaml'));

/** A value as drawn: text, a list, or a nested map. */
export type FrontmatterValue =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: FrontmatterValue[] }
  | { kind: 'map'; entries: FrontmatterEntry[] };

export interface FrontmatterEntry {
  name: string;
  value: FrontmatterValue;
}

function scalarText(y: typeof Yaml, node: Yaml.Scalar): string {
  if (node.type === y.Scalar.PLAIN && typeof node.source === 'string') return node.source;
  const value = node.value;
  if (typeof value === 'string')
    return node.type === y.Scalar.BLOCK_LITERAL || node.type === y.Scalar.BLOCK_FOLDED
      ? value.replace(/\n$/, '')
      : value;
  return value === null || value === undefined ? '' : String(value);
}

function valueOf(y: typeof Yaml, node: unknown): FrontmatterValue {
  if (y.isMap(node))
    return {
      kind: 'map',
      entries: node.items.map((pair) => ({ name: nameOf(y, pair.key), value: valueOf(y, pair.value) })),
    };
  if (y.isSeq(node)) return { kind: 'list', items: node.items.map((item) => valueOf(y, item)) };
  if (y.isScalar(node)) return { kind: 'text', text: scalarText(y, node) };
  if (y.isAlias(node)) return { kind: 'text', text: `*${node.source}` };
  return { kind: 'text', text: node === null || node === undefined ? '' : String(node) };
}

function nameOf(y: typeof Yaml, key: unknown): string {
  if (y.isScalar(key)) return scalarText(y, key);
  if (y.isAlias(key)) return `*${key.source}`;
  return key === null || key === undefined ? '' : String(key);
}

/**
 * The names and values of a front matter block's YAML, or null when it does not parse or is
 * not a map of names (empty, a list, a single value). Undefined until `yamlReader` has loaded.
 */
export function frontmatterEntries(text: string): FrontmatterEntry[] | null | undefined {
  const yaml = yamlReader.loaded();
  if (!yaml) return undefined;
  let doc;
  try {
    doc = yaml.parseDocument(text, { prettyErrors: false });
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || !yaml.isMap(doc.contents) || doc.contents.items.length === 0) return null;
  const value = valueOf(yaml, doc.contents);
  return value.kind === 'map' ? value.entries : null;
}

/** A JSON value parsed with each number, `true`, `false` and `null` kept as written. */
function jsonValue(value: unknown): FrontmatterValue {
  if (Array.isArray(value)) return { kind: 'list', items: value.map(jsonValue) };
  if (value && typeof value === 'object' && !(value instanceof Written)) {
    return { kind: 'map', entries: Object.entries(value).map(([name, v]) => ({ name, value: jsonValue(v) })) };
  }
  return { kind: 'text', text: value instanceof Written ? value.text : String(value) };
}

/** A JSON scalar as written; the reviver of `JSON.parse` is given its source text. */
class Written {
  constructor(readonly text: string) {}
}

/** The names and values of a JSON object, or null when the text is not one or holds none. */
function jsonEntries(text: string): FrontmatterEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'string'
        ? value
        : value === null || typeof value !== 'object'
          ? new Written(context?.source ?? String(value))
          : value,
    );
  } catch {
    return null;
  }
  const value = jsonValue(parsed);
  return value.kind === 'map' && value.entries.length ? value.entries : null;
}

/** The names and values of `block`'s data: null when they do not read, undefined until the reader has loaded. */
function entriesOf(d: BlockDraw, block: BlockEntry): FrontmatterEntry[] | null | undefined {
  const form = frontmatterForm(d.lines.text(block.firstLine));
  if (form === 'bareJson') return jsonEntries(d.doc.sliceString(block.from, block.to));
  const inner =
    block.lastLine - block.firstLine < 2
      ? ''
      : d.doc.sliceString(d.lines.start(block.firstLine + 1), d.lines.end(block.lastLine - 1));
  if (form === 'toml') return tomlEntries(inner);
  if (form === 'json') return jsonEntries(inner);
  return frontmatterEntries(inner);
}

// ---------------------------------------------------------------------------
// Widgets

/** Puts the cursor on the front matter's first YAML line (the block shows as raw text) and focuses the editor. */
function openRaw(view: EditorView, dom: HTMLElement): void {
  const from = posOf(view, dom);
  if (from === null) return;
  const first = view.state.doc.lineAt(from);
  const at = first.number < view.state.doc.lines ? view.state.doc.line(first.number + 1).from : first.to;
  view.dispatch({ selection: { anchor: at }, userEvent: 'select' });
  view.focus();
}

/** A button that opens the raw text of the front matter drawn in `dom`, leaving focus where it is on mouse-down. */
function openButton(
  view: EditorView,
  dom: HTMLElement,
  className: string,
  label: string,
  icon: string,
): HTMLButtonElement {
  const element = iconButton(view.dom.ownerDocument, { icon, label, className, keepFocus: true });
  element.tabIndex = -1;
  element.addEventListener('click', (event) => {
    event.preventDefault();
    openRaw(view, dom);
  });
  return element;
}

/** Draws a value's text: as text, or with its wikilinks as links (render/frontmatterLinks.ts). */
type DrawText = (text: string) => Node;

function drawValue(doc: Document, value: FrontmatterValue, text: DrawText): Node {
  if (value.kind === 'text') return text(value.text);
  if (value.kind === 'list') {
    const list = doc.createElement('ul');
    list.className = 'tm-fm-list';
    for (const item of value.items) {
      const li = doc.createElement('li');
      li.appendChild(drawValue(doc, item, text));
      list.appendChild(li);
    }
    return list;
  }
  return drawTable(doc, value.entries, true, text);
}

/** Calls `visit` with the text of every value of `entries`, however deep. */
function eachText(entries: readonly FrontmatterEntry[], visit: (text: string) => void): void {
  const walk = (value: FrontmatterValue): void => {
    if (value.kind === 'text') visit(value.text);
    else if (value.kind === 'list') value.items.forEach(walk);
    else eachText(value.entries, visit);
  };
  for (const entry of entries) walk(entry.value);
}

function drawTable(
  doc: Document,
  entries: readonly FrontmatterEntry[],
  nested: boolean,
  text: DrawText,
): HTMLTableElement {
  const table = doc.createElement('table');
  table.className = nested ? 'tm-fm-table tm-fm-nested' : 'tm-fm-table';
  const body = table.createTBody();
  for (const entry of entries) {
    const row = body.insertRow();
    const name = doc.createElement('th');
    name.scope = 'row';
    name.textContent = entry.name;
    const value = doc.createElement('td');
    value.appendChild(drawValue(doc, entry.value, text));
    row.append(name, value);
  }
  return table;
}

function countRows(entries: readonly FrontmatterEntry[]): number {
  let rows = 0;
  const count = (v: FrontmatterValue): number =>
    v.kind === 'text' ? 1 : v.kind === 'list' ? v.items.reduce((n, i) => n + count(i), 0) : countRows(v.entries);
  for (const entry of entries) rows += Math.max(1, count(entry.value));
  return rows;
}

class FrontmatterTable extends RichWidget {
  constructor(
    source: string,
    readonly entries: FrontmatterEntry[],
    /** The table has a pencil that opens the raw text (Rich editor, a document that can be edited). */
    readonly opens: boolean,
    readonly links: ValueLinks | null,
  ) {
    super(source);
  }

  override sameAs(other: FrontmatterTable): boolean {
    return (
      other.opens === this.opens &&
      other.links?.textFirst === this.links?.textFirst &&
      other.links?.key === this.links?.key
    );
  }

  override get estimatedHeight(): number {
    return countRows(this.entries) * 30 + 8;
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'tm-fm';
    const links = this.links;
    const text: DrawText = links ? (value) => linkedText(view, value, links) : (value) => doc.createTextNode(value);
    box.appendChild(drawTable(doc, this.entries, false, text));
    if (this.opens) box.appendChild(openButton(view, box, 'tm-fm-edit', 'Edit front matter', 'edit'));
    leaveSelectionOnClick(view, box);
    return box;
  }

  override ignores(): boolean {
    return true;
  }
}

class FrontmatterBar extends RichWidget {
  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'tm-fm-bar';
    const open = openButton(view, box, 'tm-fm-open', 'Show front matter', 'chevron-right');
    const words = doc.createElement('span');
    words.textContent = 'Front matter';
    open.appendChild(words);
    box.appendChild(open);
    return box;
  }

  override get estimatedHeight(): number {
    return 26;
  }

  override ignores(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// The feature

/** The raw text, faded monospace; `open` when the selection is in it (Rich editor), so it reads at full strength. */
function raw(d: BlockDraw, block: BlockEntry, open: boolean): void {
  const fenced = block.node.firstChild?.name === 'FrontmatterMark';
  for (let n = block.firstLine; n <= block.lastLine; n++) {
    let classes = open ? 'tm-frontmatter tm-frontmatter-open' : 'tm-frontmatter';
    if (fenced && (n === block.firstLine || n === block.lastLine)) classes += ' tm-frontmatter-mark';
    d.line(d.lines.start(n), classes);
  }
}

const theme = EditorView.baseTheme({
  '& .cm-content .tm-fm': { position: 'relative', paddingRight: '28px' },
  '& .cm-content .tm-fm-table': {
    borderCollapse: 'collapse',
    borderSpacing: '0',
    fontSize: '0.9em',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  '& .cm-content .tm-fm-table th, & .cm-content .tm-fm-table td': {
    border: '1px solid var(--tm-border)',
    padding: '4px 10px',
    textAlign: 'start',
    verticalAlign: 'top',
  },
  '& .cm-content .tm-fm-table th': { fontWeight: '600', color: 'var(--tm-faded)', whiteSpace: 'nowrap' },
  '& .cm-content .tm-fm-nested': { fontSize: '1em', margin: '-1px 0' },
  '& .cm-content .tm-fm-list': { margin: '0', paddingLeft: '1.4em' },
  '& .cm-content .tm-fm-edit': { position: 'absolute', top: '0', right: '0', ...CORNER_BUTTON },
  '& .cm-content .tm-fm-edit:hover, & .cm-content .tm-fm-open:hover': CORNER_BUTTON_HOVER,
  '& .cm-content .tm-fm-open': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px 2px 4px',
    border: 'none',
    borderRadius: '3px',
    background: 'none',
    color: 'var(--tm-faded)',
    font: 'inherit',
    fontSize: '0.85em',
    cursor: 'pointer',
  },
});

export const frontmatter: Feature = {
  id: 'frontmatter',
  extension: (ctx) => [
    blockFeature('frontmatter', (d) => {
      d.blocks((block) => {
        if (block.name !== 'Frontmatter') return;
        // At once, not when the page is idle: a note that opens with front matter shows it drawn.
        if (!yamlReader.loaded() && frontmatterForm(d.lines.text(block.firstLine)) === 'yaml') {
          d.drawWhenLoaded(yamlReader, 'now');
        }
        const display = ctx.settings.frontmatterDisplay;
        if (display === 'source') return raw(d, block, false);
        if (display === 'hidden' && d.mode === 'view') return d.hideLines(block.from, block.to);
        const source = d.doc.sliceString(block.from, block.to);
        if (d.blockRevealed(block.from, block.to)) return raw(d, block, true);
        if (display === 'hidden') return d.replaceLines(block.from, block.to, new FrontmatterBar(source));
        const entries = entriesOf(d, block);
        if (!entries) return raw(d, block, false);
        const links = valueLinks(ctx, d.mode, (visit) => eachText(entries, visit));
        d.replaceLines(
          block.from,
          block.to,
          new FrontmatterTable(source, entries, d.mode === 'edit' && !ctx.doc.readOnly, links),
        );
      });
    }),
    theme,
  ],
};
