// A custom text editor that does nothing but say it was asked to show a document, declared in
// the helper's manifest with its priority written as an object (`textEditor` and `diffEditor`),
// the form VS Code 1.146 reads. It stands in for Tandem Markdown declared that way, so a fact
// test can see what an older VS Code makes of the form (itest/suite/factsObjectPriority.test.ts).

import * as vscode from 'vscode';

// itest/helper/package.json declares the editor with these two as well.
export const OBJECT_PRIORITY_VIEW_TYPE = 'itestHelper.objectPriorityEditor';
/** The file name extension the editor is declared for, and no other editor is. */
export const OBJECT_PRIORITY_EXTENSION = 'objprio';

/** What the helper exports from `activate`. */
export interface HelperExports {
  /** The uris the object-priority editor was asked to show, in order. */
  objectPriorityShown(): string[];
}

export function registerObjectPriorityEditor(context: vscode.ExtensionContext): HelperExports {
  const shown: string[] = [];
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(OBJECT_PRIORITY_VIEW_TYPE, {
      resolveCustomTextEditor(document, panel) {
        shown.push(document.uri.toString());
        panel.webview.html = '<!doctype html><title>Object priority stand-in</title>';
      },
    }),
  );
  return { objectPriorityShown: () => [...shown] };
}
