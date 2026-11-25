// registerCommand, through which every host command is registered: what a command throws is
// logged and shown as an error message that names the command by its Command Palette title. Of
// the host it imports only the log and model/commandTitles.ts, neither of which imports more of
// it, so the modules whose commands commands.ts starts can register their own without importing
// commands.ts back.

import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { plainNotice } from '../core/noticeText';
import { log } from './log';
import { commandFailedText, commandTitles } from './model/commandTitles';

/** The Command Palette's title of each command, by id after `tandemMarkdown.` (readCommandTitles). */
let titles = new Map<string, string>();

/** Reads each command's title from the extension's manifest, for the failure messages. Called once at activation. */
export function readCommandTitles(manifest: unknown): void {
  titles = commandTitles(manifest, 'tandemMarkdown.');
}

/**
 * Registers `tandemMarkdown.<id>`. What the command throws is logged and shown as an error
 * message that names the command by its title, and the command then returns undefined.
 */
export function registerCommand<T>(id: string, run: (...args: unknown[]) => T | Promise<T>): vscode.Disposable {
  return vscode.commands.registerCommand(`tandemMarkdown.${id}`, async (...args: unknown[]) => {
    try {
      return await run(...args);
    } catch (error) {
      log('error', `The command tandemMarkdown.${id} failed`, error);
      void vscode.window.showErrorMessage(plainNotice(commandFailedText(titles.get(id), errorMessage(error))));
      return undefined;
    }
  });
}
