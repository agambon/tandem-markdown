// A small extension loaded beside Tandem Markdown in the in-VS-Code suite, standing in for a spell
// checker or a linter. It reports each word of HELPER_WORDS in an open markdown document as a
// warning, again after every change, and offers quick fixes for them: an edit and a command
// for one word, a command alone for the other. Like such extensions it follows VS Code's open
// documents, whatever editor shows them, so what it reports for a document open only in Tandem
// Markdown is what any extension that follows open documents would report. It also registers
// the stand-in editor of objectPriorityEditor.ts and the notebook of claimingNotebook.ts.

import * as vscode from 'vscode';
import { registerClaimingNotebook } from './claimingNotebook';
import { registerObjectPriorityEditor, type HelperExports } from './objectPriorityEditor';
import { FIXED_BY_COMMAND, FIXED_BY_EDIT, HELPER_REPLACE, HELPER_SOURCE, HELPER_WORDS } from './words';

function problemsIn(document: vscode.TextDocument): vscode.Diagnostic[] {
  const text = document.getText();
  const out: vscode.Diagnostic[] = [];
  for (const { word } of HELPER_WORDS) {
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
      const range = new vscode.Range(document.positionAt(at), document.positionAt(at + word.length));
      const problem = new vscode.Diagnostic(range, `Unknown word: ${word}`, vscode.DiagnosticSeverity.Warning);
      problem.source = HELPER_SOURCE;
      problem.code = 'unknown-word';
      out.push(problem);
    }
  }
  return out;
}

function fixesFor(document: vscode.TextDocument, problem: vscode.Diagnostic): vscode.CodeAction[] {
  const word = document.getText(problem.range);
  const known = HELPER_WORDS.find((w) => w.word === word);
  if (!known) return [];
  const byCommand = new vscode.CodeAction(`Change to '${known.fix}' by a command`, vscode.CodeActionKind.QuickFix);
  byCommand.diagnostics = [problem];
  byCommand.command = {
    command: HELPER_REPLACE,
    title: byCommand.title,
    arguments: [
      document.uri.toString(),
      document.offsetAt(problem.range.start),
      document.offsetAt(problem.range.end),
      known.fix,
    ],
  };
  if (known === FIXED_BY_COMMAND) return [byCommand];
  const byEdit = new vscode.CodeAction(`Change to '${FIXED_BY_EDIT.fix}'`, vscode.CodeActionKind.QuickFix);
  byEdit.diagnostics = [problem];
  byEdit.isPreferred = true;
  byEdit.edit = new vscode.WorkspaceEdit();
  byEdit.edit.replace(document.uri, problem.range, known.fix);
  return [byEdit, byCommand];
}

export function activate(context: vscode.ExtensionContext): HelperExports {
  const problems = vscode.languages.createDiagnosticCollection(HELPER_SOURCE);
  const check = (document: vscode.TextDocument) => {
    if (document.languageId === 'markdown') problems.set(document.uri, problemsIn(document));
  };
  for (const document of vscode.workspace.textDocuments) check(document);
  context.subscriptions.push(
    problems,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => check(e.document)),
    vscode.workspace.onDidCloseTextDocument((document) => problems.delete(document.uri)),
    vscode.languages.registerCodeActionsProvider(
      { language: 'markdown' },
      {
        provideCodeActions: (document, _range, context) =>
          context.diagnostics.filter((d) => d.source === HELPER_SOURCE).flatMap((d) => fixesFor(document, d)),
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand(HELPER_REPLACE, async (uri: string, from: number, to: number, text: string) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(from), document.positionAt(to)), text);
      return vscode.workspace.applyEdit(edit);
    }),
  );
  registerClaimingNotebook(context);
  return registerObjectPriorityEditor(context);
}
