// Rename in the rich views, by whatever rename provider VS Code has for the document (for
// markdown, VS Code's own: a heading and the links to it, a link's file and every link to it,
// a reference and its definition). `prepareRename` says what a rename at a place would rename;
// `rename` asks the provider for the edit and has VS Code apply it, to this document and any
// other, as a refactoring. The panel sees its own document's part as an ordinary change.

import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { PrepareRenameResult, RenameResult } from '../core/featureProtocol';
import type { HostFeature } from './features';
import { MAX_MESSAGE_TEXT, registerPanelMessageHandler } from './panelMessages';
import { offsetIn, textForRequest, toOffset, toPosition } from './panelText';

const NOTHING_TO_RENAME = "There's no heading, link or reference here to rename.";
const NOTHING_RENAMED = 'Nothing was renamed: there was nothing to change.';
const TEXT_CHANGED = 'The note changed before the rename could be made, so nothing was renamed. Press F2 to try again.';
const NOT_APPLIED = 'VS Code did not apply the rename, so nothing was renamed.';

/** What `vscode.prepareRename` resolves with. */
type PreparedRename = { range: vscode.Range; placeholder: string } | vscode.Range | undefined;

export const rename: HostFeature = (_context, documents) =>
  vscode.Disposable.from(
    registerPanelMessageHandler('prepareRename', async (m, panel): Promise<PrepareRenameResult> => {
      const at = await textForRequest(documents, panel, m.expect);
      if (!at) return { stale: true };
      const position = toPosition(at.doc, offsetIn(at.doc, m.at));
      let found: PreparedRename;
      try {
        found = await vscode.commands.executeCommand<PreparedRename>('vscode.prepareRename', at.document.uri, position);
      } catch (error) {
        // A provider refuses with a sentence for the user.
        return { refused: errorMessage(error) || NOTHING_TO_RENAME };
      }
      if (!found) return { refused: NOTHING_TO_RENAME };
      const range = found instanceof vscode.Range ? found : found.range;
      const from = toOffset(at.doc, range.start);
      const to = toOffset(at.doc, range.end);
      const placeholder = found instanceof vscode.Range ? at.doc.sliceString(from, to) : found.placeholder;
      return { from, to, placeholder };
    }),
    registerPanelMessageHandler('rename', async (m, panel): Promise<RenameResult> => {
      const newName = m.newName;
      if (typeof newName !== 'string' || newName.length === 0 || newName.length > MAX_MESSAGE_TEXT)
        throw new Error('rename needs a new name');
      const at = await textForRequest(documents, panel, m.expect);
      if (!at) return { stale: true };
      const position = toPosition(at.doc, offsetIn(at.doc, m.at));
      let edit: vscode.WorkspaceEdit | undefined;
      try {
        edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
          'vscode.executeDocumentRenameProvider',
          at.document.uri,
          position,
          newName,
        );
      } catch (error) {
        return { refused: errorMessage(error) || NOTHING_TO_RENAME };
      }
      if (!edit || edit.size === 0) return { refused: NOTHING_RENAMED };
      // The edit was worked out against the text checked above; anything typed since would move its places.
      if (at.document.isClosed || at.document.version !== at.version) return { refused: TEXT_CHANGED };
      const applied = await documents.applyUserEdit(at.document.uri, () =>
        vscode.workspace.applyEdit(edit, { isRefactoring: true }),
      );
      return applied ? { done: true } : { refused: NOT_APPLIED };
    }),
  );
