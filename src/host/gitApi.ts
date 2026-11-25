// The parts of the built-in git extension's public interface (`vscode.git`, version 1) that the
// change marks, the conflict files' git check and the conflict blocks' merge editor link use,
// and how to reach it. Nothing here changes a repository.

import * as vscode from 'vscode';

interface GitRef {
  readonly commit?: string;
}

interface GitChange {
  readonly uri: vscode.Uri;
}

interface GitRepositoryState {
  readonly HEAD: GitRef | undefined;
  /** The files git lists as in conflict. */
  readonly mergeChanges: readonly GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly state: GitRepositoryState;
  /** The file's text at `ref`; rejects when the file is not there. */
  show(ref: string, path: string): Promise<string>;
  /** The commit at `ref`. Its `commitDate` is optional in the interface: git may not give one. */
  getCommit(ref: string): Promise<GitCommit>;
}

interface GitCommit {
  readonly hash: string;
  readonly commitDate?: Date;
}

export interface GitApi {
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

const GIT_EXTENSION = 'vscode.git';

/**
 * Calls `use` with git's interface whenever git is enabled (now, or once it is), and with
 * undefined when it is turned off. Nothing is called when the git extension is missing.
 */
export async function followGit(use: (api: GitApi | undefined) => void): Promise<vscode.Disposable> {
  const extension = vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION);
  if (!extension) return new vscode.Disposable(() => undefined);
  const git = extension.isActive ? extension.exports : await extension.activate();
  const take = (enabled: boolean) => use(enabled ? git.getAPI(1) : undefined);
  take(git.enabled);
  // When git is turned on after it started, it says so before its interface can be had (in VS
  // Code 1.120 and 1.146 it sets its model, which fires this event, and only then the clone
  // manager that getAPI also needs), so the interface is taken once that code has finished.
  return git.onDidChangeEnablement(() => queueMicrotask(() => take(git.enabled)));
}
