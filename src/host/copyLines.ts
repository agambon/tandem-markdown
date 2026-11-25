// Copy Relative Path with Line Numbers (`tandemMarkdown.copyRelativePathWithLines`), from a rich
// tab: chat and agent extensions read a text editor's selection, and a rich tab is not one, so
// this copies a pointer to the lines selected there instead (model/lineReference.ts says what
// it copies). The selection is the one the tab last reported, once its typing has reached the
// document, so the lines are the document's.

import * as vscode from 'vscode';
import { toLf } from '../core/eol';
import { plainNotice } from '../core/noticeText';
import { registerCommand } from './commandRegistration';
import type { Documents } from './documents';
import type { HostFeature } from './features';
import { documentText } from './model/documentText';
import { copiedMessage, lineReference, NO_PATH_YET, referencePath, selectedLines } from './model/lineReference';
import { currentTab, panelOfTab } from './tabs';

/** Copies the reference for the rich tab the user is in, and returns it (undefined when nothing was copied). */
async function copyFromRichTab(documents: Documents): Promise<string | undefined> {
  const tab = currentTab();
  const panel = tab && panelOfTab(tab);
  if (!panel) return undefined;
  const document = panel.document;
  if (document.isUntitled) {
    void vscode.window.showInformationMessage(NO_PATH_YET);
    return undefined;
  }
  await documents.get(panel.uri)?.coordinator.flushPanels([panel.id]);
  const selection = panel.viewState?.selection ?? { anchor: 0, head: 0 };
  const lines = selectedLines(toLf(documentText(document)), selection.anchor, selection.head);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const reference = lineReference(referencePath(document.uri, folder?.uri.path), lines);
  await vscode.env.clipboard.writeText(reference);
  void vscode.window.showInformationMessage(plainNotice(copiedMessage(reference, document.isDirty)));
  return reference;
}

export const copyLines: HostFeature = (_context, documents) =>
  registerCommand('copyRelativePathWithLines', () => copyFromRichTab(documents));
