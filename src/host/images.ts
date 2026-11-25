// Images on the host side: answers a panel's resolveImages, pickImage and saveImage requests.
//
// A source is an image address exactly as written (`files\pic.png`, `<My Note.png>`,
// `https://...`), or `[[pic.png]]` for an embed, which is matched like a wikilink, both read
// from the note the request names (`requestNote`: the panel's, or a note embedded in it). A
// file is loaded only from inside a workspace folder or the note's own folder
// (`isInsideFolder`), an `https:` address only while `tandemMarkdown.images.allowRemote` is on.

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { ImageAnswer, PickImageResult, ResolveImagesResult, SaveImageResult } from '../core/featureProtocol';
import { IMAGE_EXTENSIONS } from '../core/fileKinds';
import { listed } from '../core/listText';
import { parseWikilink } from '../core/wikilinks';
import type { HostFeature } from './features';
import { linkService } from './links/linkService';
import { candidateUris, noteFolder, noteLocation, requestNote, rootFolder } from './links/location';
import { statOf } from './localFiles';
import { isInsideFolder, pathCaseIgnored } from './model/insideFolder';
import { readAddress } from './model/linkAddress';
import { imageExtensionFor, pastedImageStem, plainCopyDestination, SAVED_IMAGE_TYPES } from './model/pastedImages';
import { registerPanelMessageHandler, stringList } from './panelMessages';
import { tellPanel, type HostPanel } from './panels';
import { readPanelSettings } from './settings';
import { toForwardSlashes } from './uris';

const REASONS = {
  outside: 'Outside the workspace',
  notFound: 'Not found',
  remoteOff: 'Remote images are off',
  http: 'http is not loaded',
  unsaved: 'Save the note to show pictures beside it',
} as const;

/** The most image sources one `resolveImages` request is answered for. */
const MAX_SOURCES = 300;
/** The largest pasted image saved. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** How many names a pasted image tries: its own, then `-1`, `-2` and on while each is taken. */
const NAME_TRIES = 100;

// ---------------------------------------------------------------------------
// What a panel may load

/** The folders a panel's page may load files from: every workspace folder and the note's own. */
function loadRoots(panel: HostPanel): string[] {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const own = noteFolder(panel.document.uri);
  if (own) roots.push(own.fsPath);
  return roots;
}

function insideRoots(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInsideFolder(root, file, path, pathCaseIgnored()));
}

async function loadable(panel: HostPanel, file: vscode.Uri): Promise<ImageAnswer> {
  const stat = await statOf(file);
  if (!stat || stat.type & vscode.FileType.Directory) return { reason: REASONS.notFound };
  return { uri: panel.webviewPanel.webview.asWebviewUri(file).toString() };
}

/** Whether `source`, written in `note`, may be shown in `panel`, and from where. */
async function resolveImage(
  source: string,
  panel: HostPanel,
  note: vscode.Uri,
  allowRemote: boolean,
): Promise<ImageAnswer> {
  const roots = loadRoots(panel);
  const trimmed = source.trim();

  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    const { target } = parseWikilink(trimmed.slice(2, -2));
    const found = target ? await linkService().indexForNote(note) : undefined;
    const resolution = found?.index.resolve(target, found.location.path);
    if (!found || !resolution?.path) return { reason: REASONS.notFound };
    return loadable(panel, vscode.Uri.joinPath(found.location.folder.uri, resolution.path));
  }

  const address = readAddress(trimmed);
  switch (address.kind) {
    case 'web': {
      let url: URL;
      try {
        url = new URL(address.url);
      } catch {
        return { reason: REASONS.notFound };
      }
      if (url.protocol === 'https:') return allowRemote ? { uri: url.href } : { reason: REASONS.remoteOff };
      if (url.protocol === 'http:') return { reason: REASONS.http };
      return { reason: `"${url.protocol}" addresses are not loaded` };
    }
    case 'refused':
      return {
        reason: address.share ? 'Network shares are not loaded' : `"${address.scheme}:" addresses are not loaded`,
      };
    case 'anchor':
      return { reason: REASONS.notFound };
    case 'path': {
      // An untitled note has no folder for a relative path to start from.
      if (address.from === 'note' && !noteFolder(note)) return { reason: REASONS.unsaved };
      let sawInside = false;
      for (const file of candidateUris(address, note)) {
        if (file.scheme !== 'file' || !insideRoots(file.fsPath, roots)) continue;
        sawInside = true;
        const answer = await loadable(panel, file);
        if ('uri' in answer) return answer;
      }
      return { reason: sawInside ? REASONS.notFound : REASONS.outside };
    }
  }
}

// ---------------------------------------------------------------------------
// Picking and saving

/** `file` as a path from the note's folder, forward slashes (or from the workspace root when the note has no folder). */
function markdownPathTo(panel: HostPanel, file: string): string {
  const own = noteFolder(panel.document.uri);
  if (own) return toForwardSlashes(path.relative(own.fsPath, file));
  const root = rootFolder(panel.document.uri);
  const rel = root ? path.relative(root.fsPath, file) : '';
  return root && !rel.startsWith('..') && !path.isAbsolute(rel) ? `/${toForwardSlashes(rel)}` : toForwardSlashes(file);
}

async function pickImage(panel: HostPanel): Promise<PickImageResult> {
  const defaultUri = noteFolder(panel.document.uri) ?? rootFolder(panel.document.uri);
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: 'Insert image',
    openLabel: 'Insert',
    filters: { Images: [...IMAGE_EXTENSIONS] },
    ...(defaultUri && { defaultUri }),
  });
  const file = picked?.[0];
  if (!file) return null;
  if (file.scheme !== 'file' || !insideRoots(file.fsPath, loadRoots(panel))) {
    tellPanel(panel, 'That image is outside the workspace, so it was not inserted. Copy it into the workspace first.');
    return null;
  }
  return { markdownPath: markdownPathTo(panel, file.fsPath) };
}

/** Where a pasted image goes: `markdown.copyFiles.destination` when it names a plain folder, else beside the note. */
function saveFolder(panel: HostPanel, noteDir: string): string {
  const uri = panel.document.uri;
  const setting = vscode.workspace.getConfiguration('markdown', uri).get('copyFiles.destination');
  const location = noteLocation(uri);
  const full = toForwardSlashes(uri.fsPath);
  const destination = plainCopyDestination(setting, location ? [location.path, full] : [full]);
  if (!destination) return noteDir;
  if (destination.startsWith('/')) {
    const root = location?.folder.uri.fsPath ?? noteDir;
    return path.join(root, destination.slice(1));
  }
  return path.join(noteDir, destination);
}

async function saveImage(
  panel: HostPanel,
  m: { name?: unknown; mime?: unknown; dataBase64?: unknown },
): Promise<SaveImageResult> {
  const name = typeof m.name === 'string' ? m.name : '';
  const mime = typeof m.mime === 'string' ? m.mime : '';
  if (typeof m.dataBase64 !== 'string' || m.dataBase64 === '') throw new Error('the image had no data.');
  const ext = imageExtensionFor(mime, name);
  if (!ext) throw new Error(`only ${listed(SAVED_IMAGE_TYPES)} images can be saved.`);
  const uri = panel.document.uri;
  if (uri.scheme !== 'file') throw new Error('this note is not a file on disk yet. Save it first.');
  const bytes = Buffer.from(m.dataBase64, 'base64');
  if (bytes.length === 0) throw new Error('the image had no data.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`the image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);

  const noteDir = path.dirname(uri.fsPath);
  const folder = saveFolder(panel, noteDir);
  await mkdir(folder, { recursive: true });
  const stem = pastedImageStem(path.basename(uri.fsPath), new Date());
  for (let k = 0; k < NAME_TRIES; k++) {
    const file = path.join(folder, k === 0 ? `${stem}.${ext}` : `${stem}-${k}.${ext}`);
    try {
      // `wx`: never over an existing file, even one written a moment ago by someone else.
      await writeFile(file, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new Error(`it could not be written to ${folder}: ${errorMessage(error)}`);
    }
    return { markdownPath: toForwardSlashes(path.relative(noteDir, file)) };
  }
  throw new Error(`a file named ${stem}.${ext} already exists in ${folder}.`);
}

export const images: HostFeature = () =>
  vscode.Disposable.from(
    registerPanelMessageHandler('resolveImages', async (m, panel) => {
      const sources = stringList(m.sources, MAX_SOURCES);
      const allowRemote = readPanelSettings(panel.uri).imagesAllowRemote;
      const note = requestNote(panel.document.uri, m.note);
      const out: ResolveImagesResult = Object.create(null);
      await Promise.all(
        sources.map(async (s) => {
          out[s] = note ? await resolveImage(s, panel, note, allowRemote) : { reason: REASONS.outside };
        }),
      );
      return out;
    }),
    registerPanelMessageHandler('pickImage', (_m, panel) => pickImage(panel)),
    registerPanelMessageHandler('saveImage', (m, panel) => saveImage(panel, m)),
  );
