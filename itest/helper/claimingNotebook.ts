// A notebook declared in the helper's manifest with no priority, so VS Code opens the files it is
// declared for in it by itself, as it would with an extension that opens markdown files as
// notebooks. It is declared only for names ending in CLAIMED_SUFFIX, so no other test's notes
// open in it (itest/suite/defaults.test.ts).

import * as vscode from 'vscode';

// itest/helper/package.json declares the notebook with these two as well.
export const CLAIMING_NOTEBOOK_TYPE = 'itestHelper.claimingNotebook';
/** The end of a markdown note's name that the notebook is declared for. */
export const CLAIMED_SUFFIX = '.claimed.md';

/** Reads a file as one markdown cell and writes the cells back one after another. */
export function registerClaimingNotebook(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(CLAIMING_NOTEBOOK_TYPE, {
      deserializeNotebook: (content) =>
        new vscode.NotebookData([
          new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, new TextDecoder().decode(content), 'markdown'),
        ]),
      serializeNotebook: (data) => new TextEncoder().encode(data.cells.map((cell) => cell.value).join('\n')),
    }),
  );
}
