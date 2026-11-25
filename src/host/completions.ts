// Suggestions in the rich views from VS Code's completion providers for the document (for
// markdown, VS Code's own: paths in links and pictures, headings after `#`, reference names).
// The panel asks only where a link's address or a reference is being typed; what is sent back
// is model/suggestions.ts's reading of the items.

import type { Text } from '@codemirror/state';
import * as vscode from 'vscode';
import type { CompletionsResult } from '../core/featureProtocol';
import type { HostFeature } from './features';
import { suggestions, type RawSuggestion } from './model/suggestions';
import { registerPanelMessageHandler } from './panelMessages';
import { offsetIn, textForRequest, toPosition } from './panelText';

/** The characters VS Code's markdown suggestions start on, passed on as the trigger. */
const TRIGGERS = new Set(['.', '/', '#']);
/** The command an item runs to ask for suggestions again (a folder, to list what is in it). */
const SUGGEST_AGAIN = 'editor.action.triggerSuggest';

function rawOf(item: vscode.CompletionItem): RawSuggestion {
  const label = typeof item.label === 'string' ? item.label : item.label.label;
  const labelParts = typeof item.label === 'string' ? [] : [item.label.detail, item.label.description];
  const detail = [...labelParts, item.detail].filter((s): s is string => typeof s === 'string' && s !== '').join(' ');
  const insert = item.insertText;
  const range = item.range instanceof vscode.Range ? item.range : item.range?.inserting;
  return {
    label,
    detail,
    filterText: item.filterText,
    sortText: item.sortText,
    insertText: insert instanceof vscode.SnippetString ? insert.value : insert,
    snippet: insert instanceof vscode.SnippetString,
    range,
    snippetKind: item.kind === vscode.CompletionItemKind.Snippet,
    hasExtraEdits: (item.additionalTextEdits?.length ?? 0) > 0,
    again: item.command?.command === SUGGEST_AGAIN,
  };
}

/**
 * The suggestions VS Code gives at `offset` of `document`, whose LF text is `doc`, as the panel
 * takes them. `trigger` is passed on only when it is one VS Code's markdown suggestions start on.
 */
export async function suggestionsAt(
  document: vscode.TextDocument,
  doc: Text,
  offset: number,
  trigger?: unknown,
): Promise<CompletionsResult> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    toPosition(doc, offset),
    typeof trigger === 'string' && TRIGGERS.has(trigger) ? trigger : undefined,
  );
  return suggestions(doc, offset, (list?.items ?? []).map(rawOf));
}

export const completions: HostFeature = (_context, documents) =>
  registerPanelMessageHandler('completions', async (m, panel): Promise<CompletionsResult> => {
    const at = await textForRequest(documents, panel, m.expect);
    if (!at) return { stale: true };
    return suggestionsAt(at.document, at.doc, offsetIn(at.doc, m.at), m.trigger);
  });
