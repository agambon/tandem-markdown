// The start of a note in a link's hover card. Hovering a resolved wikilink, or a link to a
// markdown file, for HOVER_MS asks the host for the note (`previewNote`) and shows its title
// (its first heading, else its file name) and the start of its text after the front matter, as
// plain text with the markdown marks as they are. It sits at the top of the hover card, above
// what ui/linkCard.ts shows (the path and Open), so the card reads title, start of the note,
// path.
//
// Nothing shows for a missing link, a link to anything that is not a markdown file, or a file
// the host does not preview (outside the workspace, or too large): the host answers null for
// those, and a wikilink the host already said is missing is not asked about at all. Text goes
// in through textContent only.

import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';
import type { NotePreview, PreviewNoteMessage } from '../../core/featureProtocol';
import { extensionOf, isMarkdownPath } from '../../core/fileKinds';
import { panelContext } from '../context';
import type { Feature } from '../features';
import type { LinkTarget } from '../links/read';
import { wikilinkResolution } from '../render/wikilinks';
import { cardOver, hoveredLink, HOVER_MS } from './linkCard';

/** How long to wait for the host's answer. */
const PREVIEW_WAIT_MS = 3000;

type PreviewRequest = Pick<PreviewNoteMessage, 'kind' | 'path'>;

/** What to ask the host about a link, or null when its card shows no note. */
function previewRequest(target: LinkTarget, resolution: ReturnType<typeof wikilinkResolution>): PreviewRequest | null {
  if (target.kind === 'wikilink') {
    // `[[#Heading]]` is this note; a target the host said is missing has no note to show. The
    // heading goes too: a link to a block (`[[Note#^id]]`) previews the block.
    if (!target.target || resolution?.status === 'missing') return null;
    return { kind: 'wikilink', path: target.href };
  }
  if (target.kind !== 'file' || !target.href) return null;
  const bare = target.href.replace(/[#?].*$/, '').replace(/\\/g, '/');
  if (bare.endsWith('/') || !bare) return null;
  // A name with no extension may be a note written without `.md`; the host tries that.
  if (extensionOf(bare) && !isMarkdownPath(bare)) return null;
  return { kind: 'file', path: target.href };
}

function readPreview(value: unknown): NotePreview | null {
  const v = value as Partial<NotePreview> | null;
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.title !== 'string' ||
    typeof v.text !== 'string' ||
    typeof v.path !== 'string'
  )
    return null;
  return { title: v.title, text: v.text, path: v.path };
}

/** The card's top section. */
function buildNoteCard(doc: Document, preview: NotePreview): HTMLElement {
  const card = doc.createElement('div');
  card.className = 'tm-note-card';
  const title = doc.createElement('div');
  title.className = 'tm-note-card-title';
  title.textContent = preview.title;
  card.appendChild(title);
  if (preview.text) {
    const text = doc.createElement('div');
    text.className = 'tm-note-card-text';
    text.textContent = preview.text;
    card.appendChild(text);
  }
  return card;
}

async function source(view: EditorView, pos: number, side: -1 | 1): Promise<Tooltip | null> {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return null;
  const hovered = hoveredLink(view, pos, side);
  if (!hovered) return null;
  const { target, place } = hovered;
  const ask = previewRequest(target, target.target ? wikilinkResolution(ctx, target.target) : undefined);
  if (!ask) return null;
  let preview: NotePreview | null;
  try {
    preview = readPreview(
      await ctx.request({ type: 'previewNote', kind: ask.kind, path: ask.path }, { timeoutMs: PREVIEW_WAIT_MS }),
    );
  } catch (error) {
    ctx.log('warn', 'VS Code did not send the start of the linked note', error);
    return null;
  }
  if (!preview) return null;
  const shown = preview;
  return cardOver(view, place, target, (v) => buildNoteCard(v.dom.ownerDocument, shown));
}

export const noteCard: Feature = {
  id: 'noteCard',
  extension: () => [
    hoverTooltip(source, { hoverTime: HOVER_MS, hideOnChange: true }),
    EditorView.baseTheme({
      '& .tm-note-card': {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        maxWidth: '440px',
        padding: '6px 8px',
        borderBottom: '1px solid var(--tm-border)',
        fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
        fontSize: '12px',
        lineHeight: '1.4',
      },
      '& .tm-note-card-title': { fontWeight: '600', overflowWrap: 'anywhere' },
      '& .tm-note-card-text': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--tm-faded)' },
    }),
  ],
};
