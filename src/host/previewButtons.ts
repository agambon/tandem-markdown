// Syncs VS Code's `hasCustomMarkdownPreview` context key with
// `tandemMarkdown.hideBuiltInPreviewButtons` so VS Code's built-in Markdown
// preview icons stay hidden when Tandem Markdown's own view buttons are used.

import * as vscode from 'vscode';
import { setContextKey } from './contextKeys';
import type { HostFeature } from './features';

const SETTING = 'tandemMarkdown.hideBuiltInPreviewButtons';
const CONTEXT_KEY = 'hasCustomMarkdownPreview';

function hideEnabled(): boolean {
  return vscode.workspace.getConfiguration('tandemMarkdown').get<boolean>('hideBuiltInPreviewButtons', true) !== false;
}

export const previewButtons: HostFeature = () => {
  const apply = () => setContextKey(CONTEXT_KEY, hideEnabled());
  apply();
  const listener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SETTING)) apply();
  });
  return vscode.Disposable.from(listener, {
    dispose: () => setContextKey(CONTEXT_KEY, false),
  });
};
