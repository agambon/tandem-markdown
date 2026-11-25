// The optional syntax: everything the panel reads beyond CommonMark and GFM, one entry each,
// with the setting `tandemMarkdown.syntax.<id>` that turns it off. The entries live in one file
// per family beside this one; this file joins them and answers what is on.
// docs/ARCHITECTURE.md, "Adding a syntax", says what an entry needs. package.json declares one
// setting per entry and SYNTAX.md's "Settings" lists them;
// test/panel/syntax/table.test.ts keeps all three in step.
//
// An entry switches its parser extensions (none when the drawing reads nodes CommonMark
// already gives), the drawing features listed in `draw` (the framework draws nothing for them
// while it is off), and the code-block languages in `fences`, which the code feature then
// leaves to that drawing. An entry with `choices` is a string setting: each value has its own
// parser extensions and drawing, and the value `off` has none.

import type { MarkdownConfig } from '@lezer/markdown';
import type { PanelSettings } from '../../core/protocol';
import { BOXES } from './boxes';
import { DRAWN } from './drawn';
import { FOUNDATION } from './foundation';
import { HTML } from './html';
import { INLINE } from './inline';
import { OFF, type Reading, type Syntax } from './types';

export { OFF } from './types';

export const SYNTAX = [...FOUNDATION, ...HTML, ...DRAWN, ...INLINE, ...BOXES] as const satisfies readonly Syntax[];

export type SyntaxId = (typeof SYNTAX)[number]['id'];

const ALL: readonly Syntax[] = SYNTAX;

const byId = new Map<string, Syntax>(ALL.map((s) => [s.id, s]));

/** The features an entry's drawing can switch: its own, or those of any of its choices. */
export function syntaxFeatures(syntax: Syntax): string[] {
  return 'choices' in syntax ? [...new Set(syntax.choices.flatMap((c) => c.draw))] : [...syntax.draw];
}

/** The feature ids that draw an optional syntax, each with that syntax's id. */
const featureSyntax = new Map<string, string>(ALL.flatMap((s) => syntaxFeatures(s).map((f) => [f, s.id])));

/** The value `settings` gives `syntax`: its default when the setting is missing or not one of its values. */
function valueOf(settings: PanelSettings | undefined, syntax: Syntax): boolean | string {
  const value = settings?.syntax[syntax.id];
  if ('choices' in syntax) return syntax.choices.some((c) => c.value === value) ? (value as string) : syntax.default;
  return typeof value === 'boolean' ? value : syntax.default;
}

const NOTHING: Reading = { parse: [], draw: [] };

/** What `syntax` reads and draws under `settings`. */
function readingOf(settings: PanelSettings | undefined, syntax: Syntax): Reading {
  const value = valueOf(settings, syntax);
  if ('choices' in syntax) return syntax.choices.find((c) => c.value === value) ?? NOTHING;
  return value ? syntax : NOTHING;
}

function isOn(settings: PanelSettings | undefined, syntax: Syntax): boolean {
  const value = valueOf(settings, syntax);
  return value !== false && value !== OFF;
}

/** Whether the syntax `id` is on in `settings` (for a setting with choices: any value but `off`). */
export function syntaxOn(settings: PanelSettings | undefined, id: SyntaxId): boolean {
  return isOn(settings, byId.get(id)!);
}

/** The value of the setting `id` in `settings`, its default when it is missing. */
export function syntaxValue(settings: PanelSettings | undefined, id: SyntaxId): boolean | string {
  return valueOf(settings, byId.get(id)!);
}

/** False for a drawing feature whose syntax is off; true for every other feature. */
export function featureOn(settings: PanelSettings | undefined, feature: string): boolean {
  const id = featureSyntax.get(feature);
  return id === undefined || readingOf(settings, byId.get(id)!).draw.includes(feature);
}

/** The parser extensions of the syntax that is on, in table order. */
export function syntaxParsers(settings: PanelSettings | undefined): MarkdownConfig[] {
  return ALL.flatMap((s) => readingOf(settings, s).parse);
}

/** A key that changes exactly when the language does: the parsers `syntaxParsers` gives, or the code language lookup. */
export function parserKey(settings: PanelSettings | undefined): string {
  return ALL.filter((s) => readingOf(settings, s).parse.length > 0 || (s.codeLanguage === true && isOn(settings, s)))
    .map((s) => ('choices' in s ? `${s.id}=${String(valueOf(settings, s))}` : s.id))
    .join(' ');
}

/** Whether a code block in `language` is drawn by a syntax that is on, not as code. */
export function fenceDrawn(settings: PanelSettings | undefined, language: string): boolean {
  const lower = language.toLowerCase();
  return ALL.some((s) => s.fences?.includes(lower) === true && isOn(settings, s));
}
