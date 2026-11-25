// The index of one workspace folder's linkable files (markdown, the image types, pdf, video and
// sound), as folder-relative paths with forward slashes. links/linkService.ts fills it from
// `workspace.findFiles` and keeps it current from a file watcher; it answers wikilink matching
// through core/wikilinks.ts and `[[` completion.

import type { LinkTargetItem } from '../../core/featureProtocol';
import {
  extensionOf,
  IMAGE_EXTENSIONS,
  MARKDOWN_EXT,
  MARKDOWN_EXTENSIONS,
  MEDIA_EXTENSIONS,
} from '../../core/fileKinds';
import { fold, folderOf, LinkIndex, type HasHeading, type LinkResolution } from '../../core/wikilinks';
import { extensionsGlob } from './glob';

const LINKABLE_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...IMAGE_EXTENSIONS, 'pdf', ...MEDIA_EXTENSIONS] as const;
const LINKABLE = new Set<string>(LINKABLE_EXTENSIONS);
/** The most files `[[` completion offers. */
const TARGET_LIMIT = 50;

export function isLinkable(path: string): boolean {
  return LINKABLE.has(extensionOf(path));
}

/** True for a path inside a folder the index skips (`node_modules`, `.git`). */
export function isSkipped(path: string): boolean {
  return /(^|\/)(node_modules|\.git)(\/|$)/.test(path);
}

/** The glob for `findFiles`. */
export function linkableGlob(): string {
  return extensionsGlob(LINKABLE_EXTENSIONS);
}

export const SKIP_GLOB = '{**/node_modules/**,**/.git/**}';

export class FolderIndex {
  private readonly set = new Set<string>();
  private built: LinkIndex | null = null;

  constructor(paths: Iterable<string> = []) {
    for (const p of paths) if (isLinkable(p) && !isSkipped(p)) this.set.add(p);
  }

  has(path: string): boolean {
    return this.set.has(path);
  }

  paths(): string[] {
    return [...this.set];
  }

  /** Adds a file. False when it is not linkable or already there. */
  add(path: string): boolean {
    if (!isLinkable(path) || isSkipped(path) || this.set.has(path)) return false;
    this.set.add(path);
    this.built = null;
    return true;
  }

  /** Removes a file, or every file under a folder of that path. True when anything went. */
  remove(path: string): boolean {
    let changed = this.set.delete(path);
    const under = path.endsWith('/') ? path : `${path}/`;
    for (const p of this.set) {
      if (p.startsWith(under)) {
        this.set.delete(p);
        changed = true;
      }
    }
    if (changed) this.built = null;
    return changed;
  }

  get index(): LinkIndex {
    this.built ??= new LinkIndex([...this.set]);
    return this.built;
  }

  resolve(target: string, fromPath: string): LinkResolution {
    return this.index.resolve(target, fromPath);
  }

  /** A wikilink's target, Bear's `Note/Heading` included (`LinkIndex.resolveLink`). */
  resolveLink(target: string, fromPath: string, hasHeading: HasHeading): Promise<LinkResolution> {
    return this.index.resolveLink(target, fromPath, hasHeading);
  }

  /**
   * Files for `[[` completion, best first, at most `limit`. Empty query: the files in the
   * note's own folder, then the rest by path. Otherwise: names starting with the query, then
   * names holding it, then paths holding it, then paths holding its letters in order.
   */
  targets(query: string, fromPath: string, limit = TARGET_LIMIT): LinkTargetItem[] {
    const q = fold(query.trim().replace(/\\/g, '/'));
    const fromFolder = folderOf(fromPath);
    const scored: { path: string; tier: number; at: number; name: string }[] = [];
    for (const path of this.set) {
      if (path === fromPath) continue;
      const name = displayName(path);
      const lowerName = fold(name);
      const lowerPath = fold(path);
      let tier: number;
      let at = 0;
      if (q === '') {
        tier = folderOf(path) === fromFolder ? 0 : 1;
      } else if (lowerName.startsWith(q)) {
        tier = 0;
      } else if ((at = lowerName.indexOf(q)) >= 0) {
        tier = 1;
      } else if ((at = lowerPath.indexOf(q)) >= 0) {
        tier = 2;
      } else if (inOrder(lowerPath, q)) {
        tier = 3;
      } else {
        continue;
      }
      scored.push({ path, tier, at, name: lowerName });
    }
    const depth = (p: string) => p.split('/').length;
    scored.sort(
      (a, b) =>
        a.tier - b.tier ||
        a.at - b.at ||
        a.name.length - b.name.length ||
        depth(a.path) - depth(b.path) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    const index = this.index;
    return scored.slice(0, limit).map(({ path }) => ({
      label: displayName(path),
      target: index.shortestTarget(path),
      detail: folderOf(path),
    }));
  }
}

function displayName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(MARKDOWN_EXT, '');
}

/** True when every character of `q` appears in `s`, in order. */
function inOrder(s: string, q: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}
