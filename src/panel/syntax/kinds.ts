// What a reader sees, by kind, as the syntax cases name it (`drawn` in test/panel/syntax/cases/),
// and how the page draws each kind. The cases name kinds; only this file knows the page's
// classes, so a class renamed or a drawing restructured changes this file and no case.
//
// A kind is counted once for each thing a reader would count: an element the page draws for it,
// a run of lines the page styles as one block, or one quote, box or callout, nested ones too.
// Nothing in the panel imports this file: test/panel/syntax/cases.test.ts reads the names, and
// harness/lab.ts and harness/harness.ts give `countKinds` to the browser specs.

/** How the page draws a kind, and so how it is counted. */
type Drawing =
  /** One element matching the selector for each. */
  | { readonly elements: string }
  /** One run of consecutive lines matching the selector for each. */
  | { readonly lines: string }
  /**
   * One quote, box or callout for each with that look (`quote`, `box`, or `callout:` and the
   * callout's type), of any look (`any`), or of any look inside another (`inner`).
   */
  | { readonly holder: string };

/** The callout types the cases name, each a look the page gives a quote or a box. */
const CALLOUT_TYPES = [
  'abstract',
  'caution',
  'danger',
  'important',
  'info',
  'note',
  'question',
  'tip',
  'todo',
  'warning',
] as const;

/** The highlight colors the page draws, each from the emoji that starts the highlight's text. */
const HIGHLIGHT_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

const callouts = Object.fromEntries(
  CALLOUT_TYPES.map((type) => [`${type} callout`, { holder: `callout:${type}` }]),
) as Record<`${(typeof CALLOUT_TYPES)[number]} callout`, Drawing>;

const highlights = Object.fromEntries(
  HIGHLIGHT_COLORS.map((color) => [`${color} highlight`, { elements: `.tm-highlight-${color}` }]),
) as Record<`${(typeof HIGHLIGHT_COLORS)[number]} highlight`, Drawing>;

/** Every kind, by the name the cases give it. */
export const KINDS = {
  // Text in a line
  bold: { elements: '.tm-strong' },
  italic: { elements: '.tm-em' },
  strikethrough: { elements: '.tm-strike' },
  underline: { elements: '.tm-underline, .tm-html-u' },
  'small capitals': { elements: '.tm-smallcaps' },
  subscript: { elements: '.tm-sub, .tm-html-sub' },
  superscript: { elements: '.tm-sup, .tm-html-sup' },
  highlight: { elements: '.tm-highlight, .tm-html-mark' },
  ...highlights,
  code: { elements: '.tm-code' },
  key: { elements: '.tm-html-kbd' },
  'line break': { elements: '.tm-html-br' },
  emoji: { elements: '.tm-emoji' },
  tag: { elements: '.tm-tag' },
  abbreviation: { elements: '.tm-abbr' },
  'inserted text': { elements: '.tm-critic-add' },
  'deleted text': { elements: '.tm-critic-del' },
  'comment on a change': { elements: '.tm-critic-comment' },
  'HTML tag shown as code': { elements: '.tm-html-inline' },

  // Links and notes
  link: { elements: '.tm-link:not(.tm-footnote-ref, .tm-footnote-number), .tm-wikilink' },
  'link to a missing note': { elements: '.tm-wikilink-missing' },
  'footnote reference': { elements: '.tm-footnote-ref' },
  'footnote text': { elements: '.tm-footnote-number' },
  'contents list': { elements: '.tm-drawn-contents' },
  'contents entry': { elements: '.tm-contents-link' },
  'embedded note': { elements: '.tm-drawn-embed' },

  // Pictures, players, math and diagrams
  picture: { elements: 'img.tm-image-img' },
  'picture not shown': { elements: '.tm-image-failed' },
  'centered picture': { elements: '.tm-image-center' },
  'picture for the dark theme': { elements: '.tm-only-dark' },
  'picture for the light theme': { elements: '.tm-only-light' },
  player: { elements: '.tm-media-player' },
  formula: { elements: '.tm-math .katex' },
  'math block': { elements: '.tm-drawn .katex-display' },
  diagram: { elements: '.tm-drawn-diagram .tm-diagram' },
  'merge conflict': { elements: '.tm-drawn-conflict .tm-conflict' },
  'drawing that failed': { elements: '.tm-drawn-failed' },

  // Blocks
  'level 1 heading': { elements: '.cm-line.tm-h1' },
  'level 2 heading': { elements: '.cm-line.tm-h2' },
  'level 3 heading': { elements: '.cm-line.tm-h3' },
  rule: { elements: '.cm-line.tm-hr' },
  'bulleted item': { elements: '.tm-bullet' },
  'numbered item': { elements: '.tm-ordered' },
  checkbox: { elements: 'input.tm-task' },
  'task mark': { elements: '.tm-task-mark' },
  'code block': { elements: '.cm-line.tm-code-first' },
  table: { elements: 'table.tm-table' },
  'front matter table': { elements: 'table.tm-fm-table:not(.tm-fm-nested)' },
  'table in front matter': { elements: '.tm-fm-nested' },
  'list in front matter': { elements: '.tm-fm-list' },
  'front matter shown as source': { lines: '.tm-frontmatter' },
  'definition term': { elements: '.cm-line.tm-dt' },
  definition: { lines: '.tm-dd' },
  quote: { holder: 'quote' },
  box: { holder: 'box' },
  ...callouts,
  'quote, box or callout': { holder: 'any' },
  'quote or box inside another': { holder: 'inner' },
  'box title': { elements: '.tm-callout-head, .tm-box-head' },
  'fold button': { elements: '.tm-callout-fold, .tm-details-toggle' },
  'folding section': { elements: '.tm-drawn-summary' },
  'drawn HTML': { elements: '.tm-drawn-html' },
  'HTML shown as code': { lines: '.tm-html' },
  'centered text': { lines: '.tm-align-center' },
  'text aligned left': { lines: '.tm-align-left' },
  'text aligned right': { lines: '.tm-align-right' },
} as const satisfies Record<string, Drawing>;

type KindName = keyof typeof KINDS;

export function isKind(name: string): name is KindName {
  return Object.prototype.hasOwnProperty.call(KINDS, name);
}

/** Each editor's lines under `root` (an editor embedded in another has its own), in order. */
function lineRuns(root: ParentNode): Element[][] {
  const contents = [...root.querySelectorAll('.cm-content')];
  if (root instanceof Element && root.matches('.cm-content')) contents.unshift(root);
  return contents.map((content) => [...content.children].filter((child) => child.classList.contains('cm-line')));
}

/** How many runs of consecutive lines match `selector`. */
function countRuns(root: ParentNode, selector: string): number {
  let count = 0;
  for (const lines of lineRuns(root)) {
    let inside = false;
    for (const line of lines) {
      const matches = line.matches(selector);
      if (matches && !inside) count++;
      inside = matches;
    }
  }
  return count;
}

/** A line's class that names a callout's type: `tm-callout-<type>`, but not the title line's class. */
const CALLOUT_CLASS = /^tm-callout-(?!title-line$)(.+)$/;

/** The look of the quote, box or callout innermost around `line`, and how deep it is; null outside any. */
function holderOf(line: Element): { look: string; depth: number } | null {
  if (!line.classList.contains('tm-quote')) return null;
  let depth = 1;
  let look = 'quote';
  for (const name of line.classList) {
    const deep = /^tm-qd(\d+)$/.exec(name);
    if (deep) depth = Number(deep[1]);
    if (name === 'tm-box-plain') look = 'box';
    const callout = CALLOUT_CLASS.exec(name);
    if (callout) look = `callout:${callout[1]!}`;
  }
  return { look, depth };
}

/**
 * How many quotes, boxes or callouts with `look` (for `any`, of any look; for `inner`, of any
 * look inside another) the lines under `root` hold. Every line carries only its innermost
 * holder's look and depth, so a holder is counted where a line first shows it at its depth, and
 * stays open while the lines after it are at that depth with that look or deeper.
 */
function countHolders(root: ParentNode, look: string): number {
  let count = 0;
  for (const lines of lineRuns(root)) {
    const open = new Map<number, string>();
    for (const line of lines) {
      const holder = holderOf(line);
      if (!holder) {
        open.clear();
        continue;
      }
      for (const depth of [...open.keys()]) if (depth > holder.depth) open.delete(depth);
      if (open.get(holder.depth) === holder.look) continue;
      open.set(holder.depth, holder.look);
      if (look === 'any' || (look === 'inner' ? holder.depth > 1 : holder.look === look)) count++;
    }
  }
  return count;
}

/** How many of each kind in `names` the page shows under `root`, in the order given. */
export function countKinds(root: ParentNode, names: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) {
    if (!isKind(name)) throw new Error(`"${name}" is not a kind in src/panel/syntax/kinds.ts`);
    const drawing: Drawing = KINDS[name];
    counts[name] =
      'elements' in drawing
        ? root.querySelectorAll(drawing.elements).length
        : 'lines' in drawing
          ? countRuns(root, drawing.lines)
          : countHolders(root, drawing.holder);
  }
  return counts;
}
