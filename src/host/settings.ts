// Settings that reach the panel, read for one document so that folder and language settings
// apply. Posted to every panel in `init` and again as `settings` whenever one of them changes
// (panels.ts listens).

import * as vscode from 'vscode';
import type { WhenBothChanged } from '../core/coordinator';
import type { PlainTextOptions, WikilinksMode } from '../core/plainText';
import { SETTING_DEFAULTS as D, type Mode, type PanelSettings } from '../core/protocol';

const FRONTMATTER = new Set(['table', 'source', 'hidden']);

/** True when a configuration change can alter what `readPanelSettings` returns. */
export function affectsPanelSettings(e: vscode.ConfigurationChangeEvent): boolean {
  return (
    e.affectsConfiguration('tandemMarkdown') ||
    e.affectsConfiguration('editor.tabSize') ||
    e.affectsConfiguration('editor.insertSpaces')
  );
}

/** The scope a document's settings are read in: its folder's, and markdown's language settings. */
export function markdownScope(uri: vscode.Uri | undefined): vscode.ConfigurationScope {
  return uri ? { uri, languageId: 'markdown' } : { languageId: 'markdown' };
}

/** The emoji setting for the document at `uri`: emoji codes are read as emoji unless it is off. */
export function emojiOn(uri: vscode.Uri): boolean {
  return readPanelSettings(uri).syntax['emoji'] !== false;
}

/** The `syntax.math` and `syntax.wikilinks` settings for `plainText` / outline / previews of `uri`. */
export function plainTextSyntax(uri: vscode.Uri): Pick<PlainTextOptions, 'math' | 'wikilinks'> {
  const syntax = readPanelSettings(uri).syntax;
  const w = syntax['wikilinks'];
  const wikilinks: WikilinksMode = w === 'textFirst' || w === 'off' ? w : 'noteFirst';
  return { math: syntax['math'] !== false, wikilinks };
}

export function readPanelSettings(uri?: vscode.Uri): PanelSettings {
  const scope = markdownScope(uri);
  const tm = vscode.workspace.getConfiguration('tandemMarkdown', scope);
  const editor = vscode.workspace.getConfiguration('editor', scope);
  const frontmatter = tm.get<string>('frontmatter.display', '');
  return {
    contentWidth: clampNumber(tm.get('contentWidth'), 0, 100_000, D.contentWidth),
    fontSize: clampNumber(tm.get('fontSize'), 6, 60, D.fontSize),
    fontFamily: typeof tm.get('fontFamily') === 'string' ? tm.get<string>('fontFamily', '') : '',
    lineHeight: clampNumber(tm.get('lineHeight'), 1, 3, D.lineHeight),
    tableAlignOnEdit: tm.get('table.alignOnEdit') === true,
    frontmatterDisplay: (FRONTMATTER.has(frontmatter)
      ? frontmatter
      : D.frontmatterDisplay) as PanelSettings['frontmatterDisplay'],
    imagesAllowRemote: tm.get('images.allowRemote') !== false,
    maxRichFileSizeKb: clampNumber(tm.get('maxRichFileSizeKb'), 1, 10_000_000, D.maxRichFileSizeKb),
    tabSize: clampNumber(editor.get('tabSize'), 1, 32, D.tabSize),
    insertSpaces: editor.get('insertSpaces') !== false,
    defaultRichMode: defaultRichMode(uri),
    outsideHighlight: tm.get('outsideChanges.highlight') !== false,
    outsideAnnounce: tm.get('outsideChanges.announce') !== false,
    syntax: syntaxValues(tm.get('syntax')),
    workspaceTrusted: vscode.workspace.isTrusted,
  };
}

/**
 * The `tandemMarkdown.syntax.*` settings: VS Code gives the section as one object, defaults
 * included. Only true, false and strings pass; the panel takes its default for anything else,
 * and for a string that is not one of a setting's values.
 */
function syntaxValues(section: unknown): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  if (!section || typeof section !== 'object') return out;
  for (const [name, value] of Object.entries(section))
    if (typeof value === 'boolean' || typeof value === 'string') out[name] = value;
  return out;
}

export function defaultRichMode(uri?: vscode.Uri): Mode {
  const value = vscode.workspace
    .getConfiguration('tandemMarkdown', markdownScope(uri))
    .get<string>('defaultRichMode', 'edit');
  return value === 'view' ? 'view' : 'edit';
}

/** `tandemMarkdown.outsideChanges.whenBothChanged`, read each time the core asks. */
export function whenBothChanged(uri: vscode.Uri): WhenBothChanged {
  const value = vscode.workspace
    .getConfiguration('tandemMarkdown', markdownScope(uri))
    .get<string>('outsideChanges.whenBothChanged', 'keepMine');
  return value === 'keepTheirs' ? 'keepTheirs' : 'keepMine';
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
