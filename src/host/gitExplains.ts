// Whether git explains another program's write to a note, so that no conflict file is written for
// it (docs/ARCHITECTURE.md, "Conflict files"): the file's new text is the file at HEAD, and HEAD's
// commit was made before the write reached the file, as after a checkout or a pull. The index is
// not asked, so an agent that writes and then stages or commits its own write is not explained
// (model/gitWhen.ts). HEAD's commit and its text of the file are asked of git itself
// (`getCommit('HEAD')`, `show`): the git extension's own `state.HEAD` is refreshed only after its
// watcher has seen the change. The answers together get GIT_WAIT_MS; a slow git, git turned off
// or absent, a file it does not know, or no commit date counts as not explained.

import { readFile, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { decodeBytes } from '../core/encoding';
import type { GitApi } from './gitApi';
import { followGitUntilDisposed } from './gitFollow';
import { log } from './log';
import { committedBefore, sameText } from './model/gitWhen';

/**
 * How long git's answers are waited for. A `git show` of one file answers in tens of
 * milliseconds on a working repository; a second and a half leaves room for a busy machine,
 * and a message that waits on it is held no longer than that.
 */
const GIT_WAIT_MS = 1500;

let api: GitApi | undefined;

/** Follows the git extension: its interface while git is on. */
export function startGitExplains(): vscode.Disposable {
  const following = followGitUntilDisposed(
    (git) => (api = git),
    (error) => log('warn', 'Could not reach git to tell checkouts from other writes', error),
  );
  return new vscode.Disposable(() => {
    following.dispose();
    api = undefined;
  });
}

/**
 * Another program's write to a note: the file's new text, when the host heard of it (ms), and the
 * note's encoding (VS Code's id for it), which the file is read in.
 */
export interface WriteSeen {
  text: string;
  seenAt: number;
  encoding: string;
}

/** When the write reached the file: its modification time while it still holds the new text, else when it was heard of. */
async function writtenAt(note: vscode.Uri, write: WriteSeen): Promise<number> {
  try {
    const [bytes, info] = await Promise.all([readFile(note.fsPath), stat(note.fsPath)]);
    const held = decodeBytes(bytes, write.encoding);
    return held !== null && sameText(held, write.text) ? Math.min(info.mtimeMs, write.seenAt) : write.seenAt;
  } catch {
    return write.seenAt;
  }
}

/** True when the note's new text is the file at HEAD and HEAD's commit was made before the write. */
export async function gitExplains(note: vscode.Uri, write: WriteSeen): Promise<boolean> {
  const repository = note.scheme === 'file' ? api?.getRepository(note) : undefined;
  if (!repository) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), GIT_WAIT_MS)));
  const asked = (async () => {
    // HEAD as git has it now, then the file at that very commit.
    const [commit, at] = await Promise.all([repository.getCommit('HEAD'), writtenAt(note, write)]);
    if (!committedBefore(commit.commitDate, at)) return false;
    return sameText(await repository.show(commit.hash, note.fsPath), write.text);
  })().catch(() => false);
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}
