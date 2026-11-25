// Front matter: a block of data at the very start of the file.
//
// Rule (core/frontmatter.ts, shared with the outline and the word count): line 1 is exactly
// `---` (YAML), running to the next line that is exactly `---` or `...`; or exactly `+++`
// (TOML), running to the next `+++`. Behind a setting, JSON as Hugo and GitLab write it:
// between `;;;` lines, or a bare object whose first character starts the file and whose
// closing brace ends a line. An unclosed block is not front matter, and line 1 is then parsed
// as ordinary markdown. A closed block is never parsed as a rule plus a Setext heading.
//
// Nodes: `Frontmatter` (a leaf block from the start of the file to the end of the closing
// line) holding a `FrontmatterMark` for its opening and its closing line, none for a bare
// object. The data is the text between the marks; it is not parsed here.

import { tags } from '@lezer/highlight';
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';
import { findClosingLine, findFrontmatterEnd, type ReadableText } from '../../core/frontmatter';
import { isSpaceOrTab } from '../../core/markdownText';
import { frontmatterEndIn } from './blockContext';

/** The forms front matter is written in, known by the file's first line. */
type FrontmatterForm = 'yaml' | 'toml' | 'json' | 'bareJson';

/** The form of the front matter whose first line is `line`. */
export function frontmatterForm(line: string): FrontmatterForm {
  if (line === '+++') return 'toml';
  if (line === ';;;') return 'json';
  return line.startsWith('{') ? 'bareJson' : 'yaml';
}

/** A bare JSON object longer than this at the start of a file is not read as front matter. */
const MAX_BARE_JSON = 64 * 1024;

/**
 * The end of a bare JSON object that starts `source`: the closing brace that matches its
 * opening one, which must end its line, and the object must parse. -1 otherwise.
 */
function bareJsonEnd(source: ReadableText): number {
  const text = source.read(0, Math.min(source.length, MAX_BARE_JSON));
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if ((ch === '}' || ch === ']') && --depth === 0) {
      let end = i + 1;
      while (isSpaceOrTab(text.charCodeAt(end))) end++;
      if (end < text.length && text[end] !== '\n') return -1;
      try {
        const value: unknown = JSON.parse(text.slice(0, i + 1));
        return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length ? end : -1;
      } catch {
        return -1;
      }
    }
  }
  return -1;
}

/** Where the front matter at the start of `input` ends, in any form, or -1. */
export function frontmatterEnd(input: ReadableText): number {
  if (input.length < 2) return -1;
  const start = input.read(0, 4);
  if (start.startsWith('{')) return bareJsonEnd(input);
  if (start === ';;;\n') return findClosingLine(input, [';;;'], 4);
  return findFrontmatterEnd(input);
}

/**
 * Reads the front matter block of the `forms` given, when line 1 opens one: the base parser's
 * YAML, and the forms the optional syntax adds (syntax/boxes.ts).
 */
function frontmatterBlock(forms: readonly FrontmatterForm[]): (cx: BlockContext, line: Line) => boolean {
  return (cx, line) => {
    const form = frontmatterForm(line.text);
    if (cx.lineStart !== 0 || cx.depth !== 1 || !forms.includes(form)) return false;
    const end = frontmatterEndIn(cx);
    if (end < 0) return false;
    const fenced = form !== 'bareJson';
    const marks = fenced ? [cx.elt('FrontmatterMark', 0, 3)] : [];
    while (cx.lineStart + line.text.length < end) {
      if (!cx.nextLine()) break;
    }
    if (fenced) marks.push(cx.elt('FrontmatterMark', end - 3, end));
    cx.nextLine();
    cx.addElement(cx.elt('Frontmatter', 0, end, marks));
    return true;
  };
}

export const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true, style: tags.meta },
    { name: 'FrontmatterMark', style: tags.processingInstruction },
  ],
  parseBlock: [{ name: 'Frontmatter', parse: frontmatterBlock(['yaml']), before: 'LinkReference' }],
};

/** TOML front matter between `+++` lines. It needs the base parser, whose wrapper finds where front matter ends. */
export const TomlFrontmatter: MarkdownConfig = {
  parseBlock: [{ name: 'TomlFrontmatter', parse: frontmatterBlock(['toml']), before: 'LinkReference' }],
};

/** JSON front matter, between `;;;` lines or a bare object. It needs the base parser, as TOML does. */
export const JsonFrontmatter: MarkdownConfig = {
  parseBlock: [{ name: 'JsonFrontmatter', parse: frontmatterBlock(['json', 'bareJson']), before: 'LinkReference' }],
};
