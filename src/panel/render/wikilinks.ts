// Wikilinks: `[[Target]]`, `[[Folder/Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]` draw
// as link text: the alias when there is one, else the target, with a heading shown as
// `Target > Heading`, as is Bear's `[[Note/Heading]]` once the host has read it so. Their marks
// show, faded, when the link is revealed. An embed that is not an image (`![[Other note]]`)
// draws the same way; image embeds are images.ts's. The parser says which side of the `|` is
// the target; the wiki contents markers `[[_TOC_]]` and `[[_TOSP_]]` are not links.
//
// Whether a target exists is the host's to say (`resolveLinks`). The panel asks for the
// targets it draws, a batch at a time, keeps the answers for as long as the panel lives, and
// asks again for all of them when the host says the files changed (`linksChanged`). A missing
// target is drawn dashed and faded; an ambiguous one looks like any link, and the hover card
// lists its candidates. A target not answered yet is drawn as a plain link.

import { EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { LinkResolution, Wikilink } from '../../core/wikilinks';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { HostAnswers } from '../hostAnswers';
import { isContentsMarker, wikilinkParts } from '../links/read';
import { NO_INLINE } from '../markdown/nodes';
import { inlineFeature, redrawFeatureEffect, RichWidget, type InlineDraw } from './framework';
import { embedDrawn } from './images';
import { linkTextAttrs } from './links';

/** Most targets in one `resolveLinks` request. */
const BATCH = 500;

// ---------------------------------------------------------------------------
// The answers, one store per panel

function readResolution(value: unknown): LinkResolution | null {
  const v = value as Partial<LinkResolution> | null;
  if (!v || typeof v !== 'object') return null;
  if (v.status !== 'ok' && v.status !== 'ambiguous' && v.status !== 'missing') return null;
  const candidates = Array.isArray(v.candidates) ? v.candidates.filter((c): c is string => typeof c === 'string') : [];
  const out: LinkResolution = { status: v.status, candidates };
  if (typeof v.path === 'string') out.path = v.path;
  if (typeof v.heading === 'string') out.heading = v.heading;
  return out;
}

function sameResolution(a: LinkResolution, b: LinkResolution): boolean {
  return (
    a.status === b.status &&
    a.path === b.path &&
    a.heading === b.heading &&
    a.candidates.join('\n') === b.candidates.join('\n')
  );
}

/**
 * Draws the wikilinks again, and the front matter, whose values can hold them, and the contents
 * lists, since `[[toc]]` is one unless a note answers it, so new answers show. What shows them
 * outside the lines, such as a table's cells, follows the redraw of an inline feature itself.
 */
function redraw(ctx: PanelContext): void {
  ctx.dispatch({
    effects: [
      redrawFeatureEffect.of('wikilinks'),
      redrawFeatureEffect.of('frontmatter'),
      redrawFeatureEffect.of('contents'),
    ],
  });
}

const stores = new WeakMap<PanelContext, HostAnswers<LinkResolution>>();

function answersOf(ctx: PanelContext): HostAnswers<LinkResolution> {
  let store = stores.get(ctx);
  if (!store) {
    store = new HostAnswers<LinkResolution>({
      ask: (targets) => ctx.request({ type: 'resolveLinks', targets }),
      batch: BATCH,
      read: readResolution,
      same: sameResolution,
      changed: () => redraw(ctx),
      failed: (error) => ctx.log('warn', 'VS Code did not say which wikilink targets exist', error),
    });
    stores.set(ctx, store);
  }
  return store;
}

/** Asks the host about wikilink targets drawn outside the text (in front matter values). */
export function wantWikilinks(ctx: PanelContext, targets: readonly string[]): void {
  const answers = answersOf(ctx);
  for (const target of targets) answers.want(target);
  answers.flushSoon();
}

/** The host's answer for a wikilink target in this panel, if it has given one. */
export function wikilinkResolution(ctx: PanelContext | undefined, target: string): LinkResolution | undefined {
  return ctx ? answersOf(ctx).get(target) : undefined;
}

// ---------------------------------------------------------------------------
// Drawing

/** The ` > ` between a target and its heading. */
class HeadingSeparator extends RichWidget {
  override get plainText(): string {
    return ' > ';
  }
  draw(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = 'tm-wikilink-sep';
    span.textContent = ' > ';
    return span;
  }
  override ignores(): boolean {
    return false;
  }
}

const SKIP = new Set([...NO_INLINE, 'Table']);

/**
 * Where a wikilink's target, as written, divides into its note and its heading when the host
 * read it as Bear's `Note/Heading`: the index of that `/`, or -1.
 */
function headingSlash(target: string, resolution: LinkResolution | undefined): number {
  return resolution?.heading === undefined ? -1 : target.lastIndexOf('/');
}

/** A wikilink's text as drawn: its shown text, else its target, with a heading shown as `Target > Heading`. */
export function wikilinkLabel(link: Wikilink, resolution: LinkResolution | undefined): string {
  if (link.alias) return link.alias;
  if (link.heading) return link.target ? `${link.target} > ${link.heading}` : link.heading;
  const slash = headingSlash(link.target, resolution);
  if (slash < 0) return link.target;
  const note = link.target.slice(0, slash).trim();
  const heading = link.target.slice(slash + 1).trim();
  return note ? `${note} > ${heading}` : heading;
}

/** A wikilink's classes: missing (dashed and faded) or ambiguous as the host's answer says, and an embed. */
export function wikilinkClass(resolution: LinkResolution | undefined, embed: boolean): string {
  let cls = 'tm-wikilink';
  if (resolution?.status === 'missing') cls += ' tm-wikilink-missing';
  else if (resolution?.status === 'ambiguous') cls += ' tm-wikilink-ambiguous';
  if (embed) cls += ' tm-embed';
  return cls;
}

function drawWikilink(d: InlineDraw, node: SyntaxNode, answers: HostAnswers<LinkResolution>): void {
  const parts = wikilinkParts(d.state, node);
  if (!parts || !parts.close) return;
  const link = parts.link;
  const embed = node.name === 'Embed';
  // A picture or a player is render/images.ts's.
  if ((embed && embedDrawn(d.ctx, link.target)) || isContentsMarker(link)) return;
  answers.want(link.target);
  // An empty target links the note to itself, which always exists.
  const resolution = link.target ? answers.get(link.target) : { status: 'ok' as const, candidates: [] };
  const cls = wikilinkClass(resolution, embed);
  const { open, close, bar, target, alias } = parts;

  if (d.revealed(node.from, node.to)) {
    for (const m of [open, bar, close]) if (m) d.mark(m.from, m.to, 'tm-mark');
    if (target) d.mark(target.from, target.to, cls);
    if (alias) d.mark(alias.from, alias.to, cls);
    return;
  }

  // In Rich view the drawn text can take focus (ui/viewKeys.ts).
  const attrs = linkTextAttrs(d.mode);
  if (alias && alias.to > alias.from) {
    d.hide(node.from, alias.from);
    d.mark(alias.from, alias.to, cls, attrs);
    d.hide(alias.to, node.to);
    return;
  }
  d.hide(open.from, open.to);
  if (bar) d.hide(bar.from, bar.to);
  d.hide(close.from, close.to);
  if (!target) return;
  const text = d.doc.sliceString(target.from, target.to);
  const hash = text.indexOf('#');
  const slash = link.heading ? -1 : headingSlash(hash < 0 ? text : text.slice(0, hash), resolution);
  // A target that names a note and a heading, split at `at`: the heading alone where no note
  // is named before it, else the whole target with the separator drawn as ` > `.
  const markSplit = (at: number, noteNamed: boolean, separator: string) => {
    if (!noteNamed) {
      d.hide(target.from, at + 1);
      d.mark(at + 1, target.to, cls, attrs);
      return;
    }
    d.mark(target.from, target.to, cls, attrs);
    d.replace(at, at + 1, new HeadingSeparator(separator));
  };
  if (slash >= 0) {
    // Bear's `Note/Heading`, drawn as `Note > Heading`; `/Heading`, in this note, as the heading alone.
    markSplit(target.from + slash, text.slice(0, slash).trim() !== '', '/');
    return;
  }
  if (hash < 0 || !link.heading) {
    d.mark(target.from, target.to, cls, attrs);
    return;
  }
  // `Note#Heading`, drawn as `Note > Heading`; `#Heading`, in this note, as the heading alone.
  markSplit(target.from + hash, link.target !== '', '#');
}

export const wikilinks: Feature = {
  id: 'wikilinks',
  extension: (ctx) => [
    inlineFeature('wikilinks', (d) => {
      const answers = answersOf(d.ctx);
      d.iterate((ref) => {
        if (SKIP.has(ref.name)) return false;
        if (ref.name === 'Wikilink' || ref.name === 'Embed') {
          drawWikilink(d, ref.node, answers);
          return false;
        }
        return true;
      });
      answers.flushSoon();
    }),
    // The host says the files changed: ask again.
    ViewPlugin.define((view) => {
      const panel = view.state.facet(panelContext) ?? ctx;
      const stop = panel.bridge.onMessage((message) => {
        if (message.type === 'linksChanged') {
          const answers = answersOf(panel);
          answers.refresh(answers.keys());
        }
      });
      return { destroy: stop };
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-wikilink': { color: 'var(--tm-link)' },
      '& .cm-content .tm-wikilink:hover': { textDecoration: 'underline' },
      '&.tm-mode-view .cm-content .tm-wikilink': { cursor: 'pointer' },
      '& .cm-content .tm-wikilink-missing': {
        opacity: '0.65',
        textDecoration: 'underline dashed',
        textUnderlineOffset: '3px',
      },
      '& .cm-content .tm-wikilink-missing:hover': { textDecoration: 'underline dashed' },
      '& .cm-content .tm-wikilink-sep': { color: 'var(--tm-faded)' },
    }),
  ],
};
