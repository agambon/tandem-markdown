// The markdown parser used for both Rich views.
//
// CommonMark plus GFM (tables, task lists, strikethrough, autolinks) plus front matter, plus the
// optional syntax that is on (src/panel/syntax/). Hard line breaks are read by our own parser
// (hardBreak.ts), which gives lezer's tree in linear time. Code-block languages come from
// @codemirror/language-data and are loaded when a block first names them, read from the whole
// info string through braces and attached words (fenceInfo.ts) while that setting is on.
//
// The base is lang-markdown's `commonmarkLanguage`, not its `markdownLanguage`, because the
// latter also turns on Pandoc subscript (`~x~`), superscript (`^x^`) and its own `:emoji:`,
// which markdown-it and GitHub do not read; subscript and superscript are a choice of the
// tilde setting here.

import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { defineLanguageFacet, Language, LanguageDescription, ParseContext } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';
import type { Parser } from '@lezer/common';
import { GFM, parseCode, type MarkdownConfig, type MarkdownExtension, type MarkdownParser } from '@lezer/markdown';
import type { PanelSettings } from '../../core/protocol';
import { syntaxOn, syntaxParsers } from '../syntax';
import { fenceInfo } from './fenceInfo';
import { Frontmatter } from './frontmatter';
import { LinearHardBreak } from './hardBreak';
import { Reparse } from './reparse';
import { TildeRuns } from './tilde';

/**
 * Everything added on top of CommonMark and front matter. `LinearHardBreak` replaces lezer's own
 * hard break parser, and `TildeRuns` keeps GFM's strike out of a run of three tildes.
 */
function extensions(optional: readonly MarkdownConfig[]): MarkdownExtension {
  return [GFM, TildeRuns, ...optional, LinearHardBreak];
}

/**
 * CommonMark (with lang-markdown's folding and indent props) plus front matter and the base parse
 * wrapper, on their own and first: the wrapper must run before every other (reparse.ts says why),
 * and Lezer runs the wrappers of a base parser before those of a later `configure`. Within one
 * `configure` call the order is the reverse, so it cannot simply be listed first.
 */
const baseParser: MarkdownParser = (commonmarkLanguage.parser as MarkdownParser).configure([Reparse, Frontmatter]);

/** The bare Lezer parser for `settings` (every optional syntax at its default when omitted), for headless use. */
export function parserFor(settings?: PanelSettings): MarkdownParser {
  return baseParser.configure(extensions(syntaxParsers(settings)));
}

/** The bare Lezer parser with every optional syntax at its default. */
export const markdownParser: MarkdownParser = parserFor();

/** lang-markdown reads only `parser` from its base language; the rest of this Language is unused. */
const baseLanguage = new Language(defineLanguageFacet(), baseParser, [], 'markdown');

/**
 * The language a code block is colored in, from its whole info string: the first word, or with
 * `labels` the language as the program that wrote the fence means it (`{#id .haskell}`, `{r}`,
 * `js{1,4}`: fenceInfo.ts). Null when none of language-data's languages has that name.
 */
export function codeLanguage(info: string, labels: boolean): LanguageDescription | null {
  const name = labels ? fenceInfo(info).language : /^\S*/.exec(info)![0];
  return name ? LanguageDescription.matchLanguageName(languages, name, true) : null;
}

/**
 * Nests each code block's language in the tree. lang-markdown 6.5's own `codeLanguages` is
 * handed only the info string's first word, which for `{#id .haskell}` is `{#id`, so it is unused.
 */
function codeBlocks(labels: boolean): MarkdownExtension {
  return parseCode({
    codeParser(info): Parser | null {
      const found = codeLanguage(info, labels);
      if (!found) return null;
      return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
    },
  });
}

/** The language extension for the editor, with the optional syntax `settings` turns on. */
export function markdownLanguage(settings?: PanelSettings): Extension {
  return markdown({
    base: baseLanguage,
    extensions: [extensions(syntaxParsers(settings)), codeBlocks(syntaxOn(settings, 'codeFenceLabels'))],
    // lang-markdown's own editing helpers: its Enter and Backspace keymap, HTML tag completion
    // and paste-a-URL-as-link. commands/typing.ts and the paste feature provide their own.
    addKeymap: false,
    completeHTMLTags: false,
    pasteURLAsLink: false,
  });
}
