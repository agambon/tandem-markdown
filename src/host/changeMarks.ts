// Git change marks for the rich views. For each document a panel shows that is in a git
// repository, the lines that differ from the file's text at the last commit are worked out a
// moment after the document last changed (model/lineChanges.ts) and sent to its panels as
// ranges in the host's text (panelText.ts). The committed text comes from the built-in git
// extension (gitApi.ts) and is kept per commit. Nothing is sent for a file outside every
// repository, not in the last commit, or larger than MAX_MARKED_CHARS, nor while
// `tandemMarkdown.changeMarks` is off; marks already shown are then taken away.

import * as vscode from 'vscode';
import { toLf } from '../core/eol';
import type { ChangeMark, ChangeMarksMessage } from '../core/featureProtocol';
import type { HostFeature } from './features';
import type { GitApi, GitRepository } from './gitApi';
import { followRepositories } from './gitFollow';
import { log } from './log';
import { lineChanges } from './model/lineChanges';
import { panels } from './panels';
import { syncedText } from './panelText';
import { markdownScope } from './settings';

/** How long after the document's last change, or git's, the marks are worked out again. */
const CHANGE_MARKS_PAUSE_MS = 300;
/** Larger documents get no marks: the comparison runs on the extension host's one thread. */
const MAX_MARKED_CHARS = 2 * 1024 * 1024;

const BOM = '\uFEFF';

/** `tandemMarkdown.changeMarks` for the document, read as the other settings are. */
function marksOn(uri: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration('tandemMarkdown', markdownScope(uri)).get('changeMarks') !== false;
}

export const changeMarks: HostFeature = (_context, documents) => {
  let git: GitApi | undefined;
  /** The file's LF text at a commit (null: not in it), by uri. */
  const committed = new Map<string, { commit: string; text: Promise<string | null> }>();
  const due = new Map<string, NodeJS.Timeout>();
  /** The documents whose panels were sent marks, so that they are told when there are none. */
  const shown = new Set<string>();
  /** The last refresh started for each document; an older one that ends later sends nothing. */
  const latest = new Map<string, number>();
  let run = 0;

  const committedText = (repository: GitRepository, uri: vscode.Uri): Promise<string | null> => {
    const commit = repository.state.HEAD?.commit;
    if (!commit) return Promise.resolve(null);
    const key = uri.toString();
    const kept = committed.get(key);
    if (kept && kept.commit === commit) return kept.text;
    const text = repository.show(commit, uri.fsPath).then(
      (t) => toLf(t.startsWith(BOM) ? t.slice(BOM.length) : t),
      () => null,
    );
    committed.set(key, { commit, text });
    return text;
  };

  const marksFor = async (uri: vscode.Uri): Promise<{ version: number; marks: ChangeMark[] } | undefined> => {
    if (!git || uri.scheme !== 'file' || !marksOn(uri)) return undefined;
    const repository = git.getRepository(uri);
    if (!repository) return undefined;
    const base = await committedText(repository, uri);
    // Read after the wait: the marks are given in the text the panels have now.
    const synced = syncedText(documents, uri);
    if (base === null || !synced || synced.doc.length > MAX_MARKED_CHARS || base.length > MAX_MARKED_CHARS)
      return undefined;
    return { version: synced.version, marks: lineChanges(base, synced.doc) };
  };

  const refresh = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    if (panels.livePanelsFor(key).length === 0) return;
    const mine = ++run;
    latest.set(key, mine);
    const found = await marksFor(uri);
    if (latest.get(key) !== mine) return;
    latest.delete(key);
    const to = panels.livePanelsFor(key);
    const synced = syncedText(documents, uri);
    if (to.length === 0 || !synced) return;
    if (!found?.marks.length && !shown.has(key)) return;
    const message: ChangeMarksMessage = found
      ? { type: 'changeMarks', version: found.version, marks: found.marks }
      : { type: 'changeMarks', version: synced.version, marks: [] };
    if (message.marks.length > 0) shown.add(key);
    else shown.delete(key);
    for (const p of to) void p.post(message);
  };

  const refreshSoon = (uri: vscode.Uri) => {
    const key = uri.toString();
    const waiting = due.get(key);
    if (waiting) clearTimeout(waiting);
    due.set(
      key,
      setTimeout(() => {
        due.delete(key);
        refresh(uri).catch((error: unknown) => log('warn', 'The change marks could not be worked out', error));
      }, CHANGE_MARKS_PAUSE_MS),
    );
  };

  const refreshAll = () => {
    const uris = new Map(panels.all().map((p) => [p.uri.toString(), p.uri]));
    for (const uri of uris.values()) refreshSoon(uri);
  };

  const watchRepository = (repository: GitRepository): vscode.Disposable => {
    let commit = repository.state.HEAD?.commit;
    return repository.state.onDidChange(() => {
      // A commit, a checkout or a reset moves HEAD; other changes of git's state do not move the marks.
      const now = repository.state.HEAD?.commit;
      if (now === commit) return;
      commit = now;
      refreshAll();
    });
  };

  return vscode.Disposable.from(
    followRepositories({
      use: (api) => {
        committed.clear();
        git = api;
      },
      watch: watchRepository,
      changed: refreshAll,
      failed: (error) => log('info', 'Git is not available; the rich views show no change marks', error),
    }),
    panels.onDidBecomeLive((p) => {
      // Every init starts the panel's state afresh; what it was shown before is gone.
      shown.delete(p.uri.toString());
      refreshSoon(p.uri);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0 && panels.panelsFor(e.document.uri).length > 0) refreshSoon(e.document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tandemMarkdown.changeMarks')) refreshAll();
    }),
    {
      dispose: () => {
        for (const t of due.values()) clearTimeout(t);
        due.clear();
      },
    },
  );
};
