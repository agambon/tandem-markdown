// File-system paths as VS Code compares them, and whether a path read from a document lies inside
// a folder: the check made before the host reads a note for its preview or lets a panel load an
// image.

import type * as nodePath from 'node:path';

type PathStyle = typeof nodePath.win32 | typeof nodePath.posix;

/**
 * Whether two paths that differ only in letter case name one file, as VS Code takes them for
 * the `file` scheme: everywhere but Linux, since the default disks of Windows and macOS ignore case.
 */
export function pathCaseIgnored(platform: string = process.platform): boolean {
  return platform !== 'linux';
}

/** True when the file-system paths `a` and `b` name one file on `platform`. */
export function sameFilePath(a: string, b: string, platform: string = process.platform): boolean {
  return pathCaseIgnored(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The path from `folder` to `target`, both resolved, letter case ignored when `ignoreCase`. */
function relative(folder: string, target: string, p: PathStyle, ignoreCase: boolean): string {
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  return p.relative(fold(p.resolve(folder)), fold(p.resolve(target)));
}

const separators = (p: PathStyle) => (p.sep === '\\' ? /[\\/]/ : /\//);

/**
 * True when `target` is inside `folder` (both absolute file-system paths in the style of `p`,
 * `path.win32` or `path.posix`) once both are normalized: `.` and `..` resolved, case ignored
 * when `ignoreCase` (always for Windows paths), another drive refused. On Windows a device or
 * long-path form (`\\?\`, `\\.\`) and a name holding `:` (an alternate data stream) are
 * refused too. The folder itself is not inside itself. Symbolic links are for the caller,
 * which can ask the file system.
 */
export function isInsideFolder(folder: string, target: string, p: PathStyle, ignoreCase = p.sep === '\\'): boolean {
  if (!folder || !target || !p.isAbsolute(folder) || !p.isAbsolute(target)) return false;
  const windows = p.sep === '\\';
  if (windows && (/^[\\/]{2}[?.][\\/]/.test(target) || /^[\\/]{2}[?.][\\/]/.test(folder))) return false;
  const rel = relative(folder, target, p, ignoreCase);
  if (rel === '' || p.isAbsolute(rel)) return false;
  const parts = rel.split(separators(p));
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (windows && parts.some((s) => s.includes(':'))) return false;
  return true;
}

/** The parts of a path inside a folder, from the folder down, as `target` writes them: what `isInsideFolder` accepted. */
export function partsInside(folder: string, target: string, p: PathStyle, ignoreCase = p.sep === '\\'): string[] {
  const count = relative(folder, target, p, ignoreCase).split(separators(p)).length;
  const parts = p.resolve(target).split(separators(p));
  return parts.slice(parts.length - count);
}
