// Following the built-in git extension over time (gitApi.ts reaches it): its interface while git
// is on, and the repositories it has open. The change marks, the conflict blocks' git check and
// the check of whether git explains a write follow git through here.

import * as vscode from 'vscode';
import { followGit, type GitApi, type GitRepository } from './gitApi';

/**
 * `followGit` until the result is disposed, even when that comes before git has answered.
 * `failed` is told when git cannot be reached.
 */
export function followGitUntilDisposed(
  use: (api: GitApi | undefined) => void,
  failed: (error: unknown) => void,
): vscode.Disposable {
  let following: vscode.Disposable | undefined;
  let disposed = false;
  followGit(use).then((sub) => {
    if (disposed) sub.dispose();
    else following = sub;
  }, failed);
  return new vscode.Disposable(() => {
    disposed = true;
    following?.dispose();
  });
}

/** What a follower of git's repositories does as git and its repositories change. */
export interface RepositoryFollower {
  /** Takes git's interface as git turns on, and undefined as it turns off or the follower stops. */
  use(api: GitApi | undefined): void;
  /** Starts watching a repository git has open; what it returns is disposed as the repository closes. */
  watch(repository: GitRepository): vscode.Disposable;
  /** After git turns on or off, a repository opens or closes, or git's own state changes. */
  changed(): void;
  /** Git cannot be reached. */
  failed(error: unknown): void;
}

/** Follows every repository git has open, while git is on, until the result is disposed. */
export function followRepositories(follower: RepositoryFollower): vscode.Disposable {
  const watching = new Map<GitRepository, vscode.Disposable>();
  let subs: vscode.Disposable[] = [];

  const forget = (): void => {
    for (const sub of [...watching.values(), ...subs]) sub.dispose();
    watching.clear();
    subs = [];
  };

  const watch = (repository: GitRepository): void => {
    if (!watching.has(repository)) watching.set(repository, follower.watch(repository));
  };

  const use = (api: GitApi | undefined): void => {
    forget();
    follower.use(api);
    if (api) {
      for (const repository of api.repositories) watch(repository);
      subs.push(
        api.onDidOpenRepository((repository) => {
          watch(repository);
          follower.changed();
        }),
        api.onDidCloseRepository((repository) => {
          watching.get(repository)?.dispose();
          watching.delete(repository);
          follower.changed();
        }),
        api.onDidChangeState(() => follower.changed()),
      );
    }
    follower.changed();
  };

  const following = followGitUntilDisposed(use, (error) => follower.failed(error));
  return new vscode.Disposable(() => {
    following.dispose();
    forget();
    follower.use(undefined);
  });
}
