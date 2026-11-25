// Links on the host side: answers a panel's resolveLinks, listLinkTargets, openLink, previewNote
// and embedNotes requests, and tells every panel `linksChanged` when the index changes. A
// request from an embedded note's editor is answered for that note (`requestNote`).

import * as vscode from 'vscode';
import type { ListLinkTargetsResult, ResolveLinksResult } from '../../core/featureProtocol';
import type { Mode } from '../../core/protocol';
import type { HostFeature } from '../features';
import { MAX_MESSAGE_TEXT, registerPanelMessageHandler, stringList } from '../panelMessages';
import type { HostPanel } from '../panels';
import { EmbedWatch } from './embeds';
import { linkService } from './linkService';
import { requestNote } from './location';
import { previewNote, wikilinkResolver } from './notePreview';
import { openLink } from './openLink';

/** The most link targets one `resolveLinks` request is answered for. */
const MAX_TARGETS = 500;
/** The most embeds one `embedNotes` request is answered for. */
const MAX_EMBEDS = 100;
/** The longest `[[` completion query read. */
const MAX_QUERY = 200;

async function resolveLinks(targets: string[], note: vscode.Uri | undefined): Promise<ResolveLinksResult> {
  const out: ResolveLinksResult = Object.create(null);
  const found = note ? await linkService().indexForNote(note) : undefined;
  const resolve = found ? wikilinkResolver(found) : undefined;
  for (const t of targets) {
    out[t] = resolve ? await resolve(t) : { status: 'missing', candidates: [] };
  }
  return out;
}

async function listTargets(query: string, panel: HostPanel): Promise<ListLinkTargetsResult> {
  const found = await linkService().indexForNote(panel.document.uri);
  if (!found) return { items: [] };
  return { items: found.index.targets(query, found.location.path) };
}

function modeOf(value: unknown, panel: HostPanel): Mode {
  return value === 'view' || value === 'edit' ? value : panel.mode;
}

export const links: HostFeature = (_context, documents) => {
  const svc = linkService();
  const embeds = new EmbedWatch();
  return vscode.Disposable.from(
    registerPanelMessageHandler('resolveLinks', (m, panel) =>
      resolveLinks(stringList(m.targets, MAX_TARGETS), requestNote(panel.document.uri, m.note)),
    ),
    registerPanelMessageHandler('listLinkTargets', (m, panel) =>
      listTargets(typeof m.query === 'string' ? m.query.slice(0, MAX_QUERY) : '', panel),
    ),
    registerPanelMessageHandler('openLink', (m, panel) => {
      if (typeof m.href !== 'string' || m.href.length > MAX_MESSAGE_TEXT) throw new Error('openLink needs an address');
      const note = requestNote(panel.document.uri, m.note);
      if (!note) throw new Error('openLink names a note outside the workspace folder');
      return openLink(documents, panel, note, m.kind, m.href, modeOf(m.mode, panel));
    }),
    registerPanelMessageHandler('previewNote', (m, panel) => {
      if (typeof m.path !== 'string' || m.path.length === 0 || m.path.length > MAX_MESSAGE_TEXT) return null;
      if (m.kind !== 'wikilink' && m.kind !== 'file') return null;
      const note = requestNote(panel.document.uri, m.note);
      return note ? previewNote(note, m.kind, m.path) : null;
    }),
    registerPanelMessageHandler('embedNotes', (m, panel) =>
      embeds.answer(panel, requestNote(panel.document.uri, m.note), stringList(m.targets, MAX_EMBEDS)),
    ),
    embeds,
    svc,
  );
};
