// Wikilinks in front matter values (`author: "[[Name]]"`, as Obsidian's properties and its web
// clipper write them), drawn as links in the front matter's table (render/frontmatter.ts). They
// open on the clicks a link opens on (`followsLink`, render/follow.ts), and a missing target looks
// as it does in the text.

import type { EditorView } from '@codemirror/view';
import { panelContext, type PanelContext } from '../context';
import { isContentsMarker, wikilinksIn } from '../links/read';
import type { Mode } from '../modes';
import { OFF, syntaxValue } from '../syntax';
import { keyName } from '../ui/keys';
import { followsLink } from './follow';
import { posOf } from './framework';
import { openTarget } from './links';
import { wantWikilinks, wikilinkClass, wikilinkLabel, wikilinkResolution } from './wikilinks';

/** How the values' wikilinks are read and drawn, and a key that changes with the view or an answer about one. */
export interface ValueLinks {
  readonly textFirst: boolean;
  readonly mode: Mode;
  readonly key: string;
}

/** The value texts of a front matter's entries, however deep. */
type ValueTexts = (visit: (text: string) => void) => void;

/**
 * How the wikilinks in the values are to be drawn, asking the host about their targets; null
 * when the values hold none or wikilinks are off.
 */
export function valueLinks(ctx: PanelContext, mode: Mode, texts: ValueTexts): ValueLinks | null {
  const setting = syntaxValue(ctx.settings, 'wikilinks');
  if (setting === OFF) return null;
  const textFirst = setting === 'textFirst';
  const targets: string[] = [];
  let found = false;
  texts((text) => {
    for (const { link } of wikilinksIn(text, textFirst)) {
      if (isContentsMarker(link)) continue;
      found = true;
      if (link.target) targets.push(link.target);
    }
  });
  if (!found) return null;
  wantWikilinks(ctx, targets);
  const answers = targets.map((t) => {
    const resolution = wikilinkResolution(ctx, t);
    return resolution ? `${resolution.status}${resolution.heading === undefined ? '' : '#'}` : '?';
  });
  return { textFirst, mode, key: [mode, ...answers].join(' ') };
}

/** `text` with its wikilinks drawn as links. */
export function linkedText(view: EditorView, text: string, links: ValueLinks): Node {
  const doc = view.dom.ownerDocument;
  const found = wikilinksIn(text, links.textFirst).filter((w) => !isContentsMarker(w.link));
  if (found.length === 0) return doc.createTextNode(text);
  const ctx = view.state.facet(panelContext);
  const fragment = doc.createDocumentFragment();
  let pos = 0;
  for (const { from, to, link } of found) {
    if (from > pos) fragment.append(text.slice(pos, from));
    const span = doc.createElement('span');
    const resolution = link.target ? wikilinkResolution(ctx, link.target) : { status: 'ok' as const, candidates: [] };
    span.className = wikilinkClass(resolution, false);
    span.textContent = wikilinkLabel(link, resolution);
    span.title = links.mode === 'view' ? 'Click to open' : `${keyName({ key: 'ctrl', mac: 'cmd' })}+click to open`;
    span.addEventListener('click', (event) => {
      if (event.button !== 0 || !followsLink(view, event)) return;
      event.preventDefault();
      const href = link.heading ? `${link.target}#${link.heading}` : link.target;
      // The link stands in the front matter's drawing, whose place is the block's.
      const at = posOf(view, span) ?? 0;
      openTarget(view, { kind: 'wikilink', href, target: link.target, from: at, to: at });
    });
    fragment.append(span);
    pos = to;
  }
  if (pos < text.length) fragment.append(text.slice(pos));
  return fragment;
}
