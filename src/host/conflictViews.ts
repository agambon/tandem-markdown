// What the user sees of conflict files and waiting messages: warnings in the Problems panel linked
// to each `.conflict` file, the agent conflict-count status bar item, the dedicated waiting-message
// status bar item, Open Conflict File, and Copy Prompt for Agent.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommand } from './commandRegistration';
import { conflictFiles } from './conflictFiles';
import { conflictFileOf } from './conflictFileWriter';
import { SHOW_WAITING_COMMAND, messages } from './messages';
import * as W from './model/conflictFile';
import {
  type FileCount,
  countWords,
  promptFor,
  statusText,
  statusTooltip,
  waitingText,
  waitingTooltip,
} from './model/conflictStatus';
import { STATUS_PRIORITY } from './statusPlaces';
import { fileNameOf } from './uris';

const OPEN_FILE_COMMAND = 'openConflictFile';

class ConflictViews {
  private diagnostics: vscode.DiagnosticCollection | null = null;
  private status: vscode.StatusBarItem | null = null;
  private waiting: vscode.StatusBarItem | null = null;

  start(): vscode.Disposable {
    this.diagnostics = vscode.languages.createDiagnosticCollection('tandemMarkdown.conflicts');
    this.status = vscode.window.createStatusBarItem(
      'tandemMarkdown.conflicts',
      vscode.StatusBarAlignment.Right,
      STATUS_PRIORITY.conflictFiles,
    );
    this.status.name = 'Tandem Markdown conflict files';
    this.waiting = vscode.window.createStatusBarItem(
      'tandemMarkdown.waitingMessages',
      vscode.StatusBarAlignment.Right,
      STATUS_PRIORITY.waitingMessages,
    );
    this.waiting.name = 'Tandem Markdown waiting messages';
    this.waiting.command = `tandemMarkdown.${SHOW_WAITING_COMMAND}`;
    return vscode.Disposable.from(
      this.diagnostics,
      this.status,
      this.waiting,
      conflictFiles.onDidChange((note) => {
        this.showProblems(note);
        this.showStatus();
      }),
      messages.onDidChange(() => this.showWaitingStatus()),
      registerCommand('copyPromptForAgent', () => this.copyPrompt()),
      registerCommand(OPEN_FILE_COMMAND, (uri) => this.openFile(uri instanceof vscode.Uri ? uri : undefined)),
    );
  }

  private showProblems(note: vscode.Uri): void {
    if (!this.diagnostics) return;
    const warnings = conflictFiles.warningsOf(note);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === note.toString());
    if (warnings.length === 0 || !document || document.isClosed) {
      this.diagnostics.delete(note);
      return;
    }
    const target = conflictFileOf(note);
    this.diagnostics.set(
      note,
      warnings.flatMap((w) =>
        w.problems.map((spot) => {
          const line = document.lineAt(Math.min(Math.max(0, spot.line), document.lineCount - 1));
          const d = new vscode.Diagnostic(line.range, spot.text, vscode.DiagnosticSeverity.Warning);
          d.source = W.PROBLEMS_SOURCE;
          d.code = { value: W.PROBLEM_LINK, target };
          return d;
        }),
      ),
    );
  }

  private counts(name: (uri: vscode.Uri) => string): FileCount[] {
    return conflictFiles.openFiles().map((f) => {
      const note = vscode.Uri.parse(f.note);
      return { note: name(note), conflictFile: name(conflictFileOf(note)), changes: f.parts.length };
    });
  }

  private showStatus(): void {
    const item = this.status;
    if (!item) return;
    const files = conflictFiles.openFiles();
    const counts = this.counts(fileNameOf);
    const countLabel = statusText(counts);
    if (countLabel === null) {
      item.hide();
      return;
    }
    item.text = countLabel;
    item.tooltip = statusTooltip(counts);
    item.command = {
      command: `tandemMarkdown.${OPEN_FILE_COMMAND}`,
      title: '',
      arguments: files.length === 1 ? [conflictFileOf(vscode.Uri.parse(files[0]!.note))] : [],
    };
    item.show();
  }

  private showWaitingStatus(): void {
    const item = this.waiting;
    if (!item) return;
    const waiting = messages.firstWaiting();
    const label = waitingText(messages.waitingCount());
    if (waiting === null || label === null) {
      item.hide();
      return;
    }
    item.text = label;
    item.tooltip = waitingTooltip(fileNameOf(waiting.note), waiting.text);
    item.show();
  }

  private async openFile(uri?: vscode.Uri): Promise<void> {
    let target = uri;
    if (!target) {
      const picked = await vscode.window.showQuickPick(
        conflictFiles.openFiles().map((f) => {
          const file = conflictFileOf(vscode.Uri.parse(f.note));
          return {
            label: fileNameOf(file),
            description: countWords(f.parts.length),
            detail: path.dirname(file.fsPath),
            file,
          };
        }),
        { placeHolder: W.QUICK_PICK_PLACEHOLDER },
      );
      target = picked?.file;
    }
    if (target) await vscode.window.showTextDocument(target, { preview: false });
  }

  private async copyPrompt(): Promise<void> {
    await conflictFiles.dropDeletedNotes();
    const text = promptFor(this.counts(relativePath));
    if (text === null) {
      messages.reply(W.NOTHING_TO_READ, 'information');
      return;
    }
    await vscode.env.clipboard.writeText(text);
    messages.reply(W.PROMPT_COPIED, 'information');
  }
}

function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(uri)
    ? vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders ?? []).length > 1)
    : uri.fsPath;
}

export const conflictViews = new ConflictViews();
