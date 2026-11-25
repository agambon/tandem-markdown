// The user's choice to link or unlink a note's tabs goes with the note when VS Code renames the
// note or a folder holding it.

import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScrollSyncTestState } from '../../src/host/scrollSync';
import { scrollSyncFeature } from '../../src/host/scrollSync';
import { registered } from './hostStandIns';
import { Uri } from './vscodeStandIn';

const world = vi.hoisted(() => ({
  /** VS Code's rename listeners, which a case calls to report a rename. */
  renamed: [] as ((e: { files: { oldUri: unknown; newUri: unknown }[] }) => void)[],
  /** What the in-VS-Code suite would read of scroll sync. */
  snapshot: null as null | (() => unknown),
}));

vi.mock('vscode', async () => {
  const { Disposable, EventEmitter, Uri } = await import('./vscodeStandIn');
  const event = () => ({ dispose: () => undefined });
  return {
    Disposable,
    EventEmitter,
    Uri,
    TabInputText: class {},
    TabInputCustom: class {},
    window: {
      tabGroups: { all: [], onDidChangeTabs: event, onDidChangeTabGroups: event },
      visibleTextEditors: [],
      onDidChangeVisibleTextEditors: event,
      showInformationMessage: async () => undefined,
    },
    workspace: {
      onDidOpenTextDocument: event,
      onDidChangeConfiguration: event,
      onDidRenameFiles: (listener: (e: { files: { oldUri: unknown; newUri: unknown }[] }) => void) => {
        world.renamed.push(listener);
        return { dispose: () => undefined };
      },
    },
  };
});
vi.mock('../../src/host/commandRegistration', async () => (await import('./hostStandIns')).commandRegistration);
vi.mock('../../src/host/contextKeys', () => ({ contextKeyList: () => [], setContextKey: () => undefined }));
vi.mock('../../src/host/panelMessages', () => ({ registerPanelMessageHandler: () => ({ dispose: () => undefined }) }));
vi.mock('../../src/host/panels', () => ({
  panels: {
    all: () => [],
    onDidChangePanels: () => ({ dispose: () => undefined }),
    onDidBecomeLive: () => ({ dispose: () => undefined }),
  },
}));
vi.mock('../../src/host/tabs', () => ({
  currentTab: () => undefined,
  isOurTab: () => false,
  panelIn: () => undefined,
  tabUri: () => undefined,
}));
vi.mock('../../src/host/testSnapshots', () => ({
  exposeSnapshot: (_name: string, read: () => unknown) => {
    world.snapshot = read;
    return { dispose: () => undefined };
  },
}));
vi.mock('../../src/host/settings', () => ({ markdownScope: () => undefined }));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const FOLDER = path.join(tmpdir(), 'notes');
const uriOf = (notePath: string) => Uri.file(path.join(FOLDER, notePath));

beforeAll(() => {
  scrollSyncFeature({} as never, {} as never, true);
});

/** The documents the user linked or unlinked, and how. */
const chosen = () => (world.snapshot!() as ScrollSyncTestState).chosen;

/** VS Code reports that it renamed `from` to `to`, both paths in the workspace. */
function rename(from: string, to: string): void {
  for (const listener of world.renamed) listener({ files: [{ oldUri: uriOf(from), newUri: uriOf(to) }] });
}

describe("a note's choice of scroll sync", () => {
  it('goes with the note when it is renamed', async () => {
    await registered.get('turnOffScrollSync')!(uriOf('Field notes.md'));
    rename('Field notes.md', 'Site visit.md');
    expect(chosen()).toContainEqual({ uri: uriOf('Site visit.md').toString(), linked: false });
    expect(chosen().map((c) => c.uri)).not.toContain(uriOf('Field notes.md').toString());
  });

  it('goes with the note when its folder is renamed', async () => {
    await registered.get('turnOnScrollSync')!(uriOf('Trips/Spring/Day one.md'));
    rename('Trips/Spring', 'Trips/Spring walks');
    expect(chosen()).toContainEqual({ uri: uriOf('Trips/Spring walks/Day one.md').toString(), linked: true });
    expect(chosen().map((c) => c.uri)).not.toContain(uriOf('Trips/Spring/Day one.md').toString());
  });
});
