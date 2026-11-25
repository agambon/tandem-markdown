// The start of a linked note, for a link's hover card, and the part of a note an embed shows;
// and wikilink targets resolved for a note, which reads a note's headings for Bear's
// `[[Note/Heading]]` (src/core/wikilinks.ts, `resolveLink`).
//
// The path comes from a panel message, so nothing is read unless every check passes: the
// address resolves to a `file` path inside a workspace folder after normalizing (`..`,
// another drive, a UNC or device path, an alternate data stream all refused); neither the
// file nor any folder between the workspace folder and it is a symbolic link or junction (as
// far as `workspace.fs.stat` reports them); it is a markdown file; it is no larger than
// NOTE_PREVIEW_MAX_BYTES (EMBED_MAX_BYTES for an embed). A note open in VS Code is read from its
// document instead, after the same path checks; only an embed holds it to its size limit
// (`ReadLimit`).

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EmojiCodes } from '../../core/emojiCodes';
import { decodeBytes } from '../../core/encoding';
import { toLf } from '../../core/eol';
import type { EmbedNoteAnswer, PreviewNoteResult } from '../../core/featureProtocol';
import { isMarkdownPath, MARKDOWN_EXT } from '../../core/fileKinds';
import { buildOutline, type OutlineItem } from '../../core/outline';
import { parseWikilink, type LinkResolution } from '../../core/wikilinks';
import { statOf } from '../localFiles';
import { log } from '../log';
import { documentText } from '../model/documentText';
import { hostEmojiNames } from '../model/emojiNames';
import { outlineHas } from '../model/headingAnchors';
import { isInsideFolder, partsInside, pathCaseIgnored } from '../model/insideFolder';
import { readAddress } from '../model/linkAddress';
import { NOTE_PREVIEW_MAX_BYTES, notePreviewOf } from '../model/notePreviewText';
import { EMBED_MAX_BYTES, notePart } from '../model/noteSection';
import { emojiOn, plainTextSyntax } from '../settings';
import { fileNameOf, sameFile } from '../uris';
import { linkService, type LinkService } from './linkService';
import { noteCandidateUris } from './location';

/** The workspace folder `uri` is inside, with the path parts from it down, or undefined. */
function containingFolder(uri: vscode.Uri): { folder: vscode.WorkspaceFolder; parts: string[] } | undefined {
  if (uri.scheme !== 'file') return undefined;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    if (isInsideFolder(folder.uri.fsPath, uri.fsPath, path, pathCaseIgnored()))
      return { folder, parts: partsInside(folder.uri.fsPath, uri.fsPath, path, pathCaseIgnored()) };
  }
  return undefined;
}

/** A markdown file inside a workspace folder, reached through no symbolic link, with its size. Undefined otherwise. */
async function safeNote(uri: vscode.Uri): Promise<{ uri: vscode.Uri; rel: string; size: number } | undefined> {
  if (!isMarkdownPath(uri.path)) return undefined;
  const inside = containingFolder(uri);
  if (!inside) return undefined;
  let at = inside.folder.uri;
  let stat: vscode.FileStat | undefined;
  for (const part of inside.parts) {
    at = vscode.Uri.joinPath(at, part);
    stat = await statOf(at);
    if (!stat || stat.type & vscode.FileType.SymbolicLink) return undefined;
  }
  if (!stat || !(stat.type & vscode.FileType.File)) return undefined;
  return { uri: at, rel: inside.parts.join('/'), size: stat.size };
}

/** A note's index and where the note is in it. */
type NoteIndex = NonNullable<Awaited<ReturnType<LinkService['indexForNote']>>>;

/** The files a link may mean, most likely first, for the note `from`, and the heading a wikilink goes to. */
async function noteCandidates(
  kind: unknown,
  address: string,
  from: vscode.Uri,
  found: NoteIndex | undefined,
): Promise<{ uris: vscode.Uri[]; heading?: string | undefined }> {
  if (kind === 'wikilink') {
    const link = parseWikilink(address);
    if (!link.target || !found) return { uris: [] };
    const resolution = await wikilinkResolver(found)(link.target);
    if (!resolution.path) return { uris: [] };
    return {
      uris: [vscode.Uri.joinPath(found.location.folder.uri, resolution.path)],
      heading: link.heading ?? resolution.heading,
    };
  }
  if (kind !== 'file') return { uris: [] };
  const a = readAddress(address);
  return { uris: a.kind === 'path' ? noteCandidateUris(a, from) : [] };
}

/**
 * A linked note's LF text, with the heading a wikilink to it goes to, or why it is not given:
 * none of the candidates is a note that may be read, or the note is too large or not text.
 */
type LinkedNote =
  { uri: vscode.Uri; rel: string; lf: string; heading?: string | undefined } | 'none' | 'large' | 'unreadable';

/** How much of a note may be read: at most `bytes`, and when `evenOpen`, of a note open in VS Code too. */
interface ReadLimit {
  bytes: number;
  evenOpen: boolean;
}

/** A preview shows only a note's first lines, so a note open in VS Code is previewed whatever its size. */
const PREVIEW_LIMIT: ReadLimit = { bytes: NOTE_PREVIEW_MAX_BYTES, evenOpen: false };

/** An embed draws the whole note, open or not. */
const EMBED_LIMIT: ReadLimit = { bytes: EMBED_MAX_BYTES, evenOpen: true };

/**
 * Reads the note at `candidate` through every check above, within `limit`; 'none' when it is not
 * a note that may be read. A note open in VS Code is read from its document, so it shows
 * unsaved edits.
 */
async function readNote(candidate: vscode.Uri, limit: ReadLimit): Promise<LinkedNote> {
  const note = await safeNote(candidate);
  if (!note) return 'none';
  const open = vscode.workspace.textDocuments.find((d) => !d.isClosed && sameFile(d.uri, note.uri));
  if (open) {
    const lf = toLf(documentText(open));
    return limit.evenOpen && lf.length > limit.bytes ? 'large' : { uri: note.uri, rel: note.rel, lf };
  }
  if (note.size > limit.bytes) return 'large';
  const bytes = await vscode.workspace.fs.readFile(note.uri);
  if (bytes.byteLength > limit.bytes) return 'large';
  const text = decodeBytes(bytes, 'utf8');
  return text === null ? 'unreadable' : { uri: note.uri, rel: note.rel, lf: toLf(text) };
}

/** Reads the note a link in the note `from` points to: the first of its candidates that may be read. */
async function readLinkedNote(
  from: vscode.Uri,
  kind: unknown,
  address: string,
  limit: ReadLimit,
  index?: NoteIndex,
): Promise<LinkedNote> {
  const found = index ?? (kind === 'wikilink' ? await linkService().indexForNote(from) : undefined);
  const { uris, heading } = await noteCandidates(kind, address, from, found);
  for (const candidate of uris) {
    const note = await readNote(candidate, limit);
    if (note === 'none') continue;
    return typeof note === 'string' ? note : { ...note, heading };
  }
  return 'none';
}

/**
 * Resolves wikilink targets written in the note `found` locates, by `LinkIndex.resolveLink`.
 * A note is read for its headings within EMBED_MAX_BYTES, once per resolver.
 */
export function wikilinkResolver(found: NoteIndex): (target: string) => Promise<LinkResolution> {
  const outlines = new Map<string, Promise<OutlineItem[] | null>>();
  const outlineOf = (path: string): Promise<OutlineItem[] | null> => {
    let outline = outlines.get(path);
    if (!outline) {
      outline = readNote(vscode.Uri.joinPath(found.location.folder.uri, path), EMBED_LIMIT).then(
        (note) => (typeof note === 'string' ? null : buildOutline(note.lf)),
        (error: unknown) => {
          log('warn', `Could not read ${path} for its headings`, error);
          return null;
        },
      );
      outlines.set(path, outline);
    }
    return outline;
  };
  return (target) =>
    found.index.resolveLink(target, found.location.path, async (path, heading) => {
      const outline = await outlineOf(path);
      return outline !== null && outlineHas(outline, heading);
    });
}

/**
 * `read`, a plain reading of the note at `uri`, with the emoji codes the note's own emoji setting
 * (read for its folder) allows: none while it is off. Before the list has loaded, the note is
 * read without it, and when that reading met a code, read again once the list has loaded.
 */
async function withEmoji<T>(uri: vscode.Uri, read: (emoji?: EmojiCodes) => T): Promise<T> {
  if (!emojiOn(uri)) return read();
  const names = hostEmojiNames.loaded();
  if (names) return read({ names });
  let wanted = false;
  const first = read({ names: undefined, wanted: () => (wanted = true) });
  if (!wanted) return first;
  try {
    return read({ names: await hostEmojiNames.load() });
  } catch (error) {
    log('error', 'Could not load the emoji list, so emoji codes in a linked note show as typed', error);
    return first;
  }
}

/** The start of the note a link in the note `from` points to, or null when nothing may or can be shown. */
export async function previewNote(from: vscode.Uri, kind: unknown, address: string): Promise<PreviewNoteResult> {
  const note = await readLinkedNote(from, kind, address, PREVIEW_LIMIT);
  if (typeof note === 'string') return null;
  const heading = kind === 'wikilink' ? parseWikilink(address).heading : undefined;
  const block = heading?.startsWith('^') ? heading.slice(1) : undefined;
  const syntax = plainTextSyntax(note.uri);
  const preview = await withEmoji(note.uri, (emoji) =>
    notePreviewOf(note.lf, fileNameOf(note.uri), block, { emoji, ...syntax }),
  );
  return { ...preview, path: note.rel };
}

/**
 * What an embed `![[target]]` in the note `from` shows: the part of the note it names, read
 * through the same checks as a preview, within EMBED_MAX_BYTES; or why there is nothing. With
 * it, the note's uri when there is one, so its changes can be watched.
 */
export async function embedNote(
  from: vscode.Uri,
  target: string,
): Promise<{ answer: EmbedNoteAnswer; uri?: vscode.Uri }> {
  const link = parseWikilink(target);
  const index = await linkService().indexForNote(from);
  if (!index) return { answer: { reason: 'Not shown: notes are embedded only in a note inside a workspace folder.' } };
  const name = link.target || fileNameOf(from).replace(MARKDOWN_EXT, '');
  // An empty target (`![[#Heading]]`) is this note.
  const note = link.target
    ? await readLinkedNote(from, 'wikilink', target, EMBED_LIMIT, index)
    : await readLinkedNote(from, 'file', fileNameOf(from), EMBED_LIMIT);
  if (note === 'none') return { answer: { reason: `No note named “${name}” in this workspace.` } };
  if (note === 'large') {
    return { answer: { reason: `Not shown: “${name}” is larger than ${EMBED_MAX_BYTES / 1024} KB.` } };
  }
  if (note === 'unreadable') return { answer: { reason: `Not shown: “${name}” could not be read as text.` } };
  const heading = link.target ? note.heading : link.heading;
  const part = notePart(note.lf, heading);
  if ('missing' in part) {
    const what = part.missing === 'block' ? 'block' : 'heading';
    return { answer: { reason: `No ${what} “${heading}” in “${name}”.` }, uri: note.uri };
  }
  const syntax = plainTextSyntax(note.uri);
  const title = await withEmoji(
    note.uri,
    (emoji) => notePreviewOf(note.lf, fileNameOf(note.uri), undefined, { emoji, ...syntax }).title,
  );
  return { answer: { path: note.rel, title, text: part.text }, uri: note.uri };
}
