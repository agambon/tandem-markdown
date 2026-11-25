// Each note opens in a rich tab where it was left: after a reload or a restart of VS Code, and
// when its tab is closed and the note opened again. The place last reported by any rich tab of
// a note is kept for it in the workspace's state (model/viewPlaces.ts says what is kept, and
// where a note changed since opens). A place is kept once the reports have settled, and at once
// when the note's last rich tab closes. It is kept by the note's uri, and follows a rename that
// VS Code reports; a note another program moves leaves its place under the old path.

import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { toLf } from '../core/eol';
import type { ViewState } from '../core/protocol';
import type { HostFeature } from './features';
import { log } from './log';
import { documentText } from './model/documentText';
import {
  keep,
  keptPlaces,
  moved,
  movedPlaceKey,
  placeOf,
  reopenAt,
  type KeptPlace,
  type ReopenAt,
} from './model/viewPlaces';
import { panels, type HostPanel } from './panels';
import { exposeSnapshot } from './testSnapshots';
import { movedKeys } from './uris';

const STATE_KEY = 'tandemMarkdown.viewPlaces';
/** How long the reports of a note's place settle before it is kept. */
const KEEP_AFTER_MS = 2000;

/** What the in-VS-Code suite reads of the places kept: each note's view state, by its uri. */
export interface PlacesTestState {
  kept: Record<string, ViewState>;
}

/** True when `key` is a local `file:` URI that still exists on disk, or any non-local URI (never assumed deleted). */
function localFileExists(key: string): boolean {
  try {
    const uri = vscode.Uri.parse(key);
    return uri.scheme !== 'file' || existsSync(uri.fsPath);
  } catch {
    return true;
  }
}

class PlaceStore implements vscode.Disposable {
  private places: Record<string, KeptPlace>;
  /** The last view state reported for each note since its place was last kept. */
  private readonly reported = new Map<string, { document: vscode.TextDocument; viewState: ViewState }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly state: vscode.Memento) {
    this.places = keptPlaces(state.get(STATE_KEY));
    this.subscriptions = [
      panels.onDidChangeViewState((p) => this.report(p)),
      panels.onDidChangePanels(() => this.keepClosed()),
      vscode.workspace.onDidRenameFiles((e) => this.renamed(e.files)),
    ];
  }

  /** Where the note opens in a rich tab given no other place; undefined opens it as if new. */
  placeFor(document: vscode.TextDocument): ReopenAt | undefined {
    const key = document.uri.toString();
    if (this.reported.has(key)) this.keep([key]);
    const text = toLf(documentText(document));
    let place = this.places[key];
    if (!place && document.uri.scheme === 'file' && localFileExists(key)) {
      const priorKey = movedPlaceKey(this.places, text, localFileExists);
      if (priorKey) {
        this.places = moved(this.places, new Map([[priorKey, key]]));
        this.write();
        place = this.places[key];
      }
    }
    return place && reopenAt(place, text);
  }

  /** Forgets every place, kept or reported. */
  forget(): void {
    this.reported.clear();
    this.places = {};
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }

  /** Each note's kept view state, by its uri. */
  keptViewStates(): Record<string, ViewState> {
    return Object.fromEntries(Object.entries(this.places).map(([key, place]) => [key, place.viewState]));
  }

  private report(p: HostPanel): void {
    if (!p.viewState || p.document.uri.scheme === 'untitled') return;
    this.reported.set(p.document.uri.toString(), { document: p.document, viewState: p.viewState });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.keep(), KEEP_AFTER_MS);
  }

  /** Keeps at once the place of each note whose last rich tab has closed. */
  private keepClosed(): void {
    const closed = [...this.reported.keys()].filter((key) => panels.panelsFor(key).length === 0);
    if (closed.length > 0) this.keep(closed);
  }

  /** Keeps the places reported for `keys` (every note reported when not given), and writes them. */
  private keep(keys = [...this.reported.keys()]): void {
    this.keepReported(keys);
    this.write();
  }

  /**
   * Notes, or folders of notes, renamed in VS Code: the place of each note under a renamed path
   * goes to its new path, a place still settling with the rest.
   */
  private renamed(files: vscode.FileRenameEvent['files']): void {
    const moves = movedKeys(new Set([...this.reported.keys(), ...Object.keys(this.places)]), files);
    if (moves.size === 0) return;
    this.keepReported([...moves.keys()]);
    this.places = moved(this.places, moves);
    this.write();
  }

  /** Keeps the places reported for `keys`, without writing them. */
  private keepReported(keys: string[]): void {
    for (const key of keys) {
      const reported = this.reported.get(key);
      if (!reported) continue;
      this.reported.delete(key);
      const text = toLf(documentText(reported.document));
      this.places = keep(this.places, key, placeOf(reported.viewState, text, Date.now()));
    }
    if (this.reported.size === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private write(): void {
    Promise.resolve(this.state.update(STATE_KEY, this.places)).catch((error: unknown) =>
      log('warn', 'Could not keep where notes were left', error),
    );
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    if (this.reported.size > 0) this.keep();
    clearTimeout(this.timer);
  }
}

let store: PlaceStore | null = null;
let testMode = false;

/** Where a note opening in a rich tab with no place of its own given opens; undefined opens it as if new. */
export function keptPlaceFor(document: vscode.TextDocument): ReopenAt | undefined {
  return store?.placeFor(document);
}

/** Test mode only: forgets every place, so each note opens next as if new. */
export function forgetPlacesForTests(): void {
  if (!testMode) throw new Error('Places are forgotten only in the test suite');
  store?.forget();
}

export const viewPlaces: HostFeature = (context, _documents, inTests) => {
  testMode = inTests;
  const created = new PlaceStore(context.workspaceState);
  store = created;
  return vscode.Disposable.from(
    ...(testMode ? [exposeSnapshot('places', () => ({ kept: created.keptViewStates() }))] : []),
    {
      dispose: () => {
        created.dispose();
        if (store === created) store = null;
      },
    },
  );
};
