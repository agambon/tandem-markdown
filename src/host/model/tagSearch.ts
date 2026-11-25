// What VS Code's search is given to find a tag in the workspace's markdown files: the tag after
// a line start or a space, in any letter case (Obsidian's tags are), with its nested tags
// (`#area` finds `#area/sub`), and not as the start of a longer tag (`#area` misses `#areas`).

import { TAG_BREAKS, TAG_SPACE, tagNameLength } from '../../core/markdownText';

/** Whether `tag` (without its `#`) is a tag that can be searched for: the panel reads it as one. */
export function isSearchableTag(tag: string): boolean {
  return tag !== '' && tagNameLength(tag, 0) === tag.length;
}

/** A character class's inside in PCRE2's syntax, which writes a code point as `\x{2000}`. */
const pcre = (inside: string) => inside.replace(/\\u([0-9A-F]{4})/g, '\\x{$1}');
const SPACE = `[${pcre(TAG_SPACE)}]`;
const TAG_END = `[${pcre(TAG_SPACE + TAG_BREAKS)}]`;

function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * The regular expression for VS Code's search, for a tag `isSearchableTag` accepts. Its
 * look-arounds make VS Code search with PCRE2, whose syntax (`\x{2000}`) it is written in.
 */
export function tagSearchPattern(tag: string): string {
  return `(?<=^|${SPACE})#${escape(tag)}(?=$|/|${TAG_END})`;
}
