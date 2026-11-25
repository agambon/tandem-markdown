// Globs as VS Code's settings write them (`markdown.copyFiles.destination`, the editor
// associations), read as regular expressions over a path, and the globs of markdown files.

import { MARKDOWN_EXTENSIONS } from '../../core/fileKinds';

/** The glob of every file with the extension `extension` (`md`), as VS Code's settings write it: `*.md`. */
export function patternOf(extension: string): string {
  return `*.${extension}`;
}

/** The globs of markdown files, one for each of its extensions (`*.md`, `*.markdown`). */
export const MARKDOWN_PATTERNS: readonly string[] = MARKDOWN_EXTENSIONS.map(patternOf);

/** The characters a regular expression gives a meaning to, to be written as themselves. */
const SPECIAL = /[\\{}*+?|^$.[\]()]/g;
const PATH_SEP = '[/\\\\]';
const NOT_SEP = '[^/\\\\]';

/** What a glob VS Code cannot read becomes: it matches nothing. */
const NOTHING = /(?!)/;

/**
 * A glob (`*`, `**`, `?`, `{a,b}`, `[a-z]`, `[!a]`) as a regular expression over a whole path,
 * following VS Code's own glob parser (`src/vs/base/common/glob.ts`). A pattern with no `/`
 * matches the last segment. One that is empty or that VS Code cannot read, such as `[z-a]`,
 * matches nothing.
 */
export function globToRegExp(glob: string): RegExp {
  const trimmed = glob.trim();
  if (!trimmed) return NOTHING;
  const re = parseGlob(trimmed);
  const anchored = trimmed.includes('/') ? `^${re}$` : `(?:^|${PATH_SEP})${re}$`;
  try {
    return new RegExp(anchored, 'i');
  } catch {
    return NOTHING;
  }
}

/** Splits `pattern` on `separator`, skipping separators inside `{...}` or `[...]`, dropping a trailing empty part. */
function splitGlobAware(pattern: string, separator: string): string[] {
  if (!pattern) return [];
  const segments: string[] = [];
  let inGroup = false;
  let inBrackets = false;
  let current = '';
  for (const ch of pattern) {
    if (ch === separator && !inGroup && !inBrackets) {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '{') inGroup = true;
    else if (ch === '}') inGroup = false;
    else if (ch === '[') inBrackets = true;
    else if (ch === ']') inBrackets = false;
    current += ch;
  }
  if (current) segments.push(current);
  return segments;
}

/** Converts `*` (within one segment) or whole-segment `**` to its VS Code regular expression fragment. */
function starsToRegExp(stars: 1 | 2, isLastSegment = false): string {
  if (stars === 1) return `${NOT_SEP}*?`;
  return `(?:${PATH_SEP}|${NOT_SEP}+${PATH_SEP}${isLastSegment ? `|${PATH_SEP}${NOT_SEP}+` : ''})*?`;
}

/** Converts a glob body to an unanchored regular expression, matching VS Code's `parseRegExp`. */
function parseGlob(pattern: string): string {
  if (!pattern) return '';
  const segments = splitGlobAware(pattern, '/');
  if (segments.length > 0 && segments.every((s) => s === '**')) return '.*';

  let re = '';
  let prevWasGlobstar = false;
  segments.forEach((segment, i) => {
    if (segment === '**') {
      if (prevWasGlobstar) return;
      re += starsToRegExp(2, i === segments.length - 1);
    } else {
      let inGroup = false;
      let groupValue = '';
      let inBrackets = false;
      let bracketsValue = '';

      for (const ch of segment) {
        if (ch !== '}' && inGroup) {
          groupValue += ch;
          continue;
        }
        if (inBrackets && (ch !== ']' || !bracketsValue)) {
          if (ch === '-') bracketsValue += ch;
          else if ((ch === '^' || ch === '!') && !bracketsValue) bracketsValue += '^';
          else if (ch !== '/') bracketsValue += ch.replace(SPECIAL, '\\$&');
          continue;
        }
        switch (ch) {
          case '{':
            inGroup = true;
            continue;
          case '[':
            inBrackets = true;
            continue;
          case '}':
            re += `(?:${splitGlobAware(groupValue, ',')
              .map((branch) => parseGlob(branch))
              .join('|')})`;
            inGroup = false;
            groupValue = '';
            break;
          case ']':
            re += `[${bracketsValue}]`;
            inBrackets = false;
            bracketsValue = '';
            break;
          case '?':
            re += NOT_SEP;
            continue;
          case '*':
            re += starsToRegExp(1);
            continue;
          default:
            re += ch.replace(SPECIAL, '\\$&');
        }
      }

      if (i < segments.length - 1 && (segments[i + 1] !== '**' || i + 2 < segments.length)) {
        re += PATH_SEP;
      }
    }
    prevWasGlobstar = segment === '**';
  });
  return re;
}

/**
 * A glob for the files under a folder whose extension is one of `extensions` (lower case), in
 * any letter case. `workspace.findFiles` matches its glob with case on every system, and a file
 * watcher and the search view on Linux.
 */
export function extensionsGlob(extensions: readonly string[]): string {
  const anyCase = (extension: string) =>
    [...extension].map((c) => (c.toUpperCase() === c ? c : `[${c}${c.toUpperCase()}]`)).join('');
  return `**/*.{${extensions.map(anyCase).join(',')}}`;
}
