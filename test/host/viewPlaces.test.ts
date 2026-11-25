// A note renamed in VS Code, or moved with its folder, opens at its new path where it was left:
// its place goes with it, in memory and in the workspace's state, and the old path keeps none.

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ViewState } from '../../src/core/protocol';
import { keptPlaceFor, viewPlaces } from '../../src/host/viewPlaces';
import { memento } from './helpers';
import { __state, Uri } from './vscodeStandIn';

const world = vi.hoisted(() => ({
  /** The listeners the store gives the panel registry: a tab reported its place, a tab opened or closed. */
  reported: [] as ((panel: unknown) => void)[],
  panelsChanged: [] as (() => void)[],
  /** The rich tabs open now. */
  open: [] as { document: { uri: { toString(): string } } }[],
}));

vi.mock('vscode', () => import('./vscodeStandIn'));
vi.mock('../../src/host/panels', () => ({
  panels: {
    onDidChangeViewState: (listener: (panel: unknown) => void) => {
      world.reported.push(listener);
      return { dispose: () => world.reported.splice(world.reported.indexOf(listener), 1) };
    },
    onDidChangePanels: (listener: () => void) => {
      world.panelsChanged.push(listener);
      return { dispose: () => world.panelsChanged.splice(world.panelsChanged.indexOf(listener), 1) };
    },
    panelsFor: (key: string) => world.open.filter((p) => p.document.uri.toString() === key),
  },
}));
vi.mock('../../src/host/testSnapshots', () => ({ exposeSnapshot: () => ({ dispose: () => undefined }) }));
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const FOLDER = path.join(tmpdir(), 'notes');
const TEXT = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the note.`).join('\n') + '\n';
const LEFT: ViewState = { selection: { anchor: 400, head: 410 }, topLine: 20, topOffsetPx: 3, mode: 'view' };

/** The workspace's state, read back after a restart. */
const workspaceState = memento();

let running: { dispose(): void };

beforeAll(() => {
  running = viewPlaces({ workspaceState } as never, {} as never, false);
});

/** The uri of a note in the workspace, from its path there. */
const uriOf = (notePath: string) => Uri.file(path.join(FOLDER, notePath));

/** The note at `notePath`, holding TEXT, as VS Code hands it to the editor. */
const noteAt = (notePath: string) => ({ uri: uriOf(notePath), version: 1, getText: () => TEXT });

/** A rich tab of `note` reports `viewState`; `close` closes it at once. */
function report(note: ReturnType<typeof noteAt>, viewState: ViewState, close: boolean): void {
  const panel = { document: note, viewState };
  world.open = [panel];
  for (const listener of [...world.reported]) listener(panel);
  if (close) closeTabs();
}

function closeTabs(): void {
  world.open = [];
  for (const listener of [...world.panelsChanged]) listener();
}

/** VS Code reports that it renamed `from` to `to`, both paths in the workspace. */
function rename(from: string, to: string): void {
  __state.renamed?.({ files: [{ oldUri: uriOf(from), newUri: uriOf(to) }] });
}

describe('a renamed note', () => {
  it('opens at its new path where it was left, and does so after a restart', () => {
    report(noteAt('Field notes.md'), LEFT, true);
    rename('Field notes.md', 'Site visit.md');

    const at = { mode: 'view', viewState: LEFT };
    expect(keptPlaceFor(noteAt('Site visit.md') as never)).toEqual(at);
    expect(keptPlaceFor(noteAt('Field notes.md') as never)).toBeUndefined();

    running.dispose();
    running = viewPlaces({ workspaceState } as never, {} as never, false);
    expect(keptPlaceFor(noteAt('Site visit.md') as never)).toEqual(at);
  });

  it('opens at its new path where it was left when its folder was renamed', () => {
    report(noteAt('Trips/Spring/Day one.md'), LEFT, true);
    rename('Trips/Spring', 'Trips/Spring walks');

    expect(keptPlaceFor(noteAt('Trips/Spring walks/Day one.md') as never)).toEqual({
      mode: 'view',
      viewState: LEFT,
    });
    expect(keptPlaceFor(noteAt('Trips/Spring/Day one.md') as never)).toBeUndefined();
  });

  it('takes along a place its tab reported a moment before the rename', () => {
    const edit: ViewState = { ...LEFT, topLine: 31, mode: 'edit' };
    report(noteAt('Draft.md'), edit, false);
    rename('Draft.md', 'Letter.md');
    closeTabs();

    expect(keptPlaceFor(noteAt('Letter.md') as never)).toEqual({ mode: 'edit', viewState: edit });
    expect(keptPlaceFor(noteAt('Draft.md') as never)).toBeUndefined();
  });

  it('keeps its place when moved outside VS Code (for example by git mv) with unchanged text', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tm-ext-move-'));
    try {
      const oldPath = path.join(dir, 'before.md');
      const newPath = path.join(dir, 'after.md');
      const body = Array.from({ length: 40 }, (_, i) => `External move line ${i + 1}.`).join('\n') + '\n';
      writeFileSync(oldPath, body, 'utf8');
      const oldDoc = { uri: Uri.file(oldPath), version: 1, getText: () => body };
      const newDoc = { uri: Uri.file(newPath), version: 1, getText: () => body };
      report(oldDoc as never, LEFT, true);
      // Move on disk without firing VS Code's onDidRenameFiles.
      renameSync(oldPath, newPath);
      expect(keptPlaceFor(newDoc as never)).toEqual({ mode: 'view', viewState: LEFT });
      expect(keptPlaceFor(oldDoc as never)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
