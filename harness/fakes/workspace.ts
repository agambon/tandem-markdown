// The made-up workspace that the harness page and the render lab answer from, and the answers
// to a picture request (`resolveImages`) and to a wikilink request (`resolveLinks`) by the
// host's rules (src/host/images.ts, src/host/links/notePreview.ts). Wikilinks are matched
// with the host's own index (src/host/model/folderIndex.ts), a note's headings read from the
// made-up notes (harness/fakes/notes.ts). A picture the workspace holds draws as a small SVG
// with its name; a video or sound file it holds plays a tenth of a second of silence served
// beside the page (`silence.wav`, copied by esbuild.mjs).

import type { ImageAnswer } from '../../src/core/featureProtocol';
import { isImagePath, mediaKindOf } from '../../src/core/fileKinds';
import type { LinkResolution } from '../../src/core/wikilinks';
import { FolderIndex } from '../../src/host/model/folderIndex';
import { readAddress } from '../../src/host/model/linkAddress';
import { noteHasHeading } from './notes';

/** The made-up workspace, folder-relative paths. */
export const WORKSPACE = [
  'notes/links.md',
  'notes/Other note.md',
  'notes/Folder.md',
  'notes/Folder/Topic.md',
  'notes/deep/Deep one.md',
  'notes/deep/img/one.png',
  'notes/deep/two/Deep two.md',
  'notes/deep/two/three/Deep three.md',
  'notes/deep/two/three/three.png',
  'archive/Topic.md',
  'notes/img/pic.png',
  'notes/img/My Note-20261114.png',
  'notes/img/wide.svg',
  'notes/picture.png',
  'notes/logo.png',
  'notes/logo-dark.png',
  'notes/logo-light.png',
  'notes/dark.png',
  'notes/light.png',
  'notes/chart.png',
  'notes/chart-dark.png',
  'notes/dot.png',
  'notes/diagram.png',
  'notes/engelbart.jpg',
  'notes/small.png',
  'notes/media/image1.png',
  'assets/image.png',
  'notes/demo.mp4',
  'notes/clip.mp4',
  'notes/clip.webm',
  'notes/talk.ogg',
  'reference/Doc.pdf',
  'README.md',
];

export const index = new FolderIndex(WORKSPACE);

/** The address of the silence a held video or sound file plays, beside the page. */
const SILENCE = 'silence.wav';

/** A small picture with the file's name on it, as an SVG data address. */
function pictureOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/[<>&"']/g, '');
  const wide = path.endsWith('wide.svg');
  const width = wide ? 1600 : 320;
  const height = wide ? 200 : 160;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="#3b7dd8"/>` +
    `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="22" text-anchor="middle" dominant-baseline="middle">${name}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** What the page loads for the held file at `path`. */
function fileAnswer(path: string): ImageAnswer {
  return { uri: mediaKindOf(path) ? SILENCE : pictureOf(path) };
}

/** A path relative to `folder`, `..` read; null when it climbs out of the workspace. */
function join(folder: string, rel: string): string | null {
  const parts = folder ? folder.split('/') : [];
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join('/');
}

/** The answer for an https address. */
export type WebAnswer = (url: string) => ImageAnswer;

/** The answer to a picture request for `source`, written in the note at `from` (folder-relative). */
function imageAnswer(source: string, from: string, web: WebAnswer): ImageAnswer {
  const t = source.trim();
  if (t.startsWith('[[') && t.endsWith(']]')) {
    const r = index.resolve(t.slice(2, -2), from);
    return r.path ? fileAnswer(r.path) : { reason: 'Not found' };
  }
  const address = readAddress(t);
  if (address.kind === 'web') {
    if (address.url.startsWith('https:')) return web(address.url);
    if (address.url.startsWith('http:')) return { reason: 'http is not loaded' };
    return { reason: 'Not found' };
  }
  if (address.kind === 'refused') return { reason: `"${address.scheme}:" addresses are not loaded` };
  if (address.kind !== 'path' || address.from === 'absolute') return { reason: 'Outside the workspace' };
  const folder = address.from === 'note' ? from.slice(0, from.lastIndexOf('/')) : '';
  let inside = false;
  for (const c of address.candidates) {
    const path = join(folder, c);
    if (path === null) continue;
    inside = true;
    if (index.has(path) && (isImagePath(path) || mediaKindOf(path))) return fileAnswer(path);
  }
  return { reason: inside ? 'Not found' : 'Outside the workspace' };
}

/** The answers to a `resolveLinks` request's `targets`, for the note at `from` (folder-relative). */
export async function linkAnswers(targets: unknown, from: string): Promise<Record<string, LinkResolution>> {
  const out: Record<string, LinkResolution> = {};
  for (const t of Array.isArray(targets) ? targets : []) {
    if (typeof t === 'string') out[t] = await index.resolveLink(t, from, noteHasHeading);
  }
  return out;
}

/** The answers to a `resolveImages` request's `sources`. */
export function imageAnswers(sources: unknown, from: string, web: WebAnswer): Record<string, ImageAnswer> {
  const out: Record<string, ImageAnswer> = {};
  for (const s of Array.isArray(sources) ? sources : []) if (typeof s === 'string') out[s] = imageAnswer(s, from, web);
  return out;
}
