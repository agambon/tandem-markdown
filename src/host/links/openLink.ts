// Opening a link a panel was asked to open. http, https and mailto go to `env.openExternal`;
// a markdown file opens in our editor in the view the link was clicked in, at its `#heading`
// (or at an anchor written as HTML, `<a name>`, when no heading has that name, or at the line
// a markdown link names, `#L12`); `#heading` alone scrolls the panel it was clicked in; any
// other file opens with VS Code's default editor; a folder is shown in the Explorer; anything
// else with a scheme is refused with a notice. A path starting with `/` is taken from the
// note's workspace folder. A link in an embedded note is read from that note: its `#heading`
// opens that note there.

import * as vscode from 'vscode';
import { findAnchor } from '../../core/attributes';
import { toLf } from '../../core/eol';
import { isMarkdownPath } from '../../core/fileKinds';
import { buildOutline } from '../../core/outline';
import type { Mode } from '../../core/protocol';
import { parseWikilink } from '../../core/wikilinks';
import type { Documents } from '../documents';
import { statOf } from '../localFiles';
import { documentText } from '../model/documentText';
import { findHeading } from '../model/headingAnchors';
import { findLine } from '../model/lineFragment';
import { readAddress, type Address } from '../model/linkAddress';
import { findNamedAnchor } from '../model/namedAnchors';
import { openInRich } from '../modeSwitch';
import { panels, tellPanel, type HostPanel } from '../panels';
import { fileNameOf, sameFile, sameUri } from '../uris';
import { linkService } from './linkService';
import { noteCandidateUris } from './location';
import { wikilinkResolver } from './notePreview';

/** How long opening a file waits for its panel before it gives up on scrolling to the heading. */
const PANEL_WAIT_MS = 15_000;

/** Opens `href`, a link of `kind` written in `note`: the panel's own note or one embedded in it. */
export async function openLink(
  documents: Documents,
  panel: HostPanel,
  note: vscode.Uri,
  kind: unknown,
  href: string,
  mode: Mode,
): Promise<void> {
  if (kind === 'wikilink') return openWikilink(documents, panel, note, href, mode);
  const address = readAddress(href);
  switch (address.kind) {
    case 'web':
      return openWeb(panel, address.url);
    case 'anchor':
      return goTo(documents, panel, note, address.fragment, true, mode);
    case 'refused':
      tellPanel(
        panel,
        address.share
          ? 'Links to network shares are not opened.'
          : `Links to "${address.scheme}:" addresses are not opened.`,
      );
      return;
    case 'path':
      return openPath(documents, panel, note, address, mode);
  }
}

/** Goes to `fragment` in `note`: scrolls the panel when it is the panel's own note, else opens `note` there. */
function goTo(
  documents: Documents,
  panel: HostPanel,
  note: vscode.Uri,
  fragment: string,
  lines: boolean,
  mode: Mode,
): Promise<void> {
  return sameUri(note, panel.document.uri)
    ? revealIn(panel, fragment, lines)
    : openFile(documents, panel, note, fragment, lines, mode);
}

async function openWeb(panel: HostPanel, url: string): Promise<void> {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(url, true);
  } catch {
    tellPanel(panel, 'This web address could not be read.');
    return;
  }
  if (uri.scheme !== 'http' && uri.scheme !== 'https' && uri.scheme !== 'mailto') {
    tellPanel(panel, `Links to "${uri.scheme}:" addresses are not opened.`);
    return;
  }
  await vscode.env.openExternal(uri);
}

async function openWikilink(
  documents: Documents,
  panel: HostPanel,
  note: vscode.Uri,
  inner: string,
  mode: Mode,
): Promise<void> {
  const link = parseWikilink(inner);
  if (!link.target) return goTo(documents, panel, note, link.heading ?? '', false, mode);
  const found = await linkService().indexForNote(note);
  const resolution = found ? await wikilinkResolver(found)(link.target) : undefined;
  if (!found || !resolution?.path) {
    tellPanel(panel, `No file matches [[${link.target}]].`);
    return;
  }
  const uri = vscode.Uri.joinPath(found.location.folder.uri, resolution.path);
  await openFile(documents, panel, uri, link.heading ?? resolution.heading ?? '', false, mode);
}

async function openPath(
  documents: Documents,
  panel: HostPanel,
  note: vscode.Uri,
  address: Extract<Address, { kind: 'path' }>,
  mode: Mode,
): Promise<void> {
  for (const uri of noteCandidateUris(address, note)) {
    if (await statOf(uri)) return openFile(documents, panel, uri, address.fragment, true, mode);
  }
  tellPanel(panel, `Could not find ${address.candidates[0] ?? 'the linked file'}.`);
}

async function openFile(
  documents: Documents,
  panel: HostPanel,
  uri: vscode.Uri,
  fragment: string,
  lines: boolean,
  mode: Mode,
): Promise<void> {
  const stat = await statOf(uri);
  if (!stat) {
    tellPanel(panel, `Could not find ${fileNameOf(uri)}.`);
    return;
  }
  if (stat.type & vscode.FileType.Directory) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  if (!isMarkdownPath(uri.path)) {
    await vscode.commands.executeCommand('vscode.open', uri);
    return;
  }
  if (sameFile(uri, panel.document.uri)) {
    if (mode !== panel.mode) await openInRich(documents, uri, mode);
    if (fragment) await revealIn(panel, fragment, lines);
    return;
  }
  await openInRich(documents, uri, mode);
  if (!fragment) return;
  const column = () => vscode.window.tabGroups.activeTabGroup.viewColumn;
  const target = await panels.whenLive(
    (p) => sameUri(p.uri, uri) && p.webviewPanel.viewColumn === column(),
    PANEL_WAIT_MS,
  );
  if (target) await revealIn(target, fragment, lines);
}

/**
 * Scrolls `panel` to the heading `fragment` names, or else to the line whose attributes give
 * that id (a bookmark Word left, `[]{#_Toc12 .anchor}`), or else to the anchor of that name
 * written as HTML, or else, with `lines`, to the line it names (`L12`), or says there is none.
 */
async function revealIn(panel: HostPanel, fragment: string, lines: boolean): Promise<void> {
  if (!fragment) return;
  const text = toLf(documentText(panel.document));
  const headings = buildOutline(text);
  const i = findHeading(
    headings.map((h) => h.anchorText ?? h.text),
    fragment,
    headings.map((h) => h.id),
  );
  let from = i >= 0 ? headings[i]!.from : findAnchor(text, fragment);
  if (from < 0) from = findNamedAnchor(text, fragment);
  if (from < 0 && lines) from = findLine(text, fragment);
  if (from < 0) {
    tellPanel(panel, `No heading "${fragment}" in ${fileNameOf(panel.document.uri)}.`);
    return;
  }
  void panel.post({ type: 'command', id: 'revealHeading', args: { from } });
}
