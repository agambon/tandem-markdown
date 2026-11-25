// Stand-ins for the host modules that the code under test reaches and a test does not look into,
// each taken as `vi.mock(path, async () => (await import('./hostStandIns')).<module>)`: the
// commands registered (`registered`), kept so that a test can run them; git that explains no
// write; agent instructions never offered (a mock a test can count); the context keys, questions
// and tabs no test asks about; what notices.ts shows through and writes to (`shown`); and git's
// interface over the repository a test gives it (`git`).

import { vi } from 'vitest';

/** Each command the code under test registered, by its id after `tandemMarkdown.`. */
export const registered = new Map<string, (...args: unknown[]) => unknown>();

export const commandRegistration = {
  registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
    registered.set(id, run);
    return { dispose: () => undefined };
  },
};

export const gitExplains = {
  gitExplains: async () => false,
  startGitExplains: () => ({ dispose: () => undefined }),
};

export const agentInstructions = { offerInstructions: vi.fn(async () => undefined) };

export const contextKeys = { setContextKey: () => undefined };

export const questions = { askPick: async () => undefined };

export const tabs = { currentTab: () => undefined, tabUri: () => undefined };

/** A part notices.ts asked conflictFiles to write: what it says, its warnings, and the write for git to explain. */
export interface PartAdded {
  facts: unknown;
  problems: { text?: string }[];
  written: unknown;
}

/**
 * What notices.ts did through backupViews, conflictViews and conflictFiles, and how they answer:
 * `added`, what became of each part (null: it stays on its way to disk), and `backupThere`,
 * whether a backup is still there to compare.
 */
export const shown = {
  versions: [] as string[],
  compared: [] as string[],
  /** What each version kept in memory was compared as, where its message names it otherwise than its kind. */
  comparedAs: [] as (string | null)[],
  /** The backups a message named otherwise than their kind, with what it named them (backupViews.nameAs). */
  named: [] as [string, string][],
  putBack: null as unknown,
  parts: [] as PartAdded[],
  added: 'written' as 'written' | 'warned' | 'none' | null,
  backupThere: true,
};

export const backupViews = {
  backupViews: {
    showVersion: async (text: string) => {
      shown.versions.push(text);
    },
    compareVersion: async (text: string, _kind: unknown, _document: unknown, versionName: string | null) => {
      shown.compared.push(text);
      shown.comparedAs.push(versionName);
    },
    compareBackup: async () => undefined,
    nameAs: (path: string, versionName: string) => {
      shown.named.push([path, versionName]);
    },
    told: () => undefined,
    stillThere: async () => shown.backupThere,
    versionUri: (backupPath: string | null) => (backupPath ? { toString: () => `file://${backupPath}` } : null),
  },
};

export const conflictViews = {
  conflictViews: {
    setPutBack: (putBack: unknown) => {
      shown.putBack = putBack;
    },
  },
};

export const conflictFiles = {
  conflictFiles: {
    add: (_note: unknown, _id: unknown, facts: unknown, problems: { text?: string }[], written: unknown) => {
      shown.parts.push({ facts, problems, written });
      return shown.added === null ? new Promise(() => undefined) : Promise.resolve(shown.added);
    },
    partsOf: () => [],
    settle: () => null,
    dropUntrue: () => undefined,
    holds: () => true,
    onDidDrop: () => ({ dispose: () => undefined }),
  },
};

/** The repository git's interface gives for every note, which a test sets before it starts what follows git. */
export const git: { repository: unknown } = { repository: null };

export const gitApi = {
  followGit: async (use: (api: unknown) => void) => {
    use({ getRepository: () => git.repository });
    return { dispose: () => undefined };
  },
};
