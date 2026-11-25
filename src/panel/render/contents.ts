// A live contents list: `[TOC]`, `[toc]`, `[[_TOC_]]` or VitePress's `[[toc]]` (in any letter
// case) on a line of its own, at the top level of the file, is a drawn block
// (render/drawnBlock.ts) showing the file's headings as a nested list, each a link to its
// heading. A marker that is a reference link (`[toc]` with a definition) stays a link, so the
// feature is drawn again when that definition comes or goes; so does `[[toc]]` once the host
// says a note answers it as a wikilink, and the feature is drawn again when that answer comes.
//
// The headings are the outline's (src/core/outline.ts), read again DRAW_PAUSE_MS after the
// typing stops, never on a keystroke (`HeadingWatcher`); a contents list depends on headings
// anywhere in the file, so the feature is drawn again when they change. A link opens as links
// do: a click in Rich view, Ctrl+click (Cmd+click on a Mac) in Rich editor, Enter on one that
// has focus. With the emoji setting on, a heading's emoji codes show as the heading draws them.

import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type ChangeSet, type EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { TreeFragment, type ChangedRange, type PartialParse, type SyntaxNode, type Tree } from '@lezer/common';
import { findFrontmatterEnd } from '../../core/frontmatter';
import { buildOutline, outlineOf, sameHeadings, startOutlineParse, type OutlineItem } from '../../core/outline';
import type { PlainTextOptions, WikilinksMode } from '../../core/plainText';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { definitionLookup, definitionsField, linkParts, wikilinkOf } from '../links/read';
import { getMode } from '../modes';
import { syntaxOn } from '../syntax';
import { revealHeadingSpec } from '../ui/reveal';
import { DRAW_PAUSE_MS, drawBlock, drawnBlockKeys, drawnBlockTheme, type DrawnKind } from './drawnBlock';
import { emojiCodes, emojiNames, emojiOn } from './emoji';
import { keysFollowLink } from './follow';
import { blockFeature, posOf, redrawFeatureEffect } from './framework';
import { wantWikilinks, wikilinkResolution } from './wikilinks';

/** The markers, as they stand alone on their line. */
const MARKERS = new Set(['[TOC]', '[toc]', '[[_TOC_]]']);
/** VitePress's marker, in the letter cases its contents plugin accepts: any. */
const WIKI_MARKER = /^\[\[toc\]\]$/i;
/** The longest paragraph that can be a marker: the longest marker and spaces after it. */
const MARKER_MAX = 20;
/** A file this long or shorter has its headings read as its state is made, so its list is drawn at once. */
const READ_AT_ONCE = 100_000;
/** The longest slice of the outline's parse, in milliseconds, before the page is given back. */
const PARSE_SLICE_MS = 20;
/** The longest wait for the page to fall idle before the next slice runs anyway. */
const IDLE_WAIT_MS = 200;

interface Heading {
  level: number;
  text: string;
  /** Where the heading's line starts, kept current as the text changes. */
  from: number;
}

/** The marker `paragraph` holds alone, or null; it may still be a defined reference link. */
function markerShape(state: EditorState, paragraph: SyntaxNode): string | null {
  if (paragraph.to - paragraph.from > MARKER_MAX) return null;
  const marker = state.doc.sliceString(paragraph.from, paragraph.to).trim();
  return MARKERS.has(marker) || WIKI_MARKER.test(marker) ? marker : null;
}

/** The marker `paragraph` is, or null: a paragraph of one marker alone, which is not a defined reference link. */
function markerOf(state: EditorState, paragraph: SyntaxNode): string | null {
  const marker = markerShape(state, paragraph);
  if (!marker) return null;
  const link = paragraph.firstChild;
  if (link?.name === 'Link' && linkParts(state.doc, link, definitionLookup(state))) return null;
  return marker;
}

/**
 * Whether `[[toc]]`, read as a wikilink in `paragraph`, links to a note: once the host says a
 * note answers its target. Until the host has answered, and when no note answers, the marker
 * is a contents list.
 */
function linksToNote(ctx: PanelContext, state: EditorState, paragraph: SyntaxNode): boolean {
  const link = paragraph.firstChild;
  if (link?.name !== 'Wikilink') return false;
  const { target } = wikilinkOf(state.doc, link);
  wantWikilinks(ctx, [target]);
  const answer = wikilinkResolution(ctx, target);
  return answer !== undefined && answer.status !== 'missing';
}

/** Whether a top-level paragraph of `state` is a marker (with `shape`, has a marker's shape), as far as the text is parsed. */
function hasMarker(state: EditorState, shape = false): boolean {
  const cursor = syntaxTree(state).cursor();
  if (!cursor.firstChild()) return false;
  do if (cursor.name === 'Paragraph' && (shape ? markerShape : markerOf)(state, cursor.node)) return true;
  while (cursor.nextSibling());
  return false;
}

/**
 * Whether the file defines the label `toc`, which makes `[TOC]` and `[toc]` links; asked only
 * of a file with a paragraph of a marker's shape, so a file with none reads no definitions for it.
 */
function tocDefined(state: EditorState): boolean {
  return hasMarker(state, true) && definitionLookup(state).get('TOC') !== undefined;
}

function headingsOf(items: readonly OutlineItem[]): Heading[] {
  return items.map(({ level, text, from }) => ({ level, text, from }));
}

/** Gives a state the headings to draw contents lists from. */
export const setHeadings = StateEffect.define<Heading[]>();

function plainOptions(state: EditorState, wanted?: () => void): PlainTextOptions {
  const settings = state.facet(panelContext)?.settings;
  const w = settings?.syntax['wikilinks'];
  const wikilinks: WikilinksMode = w === 'textFirst' || w === 'off' ? w : 'noteFirst';
  return {
    emoji: emojiCodes(state, wanted),
    math: settings ? syntaxOn(settings, 'math') : true,
    wikilinks,
  };
}

function syntaxKey(state: EditorState): string {
  const settings = state.facet(panelContext)?.settings;
  return `${emojiOn(state)}|${settings ? syntaxOn(settings, 'math') : true}|${String(settings?.syntax['wikilinks'] ?? 'noteFirst')}`;
}

/**
 * The file's headings as last read, or null before they are read. Those read as the state is
 * made keep their codes as typed when the emoji list has not loaded; `HeadingWatcher`, reading
 * them again once the page is idle, asks for the list.
 */
export const headingsField = StateField.define<Heading[] | null>({
  create: (state) =>
    state.doc.length <= READ_AT_ONCE && hasMarker(state)
      ? headingsOf(buildOutline(state.doc.toString(), plainOptions(state)))
      : null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHeadings)) return effect.value;
    if (!value || !tr.docChanged) return value;
    return value.map((h) => ({ ...h, from: tr.changes.mapPos(h.from) }));
  },
});

/**
 * Reads the headings again once the typing pauses, and draws the contents again when they
 * changed; until a marker is found, also as more of the file is parsed; and once the emoji list
 * a reading asked for has loaded, or the emoji, math, or wikilinks setting changes. The headings come from a parse
 * of the outline's own, apart from the editor's tree (which in a long file covers only what is
 * near the window), advanced PARSE_SLICE_MS at a time and reusing what the last one found where
 * the text did not change. Exported for the headless tests, which drive it with a stand-in view.
 */
export class HeadingWatcher {
  private cancel: (() => void) | null = null;
  private defined: boolean;
  /** Snapshot of emoji/math/wikilinks settings at the last look, so a change reads headings again. */
  private syntax: string;
  /** Whether a reading has asked for the emoji list: it is loaded once, and the headings read again then. */
  private emojiAsked = false;
  private destroyed = false;
  /** The last finished parse, in pieces, where its front matter ended, and the changes made to the text since it. */
  private fragments: readonly TreeFragment[] = [];
  private frontmatterEnd = -1;
  private since: ChangeSet | null = null;
  /** A parse under way, of the text as it was when it started, and where that text's front matter ends. */
  private parsing: { parse: PartialParse; text: string; frontmatterEnd: number } | null = null;

  constructor(private readonly view: EditorView) {
    this.defined = tocDefined(view.state);
    this.syntax = syntaxKey(view.state);
    this.whenIdle();
  }
  update(update: ViewUpdate): void {
    const syntax = syntaxKey(update.state);
    if (update.docChanged) {
      this.since = this.since ? this.since.compose(update.changes) : update.changes;
      this.parsing = null;
      this.schedule(DRAW_PAUSE_MS);
    } else if (syntax !== this.syntax) {
      this.schedule(DRAW_PAUSE_MS);
    } else if (syntaxTree(update.startState) !== syntaxTree(update.state) && !this.found()) {
      this.schedule(DRAW_PAUSE_MS);
    }
    this.syntax = syntax;
  }
  /**
   * Loads the emoji list the first time a reading meets a code before it has loaded, and reads
   * again once it has: when the page is next idle, or at the end of a pause in the typing when
   * a reading already waits for one.
   */
  private wantEmoji(): void {
    if (this.emojiAsked) return;
    this.emojiAsked = true;
    emojiNames.load().then(
      () => {
        if (!this.destroyed && !this.cancel) this.whenIdle();
      },
      (error: unknown) =>
        this.view.state.facet(panelContext)?.log('error', 'The contents list could not load the emoji list', error),
    );
  }
  private found(): boolean {
    return this.view.state.field(headingsField) !== null;
  }
  private schedule(ms: number): void {
    this.cancel?.();
    const timer = setTimeout(() => this.read(), ms);
    this.cancel = () => clearTimeout(timer);
  }
  /** Reads, or parses on, once the page has nothing else to do, so drawing and typing come first. */
  private whenIdle(): void {
    if (typeof requestIdleCallback !== 'function') return this.schedule(0);
    this.cancel?.();
    const id = requestIdleCallback(() => this.read(), { timeout: IDLE_WAIT_MS });
    this.cancel = () => cancelIdleCallback(id);
  }
  private read(): void {
    this.cancel = null;
    const { state } = this.view;
    // A definition of `toc` coming or going changes what a marker is.
    const defined = tocDefined(state);
    const redraw = defined !== this.defined;
    this.defined = defined;
    let headings: Heading[] | null = null;
    if (hasMarker(state)) {
      headings = this.parseOn(state);
      if (!headings) {
        if (redraw) this.view.dispatch({ effects: redrawFeatureEffect.of('contents') });
        this.whenIdle();
        return;
      }
    }
    const shown = state.field(headingsField);
    const changed = headings !== null && (shown === null || !sameHeadings(shown, headings));
    if (!changed && !redraw) return;
    this.view.dispatch({
      effects: [...(headings && changed ? [setHeadings.of(headings)] : []), redrawFeatureEffect.of('contents')],
    });
  }
  /** Advances the outline's parse by a slice; the headings once it has reached the end, else null. */
  private parseOn(state: EditorState): Heading[] | null {
    if (!this.parsing) {
      const changed: ChangedRange[] = [];
      this.since?.iterChangedRanges((fromA, toA, fromB, toB) => changed.push({ fromA, toA, fromB, toB }));
      const text = state.doc.toString();
      // The outline's parse blanks the front matter: where it ends moving changes text no edit touched.
      const end = findFrontmatterEnd(text);
      const before =
        this.frontmatterEnd < 0 || !this.since ? this.frontmatterEnd : this.since.mapPos(this.frontmatterEnd);
      const reused = end === before ? TreeFragment.applyChanges(this.fragments, changed) : [];
      this.parsing = { parse: startOutlineParse(text, reused), text, frontmatterEnd: end };
    }
    const { parse, text, frontmatterEnd } = this.parsing;
    const stop = performance.now() + PARSE_SLICE_MS;
    let tree: Tree | null = null;
    while (!tree && performance.now() < stop) tree = parse.advance();
    if (!tree) return null;
    this.fragments = TreeFragment.addTree(tree);
    this.frontmatterEnd = frontmatterEnd;
    this.since = null;
    this.parsing = null;
    return headingsOf(
      outlineOf(
        tree,
        text,
        plainOptions(state, () => this.wantEmoji()),
      ),
    );
  }
  destroy(): void {
    this.destroyed = true;
    this.cancel?.();
  }
}

const watchHeadings = ViewPlugin.fromClass(HeadingWatcher);

/** The text a contents list is drawn from: its marker, whether the headings are read, then a line per heading. */
function contentsText(marker: string, headings: readonly Heading[] | null): string {
  if (!headings) return `${marker}\nreading`;
  return [marker, 'read', ...headings.map((h) => `${h.level}\t${h.text}`)].join('\n');
}

/** Opens the heading the `index`th link of a contents list stands for. */
function follow(view: EditorView, index: number): void {
  const heading = view.state.field(headingsField, false)?.[index];
  if (!heading) return;
  view.dispatch(revealHeadingSpec(view.state, heading.from));
  if (getMode(view.state) === 'edit') view.focus();
}

/**
 * A click on a link of a contents list, followed on the keys any link opens on (`keysFollowLink`).
 * Only the keys are read: a press on a link leaves the page's selection as it was, and a drag that
 * selects text never ends in the link's own click.
 */
function onClick(event: MouseEvent, link: HTMLElement, index: number): void {
  event.preventDefault();
  const editor = link.closest<HTMLElement>('.cm-editor');
  const view = editor ? EditorView.findFromDOM(editor) : null;
  if (!view || posOf(view, link) === null) return;
  if (keysFollowLink(view, event)) follow(view, index);
}

/** The nested list of the headings in `text` (as `contentsText` writes it). */
function drawContents(text: string): HTMLElement {
  const [, read, ...lines] = text.split('\n');
  const root = document.createElement('ul');
  root.className = 'tm-contents';
  if (lines.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tm-contents-empty';
    empty.textContent = read === 'read' ? 'No headings yet.' : 'Reading the headings…';
    return empty;
  }
  // Each open level: the list its items go in, and the item a deeper heading nests under.
  const stack: { level: number; list: HTMLElement; item: HTMLElement | null }[] = [
    { level: 0, list: root, item: null },
  ];
  lines.forEach((line, index) => {
    const tab = line.indexOf('\t');
    const level = Number(line.slice(0, tab));
    while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop();
    let top = stack[stack.length - 1]!;
    if (top.item && top.level < level) {
      const nested = document.createElement('ul');
      top.item.appendChild(nested);
      top = { level, list: nested, item: null };
      stack.push(top);
    }
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'tm-contents-link tm-stop';
    link.href = `#${index}`;
    link.tabIndex = -1;
    link.textContent = line.slice(tab + 1);
    link.addEventListener('click', (event) => onClick(event, link, index));
    item.appendChild(link);
    top.list.appendChild(item);
    top.item = item;
    top.level = level;
  });
  return root;
}

/** A contents list drawn from more text than this (its headings) shows as code with a "Draw anyway" button. */
const CONTENTS_LIMIT = 1_000_000;
/** The height kept for a contents list never measured. */
const CONTENTS_ESTIMATE = 120;

const CONTENTS: DrawnKind = {
  name: 'Contents',
  sentenceName: 'a contents list',
  frameClass: 'tm-drawn-contents',
  editLabel: 'Edit the contents marker',
  doneLabel: 'Done editing the contents marker',
  limit: CONTENTS_LIMIT,
  estimate: CONTENTS_ESTIMATE,
  draw: (text) => ({ node: drawContents(text) }),
};

export const contents: Feature = {
  id: 'contents',
  extension: () => [
    headingsField,
    watchHeadings,
    definitionsField,
    blockFeature('contents', (d) => {
      const headings = d.state.field(headingsField, false) ?? null;
      d.blocks((block) => {
        if (!block.top || block.name !== 'Paragraph') return;
        const marker = markerOf(d.state, block.node);
        if (!marker || (WIKI_MARKER.test(marker) && linksToNote(d.ctx, d.state, block.node))) return;
        drawBlock(d, block, CONTENTS, contentsText(marker, headings), false);
      });
    }),
    drawnBlockKeys,
    drawnBlockTheme,
    EditorView.baseTheme({
      '& .cm-content .tm-contents, & .cm-content .tm-contents ul': {
        margin: '0',
        paddingLeft: '1.5em',
        fontFamily: 'var(--tm-font)',
      },
      '& .cm-content .tm-contents': { paddingLeft: '1.2em' },
      '& .cm-content .tm-contents-link': { color: 'var(--tm-link)', textDecoration: 'none', cursor: 'pointer' },
      '& .cm-content .tm-contents-link:hover': { textDecoration: 'underline' },
      '& .cm-content .tm-contents-link:focus-visible': {
        outline: '1px solid var(--tm-focus)',
        outlineOffset: '1px',
        borderRadius: '2px',
      },
      '& .cm-content .tm-contents-empty': { margin: '0', color: 'var(--tm-faded)' },
    }),
  ],
};
