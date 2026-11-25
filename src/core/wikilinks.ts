// Wikilinks (`[[Target]]`, `[[Folder/Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`,
// `![[image.png]]`) and matching a target against the workspace's files, by Foam's rule:
// case-insensitive, the target less a markdown extension equal to a markdown file's whole path
// without its extension, or the end of it at a folder boundary (another extension matches a full
// name the same way). Of several, the closest to the linking note wins (longest shared folder
// path, then fewest segments, then alphabetical). A target starting with `/` matches the whole
// workspace path; one starting with `./` or `../` is relative to the linking note's folder.

import { MARKDOWN_EXT, isMarkdownPath, lastSegment } from './fileKinds';

export interface Wikilink {
  target: string;
  heading?: string;
  alias?: string;
}

/**
 * Splits the text between `[[` and `]]`. The alias starts after the first `|` (a `\|`,
 * as written inside a table, counts the same); the heading after the first `#` of what
 * comes before it. Parts are trimmed; an empty heading or alias is left out.
 */
export function parseWikilink(inner: string): Wikilink {
  let main = inner;
  let alias: string | undefined;
  const bar = inner.indexOf('|');
  if (bar >= 0) {
    main = inner.slice(0, bar);
    if (main.endsWith('\\')) main = main.slice(0, -1);
    alias = inner.slice(bar + 1).trim();
  }
  let target = main;
  let heading: string | undefined;
  const hash = main.indexOf('#');
  if (hash >= 0) {
    target = main.slice(0, hash);
    heading = main.slice(hash + 1).trim();
  }
  const link: Wikilink = { target: target.trim() };
  if (heading) link.heading = heading;
  if (alias) link.alias = alias;
  return link;
}

interface Entry {
  path: string;
  /** NFC, lower case. */
  lower: string;
  /** For a markdown file, `lower` without its extension; otherwise null. */
  lowerStem: string | null;
  segments: number;
}

/** A name as names are compared: NFC, lower case. */
export function fold(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function addTo(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

export interface LinkResolution {
  status: 'ok' | 'ambiguous' | 'missing';
  /** The file the link goes to: the only match, or the winner of several. */
  path?: string;
  /** Every match, winner first. */
  candidates: string[];
  /** The heading the link goes to in that file, when its target is read as Bear's `Note/Heading`. */
  heading?: string;
}

/** Whether the markdown file at `path` has a heading that a link's `#heading` would name as `heading`. */
export type HasHeading = (path: string, heading: string) => Promise<boolean>;

/** The workspace's files, as wikilink targets are matched against them. */
export class LinkIndex {
  /** Markdown files by the last segment of their stem. */
  private readonly byStem = new Map<string, Entry[]>();
  /** Every file by its last segment (its name with extension). */
  private readonly byName = new Map<string, Entry[]>();

  /** Workspace-relative paths with forward slashes, for example `notes/Topic/Note.md`. */
  constructor(paths: readonly string[]) {
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const lower = fold(path);
      const lowerStem = isMarkdownPath(lower) ? lower.replace(MARKDOWN_EXT, '') : null;
      const entry: Entry = { path, lower, lowerStem, segments: path.split('/').length };
      addTo(this.byName, lastSegment(lower), entry);
      if (lowerStem !== null) addTo(this.byStem, lastSegment(lowerStem), entry);
    }
  }

  resolve(target: string, fromPath: string): LinkResolution {
    let t = target.trim().replace(/\\/g, '/').normalize('NFC');
    if (t === '') return { status: 'ok', path: fromPath, candidates: [fromPath] };

    let whole = false;
    if (t.startsWith('./') || t.startsWith('../')) {
      const joined = joinRelative(folderOf(fromPath), t);
      if (joined === null) return { status: 'missing', candidates: [] };
      t = joined;
      whole = true;
    } else if (t.startsWith('/')) {
      t = t.replace(/^\/+/, '');
      whole = true;
    }
    if (t === '') return { status: 'missing', candidates: [] };

    const matches = this.matches(fold(t), whole);
    if (matches.length === 0) return { status: 'missing', candidates: [] };
    const ranked = rank(matches, fromPath);
    return {
      status: ranked.length === 1 ? 'ok' : 'ambiguous',
      path: ranked[0]!,
      candidates: ranked,
    };
  }

  /**
   * `resolve`, or when no file answers the target, Bear's reading of it: the heading after its last
   * `/`, in the note the part before names (the linking note when empty), if `hasHeading` finds it.
   * Obsidian and Foam read `[[Note/Heading]]` as a note in a folder, so that reading comes first.
   */
  async resolveLink(target: string, fromPath: string, hasHeading: HasHeading): Promise<LinkResolution> {
    const resolution = this.resolve(target, fromPath);
    const slash = target.lastIndexOf('/');
    if (resolution.status !== 'missing' || slash < 0) return resolution;
    const heading = target.slice(slash + 1).trim();
    if (!heading) return resolution;
    const note = this.resolve(target.slice(0, slash), fromPath);
    if (!note.path || !isMarkdownPath(note.path) || !(await hasHeading(note.path, heading))) return resolution;
    return { ...note, heading };
  }

  /**
   * The shortest target that resolves to this path alone: the file's name, then with as many folders
   * in front as it takes (a markdown file's without its extension). With none, the whole path:
   * where the path is the tail of another or has a twin (`Note.md` beside `Note.markdown`), and the
   * link resolves to the closest. A `/`-rooted target is not offered: Foam and other tools follow
   * the plain rule and would not find it.
   */
  shortestTarget(path: string): string {
    const written = path.replace(MARKDOWN_EXT, '');
    const segments = written.split('/');
    const self = fold(path);
    for (let k = 1; k <= segments.length; k++) {
      const candidate = segments.slice(segments.length - k).join('/');
      const others = this.matches(fold(candidate), false).filter((e) => fold(e) !== self);
      if (others.length === 0) return candidate;
    }
    return written;
  }

  /** Paths matching a folded target; `whole` asks for a whole-path match only. */
  private matches(t: string, whole: boolean): string[] {
    const found = new Set<string>();
    const matchesEnd = (value: string, wanted: string) => value === wanted || (!whole && value.endsWith('/' + wanted));

    const stem = t.replace(MARKDOWN_EXT, '');
    for (const e of this.byStem.get(lastSegment(stem)) ?? []) {
      if (matchesEnd(e.lowerStem!, stem)) found.add(e.path);
    }
    for (const e of this.byName.get(lastSegment(t)) ?? []) {
      if (matchesEnd(e.lower, t)) found.add(e.path);
    }
    return [...found];
  }
}

// ---------------------------------------------------------------------------
// Helpers

function folderSegments(path: string): string[] {
  const parts = fold(path).split('/');
  parts.pop();
  return parts;
}

function rank(paths: string[], fromPath: string): string[] {
  const from = folderSegments(fromPath);
  const keyed = paths.map((path) => {
    const folders = folderSegments(path);
    let shared = 0;
    while (shared < folders.length && shared < from.length && folders[shared] === from[shared]) shared++;
    return { path, shared, segments: path.split('/').length, lower: fold(path) };
  });
  keyed.sort(
    (a, b) =>
      b.shared - a.shared ||
      a.segments - b.segments ||
      (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return keyed.map((k) => k.path);
}

/** The folder part of a forward-slash path; '' at the root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Joins a `./` or `../` target to a folder; null when it climbs above the workspace root. */
function joinRelative(folder: string, target: string): string | null {
  const parts = folder === '' ? [] : folder.split('/');
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}
