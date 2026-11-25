// What one entry of the table of optional syntax holds (index.ts).

import type { MarkdownConfig } from '@lezer/markdown';

/** The value of every setting with choices that shows its syntax as typed. */
export const OFF = 'off';

interface Entry {
  /** The setting is `tandemMarkdown.syntax.<id>`. */
  readonly id: string;
  /** One line of markdown, the setting's description in package.json and SYNTAX.md. */
  readonly description: string;
  /** Code-block languages this syntax draws in place of the code block. */
  readonly fences?: readonly string[];
  /** Whether it changes how a code block's language is found (markdown/index.ts), so the language is built again. */
  readonly codeLanguage?: boolean;
}

/** What a syntax reads and draws while it is on, or while one of its choices is taken. */
export interface Reading {
  /** Parser extensions, in the order they are configured. */
  readonly parse: readonly MarkdownConfig[];
  /** Feature ids whose drawing is this syntax alone. */
  readonly draw: readonly string[];
}

/** A syntax that is on or off: a boolean setting. */
interface ToggleSyntax extends Entry, Reading {
  readonly default: boolean;
}

/** One value of a setting with choices. */
interface Choice extends Reading {
  readonly value: string;
  /** One line of markdown, the value's description in package.json. */
  readonly description: string;
}

/**
 * A syntax that can be read in more than one way: a string setting, one value per reading.
 * One of the values is `OFF`, which reads and draws nothing.
 */
interface ChoiceSyntax extends Entry {
  readonly default: string;
  readonly choices: readonly Choice[];
}

export type Syntax = ToggleSyntax | ChoiceSyntax;
