// Embedded notes: `![[Note]]`, `![[Note#Heading]]` or `![[Note#^id]]` alone in its paragraph is
// a drawn block (render/drawnBlock.ts) showing that note, or its section or block, read-only, in
// an editor of its own with the page's drawing features, file HTML through the door included.
// The host reads the note (`embedNotes`; src/host/links/embeds.ts) and says when it changes
// (`embedsChanged`) and when files come and go (`linksChanged`); the embed is then read again.
//
// The pencil opens the `![[...]]` line, not the other note; the embed's header has a button
// that opens the other note. A note embedded MAX_EMBED_DEPTH deep, or one already shown around
// the embed (a cycle), is not drawn again: a sentence says why, as one does for a missing note.
// An embed is read-only and behaves as Rich view does: a plain click opens a link in it.
// Everything an embedded note's editor asks of the host names that note (`note`), so its
// links, pictures and embeds are read from its own folder, however deep it is.

import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { EmbedNoteAnswer } from '../../core/featureProtocol';
import { extensionOf, isImagePath, MEDIA_EXTENSIONS } from '../../core/fileKinds';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { HostAnswers } from '../hostAnswers';
import { innerState } from '../innerStates';
import { wikilinkParts } from '../links/read';
import { getMode } from '../modes';
import { iconButton } from '../ui/dom';
import { drawBlock, drawnBlockKeys, drawnBlockTheme, type Drawing, type DrawnKind } from './drawnBlock';
import { blockFeature, redrawFeatureEffect, type BlockDraw } from './framework';

/** How many notes deep embeds are drawn: an embed in an embed in an embed is, one more is not. */
const MAX_EMBED_DEPTH = 3;
const BATCH = 50;
/** An embed drawn from more text than this (the note it shows) shows as code with a "Draw anyway" button. */
const EMBED_LIMIT = 1_000_000;
const EMBED_ESTIMATE = 160; // estimated height in px before measurement
/**
 * The extensions of embedded files that are not notes: documents, Obsidian's canvases, the video
 * and sound a panel plays, and video it does not. A dot elsewhere in a name is a note's.
 */
const OTHER_FILES = new Set(['pdf', 'canvas', 'mkv', 'avi', ...MEDIA_EXTENSIONS]);
/** Features that act on the page's own document, its page or the host, which an embedded note has none of. */
const LEFT_OUT = new Set([
  'noteCard',
  'linkCard',
  'problemCard',
  'wikilinkCompletion',
  'viewKeys',
  'outsideMark',
  'outsideAnnounce',
  'diagnostics',
  'changeMarks',
  'search',
  'renameBox',
  'paste',
  'typing',
  'toolbar',
]);

/** Where an editor stands among embeds: how deep, and the notes shown around it, by workspace path. */
interface Nesting {
  depth: number;
  around: readonly string[];
  /** The panel's own context, which asks the host for every embed in the page. */
  page: PanelContext;
  /** The embedded note the editor shows, by workspace path; null for the page's own. */
  note: string | null;
}

const nestings = new WeakMap<PanelContext, Nesting>();

function nestingOf(ctx: PanelContext): Nesting {
  return (
    nestings.get(ctx) ?? {
      depth: 0,
      around: ctx.doc.workspacePath ? [ctx.doc.workspacePath] : [],
      page: ctx,
      note: null,
    }
  );
}

function readAnswer(value: unknown): EmbedNoteAnswer | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.reason === 'string') return { reason: v.reason };
  if (typeof v.path === 'string' && typeof v.title === 'string' && typeof v.text === 'string') {
    return { path: v.path, title: v.title, text: v.text };
  }
  return null;
}

function sameAnswer(a: EmbedNoteAnswer, b: EmbedNoteAnswer): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The answers about the embeds written in one note of the page, and the editors to draw again when they change. */
interface Store {
  answers: HostAnswers<EmbedNoteAnswer>;
  redraws: Set<() => void>;
}

/** For each page, a store per note its embeds are written in, by workspace path ('' for the page's own). */
const stores = new WeakMap<PanelContext, Map<string, Store>>();

function storesOf(page: PanelContext): Map<string, Store> {
  let byNote = stores.get(page);
  if (!byNote) {
    const all = new Map<string, Store>();
    page.bridge.onMessage((message) => {
      if (message.type !== 'embedsChanged' && message.type !== 'linksChanged') return;
      for (const { answers } of all.values()) answers.refresh(answers.keys());
    });
    stores.set(page, (byNote = all));
  }
  return byNote;
}

function storeOf(ctx: PanelContext): Store {
  const { page, note } = nestingOf(ctx);
  const byNote = storesOf(page);
  let store = byNote.get(note ?? '');
  if (!store) {
    const redraws = new Set<() => void>();
    const answers = new HostAnswers<EmbedNoteAnswer>({
      ask: (targets) => page.request({ type: 'embedNotes', targets, ...(note === null ? {} : { note }) }),
      batch: BATCH,
      read: readAnswer,
      same: sameAnswer,
      changed: () => {
        for (const redraw of [...redraws]) redraw();
      },
      failed: (error) => page.log('warn', 'VS Code did not send the notes this page embeds', error),
    });
    store = { answers, redraws };
    byNote.set(note ?? '', store);
  }
  return store;
}

/** What an embed draws: its target, then its answer or why it is not asked about. */
type Shown = { target: string } & ({ answer: EmbedNoteAnswer } | { waiting: true });

/** The embed target of `paragraph` when the paragraph is that embed alone, of a note (not a picture or another file). */
function embedTarget(d: BlockDraw, paragraph: SyntaxNode): string | null {
  const embed = paragraph.firstChild;
  if (!embed || embed.name !== 'Embed' || embed.nextSibling) return null;
  if (d.doc.sliceString(paragraph.from, embed.from).trim() || d.doc.sliceString(embed.to, paragraph.to).trim()) {
    return null;
  }
  const parts = wikilinkParts(d.state, embed);
  if (!parts || !parts.close) return null;
  const { target, heading } = parts.link;
  if (isImagePath(target) || OTHER_FILES.has(extensionOf(target))) return null;
  return heading ? `${target}#${heading}` : target;
}

function parseShown(text: string): Shown {
  return JSON.parse(text) as Shown;
}

function sentence(doc: Document, text: string): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'tm-embed-reason';
  p.textContent = text;
  return p;
}

function header(doc: Document, view: EditorView, title: string, target: string): HTMLElement {
  const head = doc.createElement('div');
  head.className = 'tm-embed-head';
  const name = doc.createElement('span');
  name.className = 'tm-embed-title';
  name.textContent = title;
  const open = iconButton(doc, { icon: 'link-external', label: `Open ${title}`, className: 'tm-embed-open' });
  open.classList.add('tm-stop');
  open.addEventListener('click', (event) => {
    event.preventDefault();
    // The editor the embed is written in, whose requests name its note.
    const ctx = view.state.facet(panelContext)!;
    ctx
      .request({ type: 'openLink', kind: 'wikilink', href: target, mode: getMode(view.state) })
      .catch((error) => ctx.log('warn', 'Opening an embedded note got no answer from VS Code', error));
  });
  head.append(name, open);
  return head;
}

/**
 * An editor of its own over `text`, read-only, inside `parent`, for the note at `path` embedded
 * in `ctx`'s editor, whose state is `drawnIn`.
 */
function embeddedEditor(
  drawnIn: EditorState,
  ctx: PanelContext,
  path: string,
  text: string,
  parent: HTMLElement,
): EditorView {
  const outer = nestingOf(ctx);
  let view: EditorView | null = null;
  const child: PanelContext = {
    bridge: ctx.bridge,
    doc: { ...ctx.doc, fileName: path.slice(path.lastIndexOf('/') + 1), workspacePath: path, readOnly: true },
    slots: ctx.slots,
    get settings() {
      return ctx.settings;
    },
    onSettingsChange: (listener) => ctx.onSettingsChange(listener),
    // Straight to the page, naming this note, however deep the editor is.
    request: (message, options) => outer.page.request({ ...message, note: path }, options),
    notify: (notice) => ctx.notify(notice),
    log: (level, message, detail) => ctx.log(level, message, detail),
    view: () => {
      if (!view) throw new Error('The embedded note has no editor yet');
      return view;
    },
    dispatch: (spec) => view?.dispatch(spec),
  };
  nestings.set(child, { depth: outer.depth + 1, around: [...outer.around, path], page: outer.page, note: path });
  const state = innerState(drawnIn, { ctx: child, text, mode: 'view', leaveOut: LEFT_OUT });
  view = new EditorView({ state, parent });
  return view;
}

function drawEmbed(text: string, view: EditorView): Drawing {
  const doc = view.dom.ownerDocument;
  const ctx = view.state.facet(panelContext);
  const shown = parseShown(text);
  const box = doc.createElement('div');
  box.className = 'tm-embed';
  if (!ctx || 'waiting' in shown) {
    box.classList.add('tm-embed-waiting');
    box.appendChild(sentence(doc, 'Reading the note…'));
    return { node: box };
  }
  const { answer } = shown;
  if ('reason' in answer) {
    box.appendChild(sentence(doc, answer.reason));
    return { node: box };
  }
  box.appendChild(header(doc, view, answer.title, shown.target));
  const body = doc.createElement('div');
  body.className = 'tm-embed-body';
  box.appendChild(body);
  const editor = embeddedEditor(view.state, ctx, answer.path, answer.text, body);
  // The embedded editor's height changes as it draws (a picture loads, a diagram arrives).
  const resized = new ResizeObserver(() => view.requestMeasure());
  resized.observe(editor.dom);
  return {
    node: box,
    dispose: () => {
      resized.disconnect();
      editor.destroy();
    },
  };
}

const EMBED: DrawnKind = {
  name: 'Embedded note',
  sentenceName: 'an embedded note',
  frameClass: 'tm-drawn-embed',
  editLabel: 'Edit the embed',
  doneLabel: 'Done editing the embed',
  limit: EMBED_LIMIT,
  estimate: EMBED_ESTIMATE,
  draw: drawEmbed,
};

/** What an embed of `target` in `ctx`'s editor shows, as the text it is drawn from. */
function shownText(ctx: PanelContext, target: string): string {
  const nesting = nestingOf(ctx);
  if (nesting.depth >= MAX_EMBED_DEPTH) {
    return JSON.stringify({
      target,
      answer: { reason: `Not shown: embeds are drawn ${MAX_EMBED_DEPTH} notes deep at most.` },
    } satisfies Shown);
  }
  const { answers } = storeOf(ctx);
  answers.want(target);
  const answer = answers.get(target);
  if (!answer) return JSON.stringify({ target, waiting: true } satisfies Shown);
  if ('path' in answer && nesting.around.includes(answer.path)) {
    return JSON.stringify({
      target,
      answer: { reason: 'Not shown: this note is already shown around this embed.' },
    } satisfies Shown);
  }
  return JSON.stringify({ target, answer } satisfies Shown);
}

const followAnswers = ViewPlugin.define((view) => {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return {};
  const { redraws } = storeOf(ctx);
  const redraw = () => view.dispatch({ effects: redrawFeatureEffect.of('embeds') });
  redraws.add(redraw);
  return { destroy: () => redraws.delete(redraw) };
});

export const embeds: Feature = {
  id: 'embeds',
  extension: () => [
    blockFeature('embeds', (d) => {
      let asked = false;
      d.blocks((block) => {
        if (block.name !== 'Paragraph') return;
        const target = embedTarget(d, block.node);
        if (target === null) return;
        drawBlock(d, block, EMBED, shownText(d.ctx, target), false);
        asked = true;
      });
      if (asked) storeOf(d.ctx).answers.flushSoon();
    }),
    followAnswers,
    drawnBlockKeys,
    drawnBlockTheme,
    EditorView.baseTheme({
      '& .cm-content .tm-embed': {
        borderLeft: '3px solid var(--tm-border)',
        padding: '0 0 0 12px',
        textAlign: 'left',
      },
      '& .cm-content .tm-embed-head': {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontFamily: 'var(--tm-ui-font)',
        fontSize: '0.85em',
        color: 'var(--tm-faded)',
      },
      '& .cm-content .tm-embed-title': { fontWeight: '600', overflowWrap: 'anywhere' },
      '& .cm-content .tm-embed-open': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        padding: '0',
        border: 'none',
        borderRadius: '3px',
        background: 'none',
        color: 'var(--tm-faded)',
        cursor: 'pointer',
      },
      '& .cm-content .tm-embed-open:hover': { background: 'var(--tm-button2-bg)', color: 'var(--tm-fg)' },
      '& .cm-content .tm-embed-open:focus-visible': { outline: '1px solid var(--tm-focus)', outlineOffset: '1px' },
      '& .cm-content .tm-embed-reason': { margin: '4px 0', color: 'var(--tm-faded)', fontFamily: 'var(--tm-ui-font)' },
      '& .cm-content .tm-embed .cm-editor': { height: 'auto', background: 'transparent' },
      '& .cm-content .tm-embed .cm-editor .cm-content': { maxWidth: 'none', padding: '4px 0' },
    }),
  ],
};
