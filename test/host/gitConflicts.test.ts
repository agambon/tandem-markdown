// The conflict blocks' git check: whether git lists a note as in conflict reaches its rich tabs
// (`gitConflict`) when a tab starts and whenever git's answer changes, and a tab's
// `openMergeEditor` runs git's own merge editor for the note. Git, the panels and the message
// router are stand-ins.

import { beforeAll, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => {
  type Listener = (value?: unknown) => void;
  const listeners = (): { add(l: Listener): { dispose(): void }; fire(value?: unknown): void } => {
    const all: Listener[] = [];
    return {
      add: (l) => {
        all.push(l);
        return { dispose: () => all.splice(all.indexOf(l), 1) };
      },
      fire: (value) => {
        for (const l of [...all]) l(value);
      },
    };
  };
  return {
    listeners,
    useGit: null as null | ((api: unknown) => void),
    handlers: new Map<string, (message: unknown, panel: unknown) => unknown>(),
    panelsLive: listeners(),
    panelsChanged: listeners(),
    panels: [] as unknown[],
    executed: [] as unknown[][],
  };
});

vi.mock('vscode', async () => {
  const { Disposable } = await import('./vscodeStandIn');
  return {
    Disposable,
    commands: {
      executeCommand: async (...args: unknown[]) => {
        world.executed.push(args);
      },
    },
  };
});
vi.mock('../../src/host/gitApi', () => ({
  followGit: async (use: (api: unknown) => void) => {
    world.useGit = use;
    return { dispose: () => undefined };
  },
}));
vi.mock('../../src/host/panels', () => ({
  panels: {
    all: () => world.panels,
    onDidBecomeLive: (l: () => void) => world.panelsLive.add(l),
    onDidChangePanels: (l: () => void) => world.panelsChanged.add(l),
  },
}));
vi.mock('../../src/host/panelMessages', () => ({
  registerPanelMessageHandler: (type: string, handler: (message: unknown, panel: unknown) => unknown) => {
    world.handlers.set(type, handler);
    return { dispose: () => world.handlers.delete(type) };
  },
}));
vi.mock('../../src/host/uris', () => ({
  sameFile: (a: { toString(): string }, b: { toString(): string }) => a.toString() === b.toString(),
}));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const uri = (path: string) => ({ scheme: 'file', fsPath: path, toString: () => `file://${path}` });
const NOTE = uri('/w/Field notes.md');
const OTHER = uri('/w/Other.md');

/** A panel of `note`, live, that records what it is sent. */
function panelOf(id: string, note: ReturnType<typeof uri>) {
  const sent: unknown[] = [];
  return { id, uri: note, live: true, disposed: false, sent, post: async (m: unknown) => sent.push(m) };
}

/** A repository whose `mergeChanges` the case sets, with git's own change event. */
const changed = world.listeners();
const repository = {
  state: { mergeChanges: [] as { uri: unknown }[], onDidChange: (l: () => void) => changed.add(l) },
};

beforeAll(async () => {
  const { gitConflicts } = await import('../../src/host/gitConflicts');
  gitConflicts({} as never, {} as never, false);
  await vi.waitFor(() => expect(world.useGit).not.toBeNull());
  world.useGit!({
    repositories: [repository],
    getRepository: () => repository,
    onDidOpenRepository: () => ({ dispose: () => undefined }),
    onDidCloseRepository: () => ({ dispose: () => undefined }),
    onDidChangeState: () => ({ dispose: () => undefined }),
  });
});

describe("a note's rich tab and git's conflicts", () => {
  it('is told at its start that git lists its note as in conflict, and told nothing for other notes', () => {
    repository.state.mergeChanges = [{ uri: NOTE }];
    const listed = panelOf('p1', NOTE);
    const other = panelOf('p2', OTHER);
    world.panels = [listed, other];
    world.panelsLive.fire(listed);
    world.panelsLive.fire(other);
    expect(listed.sent).toEqual([{ type: 'gitConflict', conflicted: true }]);
    expect(other.sent).toEqual([]);
  });

  it('is told when git stops listing its note, and only once', () => {
    const listed = world.panels[0] as ReturnType<typeof panelOf>;
    listed.sent.length = 0;
    repository.state.mergeChanges = [];
    changed.fire();
    changed.fire();
    expect(listed.sent).toEqual([{ type: 'gitConflict', conflicted: false }]);
  });

  it("opens git's merge editor for its note when the tab asks", async () => {
    world.executed.length = 0;
    await world.handlers.get('openMergeEditor')!({ type: 'openMergeEditor' }, world.panels[0]);
    expect(world.executed).toEqual([['git.openMergeEditor', NOTE]]);
  });
});
