// Where a pasted image is saved and what it is called.

import { extensionOf, isImagePath } from '../../core/fileKinds';
import { globToRegExp } from './glob';
import { timestamp } from './timestamp';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** The extensions a pasted image can be saved with. */
export const SAVED_IMAGE_TYPES = [...new Set(Object.values(MIME_EXTENSIONS))];

/** The extension a pasted image is saved with, from its type, else its name; null when it is not an image we show. */
export function imageExtensionFor(mime: string, name: string): string | null {
  const fromMime = MIME_EXTENSIONS[mime.trim().toLowerCase()];
  if (fromMime) return fromMime;
  const path = name.replace(/\\/g, '/');
  const ext = extensionOf(path);
  if (ext === 'jpeg') return 'jpg';
  return isImagePath(path) ? ext : null;
}

/** `<note name>-<yyyyMMdd-HHmmss>` in local time. */
export function pastedImageStem(noteFileName: string, at: Date): string {
  const note = noteFileName.replace(/\.[^.]*$/, '') || 'image';
  return `${note}-${timestamp(at)}`;
}

/**
 * The folder `markdown.copyFiles.destination` gives for a note, when the first entry whose
 * glob matches the note names a plain folder (ends with `/`, no `${...}` variables). Null
 * otherwise: the image then goes beside the note. Globs are matched against the note's
 * workspace-relative path and its full path, both with forward slashes.
 */
export function plainCopyDestination(setting: unknown, notePaths: readonly string[]): string | null {
  if (!setting || typeof setting !== 'object') return null;
  for (const [glob, value] of Object.entries(setting as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const re = globToRegExp(glob);
    if (!notePaths.some((p) => re.test(p))) continue;
    if (value.includes('${') || !value.endsWith('/')) return null;
    return value;
  }
  return null;
}
