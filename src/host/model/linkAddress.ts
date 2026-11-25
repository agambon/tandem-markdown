// How a link's or an image's address is read: what is between `(` and `)`, exactly as
// written, angle brackets included or not. `readAddress` says what it is: a web address, a
// heading in this file, a path (with every spelling worth trying, because notes written on
// Windows put backslashes in paths that CommonMark reads as escapes), or something with a
// scheme that is not opened.

import { stripAngles, unescapeMarkdown } from '../../core/markdownText';

export type Address =
  /** http, https or mailto: opened in the browser or mail program. */
  | { kind: 'web'; url: string }
  /** `#heading` alone: a heading of this file. */
  | { kind: 'anchor'; fragment: string }
  /**
   * A file. `candidates` are the spellings to try, most likely first (each a path with
   * forward slashes). `from` says where a relative one starts: the note's folder, the
   * workspace folder's root (`/` first), or nowhere (already absolute: a drive path or a
   * `file:` address).
   */
  | { kind: 'path'; candidates: string[]; from: 'note' | 'root' | 'absolute'; fragment: string }
  /**
   * Anything else with a scheme: never opened or loaded. `share` marks a file on another
   * computer (`\\server\share\...`, `file://server/...`), refused as well.
   */
  | { kind: 'refused'; scheme: string; share?: true };

const WEB_SCHEMES = new Set(['http', 'https', 'mailto']);
/**
 * A scheme of one letter or more. The panel's pattern (render/links.ts) wants two, so that a
 * drive letter is never a scheme; here a drive path is tested first (DRIVE).
 */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const DRIVE = /^[a-zA-Z]:[\\/]/;

/** A file on another computer is not opened or loaded (VS Code's own `security.restrictUNCAccess` blocks it too). */
const SHARE: Address = { kind: 'refused', scheme: 'file', share: true };

function percentDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Reads a link or image address as written in the document. */
export function readAddress(raw: string): Address {
  const text = stripAngles(raw);
  if (text.startsWith('#')) return { kind: 'anchor', fragment: percentDecode(text.slice(1)) ?? text.slice(1) };

  if (DRIVE.test(text)) return pathAddress(text, 'absolute');
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme) {
    if (WEB_SCHEMES.has(scheme)) return { kind: 'web', url: text };
    if (scheme === 'file') return fileUrlAddress(text);
    return { kind: 'refused', scheme };
  }
  // CommonMark reads `www.x.com` and `a@b.co` written as a destination as paths; the panel
  // turns bare addresses and `<a@b.co>` into `http://` and `mailto:` before they get here.
  if (text.startsWith('//')) return { kind: 'web', url: `https:${text}` };
  // `\\server\share\x.md` (and the device forms `\\?\` and `\\.\`): a network share, refused.
  // Read as a root-relative path it would point at `\server\share` on the current drive.
  if (/^\\[\\/]/.test(text)) return SHARE;
  if (text.startsWith('/') || text.startsWith('\\')) return pathAddress(text.replace(/^[\\/]+/, ''), 'root');
  return pathAddress(text, 'note');
}

function splitFragment(text: string): { path: string; fragment: string } {
  const hash = text.indexOf('#');
  const before = hash >= 0 ? text.slice(0, hash) : text;
  const fragment = hash >= 0 ? text.slice(hash + 1) : '';
  const query = before.indexOf('?');
  return { path: query >= 0 ? before.slice(0, query) : before, fragment: percentDecode(fragment) ?? fragment };
}

/**
 * The spellings of a path worth trying: CommonMark's reading (escapes removed, percent
 * decoded), then with backslashes kept as folder separators (percent decoded), then as typed.
 */
function pathAddress(text: string, from: 'note' | 'root' | 'absolute'): Address {
  const { path, fragment } = splitFragment(text);
  const spellings = [percentDecode(unescapeMarkdown(path)), percentDecode(path), path];
  const candidates: string[] = [];
  for (const s of spellings) {
    if (s === null || s === '') continue;
    const slashed = s.replace(/\\/g, '/');
    if (!candidates.includes(slashed)) candidates.push(slashed);
  }
  return { kind: 'path', candidates, from, fragment };
}

function fileUrlAddress(text: string): Address {
  // `file://server/share/x.md` names a computer: a network share, refused (it would otherwise
  // lose the server and point at `\share\x.md` on the current drive). `localhost` is this one.
  const host = /^file:\/\/([^/\\]*)/i.exec(text)?.[1] ?? '';
  // `file://C:/x` (one slash short) is still a drive path.
  if (/^[a-zA-Z]:$/.test(host)) return fileUrlAddress(`file:///${text.slice('file://'.length)}`);
  if (host !== '' && host.toLowerCase() !== 'localhost') return SHARE;
  const { path, fragment } = splitFragment(text.replace(/^file:(\/\/[^/]*)?/i, ''));
  // file:///C:/x arrives as /C:/x; file:///home/x as /home/x.
  const decoded = percentDecode(path) ?? path;
  // `file:////server/share` and `file:\\server\share` put the share in the path.
  if (/^[\\/]{2}/.test(decoded)) return SHARE;
  const local = /^\/[a-zA-Z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  return { kind: 'path', candidates: local ? [local] : [], from: 'absolute', fragment };
}
