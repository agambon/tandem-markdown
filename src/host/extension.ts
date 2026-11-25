// Tandem Markdown's host: joins the document core (src/core) to VS Code. It implements the
// core's ports, forwards VS Code's events to one coordinator per markdown document, hosts the
// panel in a custom editor and switches views.
//
// Order matters: the log first, then the panel registry and the documents (which create
// coordinators for documents already open), then the editor and the commands, then the messages that
// ask the user something, the conflict files (their views before their parts, which draw what they
// load as it comes) and the features.
// In test mode `activate` returns the test hook.

import * as vscode from 'vscode';
import { backupFolder, namedBackups, pruneBackups, quietBackups } from './backups';
import { registerCommands } from './commands';
import { conflictFiles } from './conflictFiles';
import { conflictViews } from './conflictViews';
import { Documents } from './documents';
import { features } from './features';
import { createLog, log } from './log';
import { messages } from './messages';
import { registerModeSwitch } from './modeSwitch';
import { disposeNotices, keepNoticesForTests } from './notices';
import { panels } from './panels';
import { TandemMarkdownEditorProvider } from './provider';
import { allowAnswersForTests } from './questions';
import { createTestApi, type TandemMarkdownTestApi } from './testApi';

export function activate(context: vscode.ExtensionContext): TandemMarkdownTestApi | undefined {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  context.subscriptions.push(createLog(testMode));
  keepNoticesForTests(testMode);
  allowAnswersForTests(testMode);

  const documents = new Documents(context, panels);
  context.subscriptions.push(panels.start(documents, testMode), documents, { dispose: disposeNotices });

  const provider = new TandemMarkdownEditorProvider(context, documents, { testMode });
  context.subscriptions.push(provider.register(), registerModeSwitch(documents), registerCommands(context, documents));
  context.subscriptions.push(messages.start(), conflictViews.start(), conflictFiles.start(context));

  for (const feature of features) {
    try {
      context.subscriptions.push(feature(context, documents, testMode));
    } catch (error) {
      log('error', 'A feature failed to start', error);
    }
  }

  void pruneBackups(
    backupFolder(context.globalStorageUri),
    quietBackups(context.globalState),
    namedBackups(context.globalState),
  ).catch((error: unknown) => log('warn', 'Could not tidy old backups', error));
  log('info', `Tandem Markdown started (${documents.all().length} markdown documents open)`);

  if (!testMode) return undefined;
  const { api, disposable } = createTestApi(context, documents, provider);
  context.subscriptions.push(disposable);
  return api;
}
