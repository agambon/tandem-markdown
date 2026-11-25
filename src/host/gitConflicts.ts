// Whether git lists a note as in conflict, for the conflict blocks the rich views draw: while it
// does, a block's link opens VS Code's merge editor for the note, and otherwise it switches the
// tab to Source. Each live panel is told when the answer differs from what it holds (it holds
// "not" from each init), from the repositories' `mergeChanges` in the built-in git extension's
// interface (gitApi.ts); its `openMergeEditor` runs git's own command for the note.

import * as vscode from 'vscode';
import type { HostToPanel } from '../core/protocol';
import type { HostFeature } from './features';
import type { GitApi } from './gitApi';
import { followRepositories } from './gitFollow';
import { log } from './log';
import { registerPanelMessageHandler } from './panelMessages';
import { panels } from './panels';
import { PanelValue } from './panelValue';
import { sameFile } from './uris';

export const gitConflicts: HostFeature = () => {
  let git: GitApi | undefined;

  const listed = (uri: vscode.Uri): boolean => {
    if (!git || uri.scheme !== 'file') return false;
    return git.getRepository(uri)?.state.mergeChanges.some((change) => sameFile(change.uri, uri)) ?? false;
  };

  const conflicted = new PanelValue(
    (p) => listed(p.uri),
    (value): HostToPanel => ({ type: 'gitConflict', conflicted: value }),
    false,
  );

  const tellAll = (): void => {
    for (const p of panels.all()) conflicted.tell(p);
  };

  return vscode.Disposable.from(
    followRepositories({
      use: (api) => (git = api),
      watch: (repository) => repository.state.onDidChange(tellAll),
      changed: tellAll,
      failed: (error) => log('info', 'Git is not available; conflict blocks offer Source only', error),
    }),
    conflicted,
    registerPanelMessageHandler('openMergeEditor', (_m, panel) =>
      vscode.commands.executeCommand('git.openMergeEditor', panel.uri),
    ),
  );
};
