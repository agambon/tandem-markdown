// The index of linkable files, one per workspace folder, built on first use with
// `workspace.findFiles` and kept current by a watcher's create and delete events (a folder
// moved or renamed arrives as one event for the folder: its files are found again). Every
// live panel is told `linksChanged` when an index changes.

import * as vscode from 'vscode';
import { statOf } from '../localFiles';
import { log } from '../log';
import { FolderIndex, isLinkable, isSkipped, linkableGlob, SKIP_GLOB } from '../model/folderIndex';
import { panels } from '../panels';
import { workspaceRelative } from '../uris';
import { noteLocation, type NoteLocation } from './location';

/** How long after the last file event the index is brought up to date and panels told. */
const CHANGE_DEBOUNCE_MS = 500;
/** More non-linkable creations than this in one batch: the folder is scanned again instead of checking each. */
const STAT_LIMIT = 200;

interface FolderState {
  folder: vscode.WorkspaceFolder;
  index: FolderIndex | null;
  building: Promise<FolderIndex> | null;
  watcher: vscode.FileSystemWatcher | null;
}

interface FileEvent {
  type: 'create' | 'delete';
  uri: vscode.Uri;
}

export class LinkService implements vscode.Disposable {
  private readonly folders = new Map<string, FolderState>();
  private readonly events: FileEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const f of e.removed) this.dropFolder(f.uri.toString());
        if (e.removed.length || e.added.length) this.announce();
      }),
    );
  }

  /** The index of a workspace folder, built on first use. */
  indexFor(folder: vscode.WorkspaceFolder): Promise<FolderIndex> {
    const key = folder.uri.toString();
    let state = this.folders.get(key);
    if (!state) {
      state = { folder, index: null, building: null, watcher: null };
      this.folders.set(key, state);
    }
    if (state.index) return Promise.resolve(state.index);
    if (state.building) return state.building;
    const s = state;
    this.watch(s);
    const building = this.scan(folder).then(
      (paths) => {
        s.index = new FolderIndex(paths);
        s.building = null;
        // Events that came while the scan ran are applied now, in the next batch.
        if (this.events.length) this.schedule();
        return s.index;
      },
      (error: unknown) => {
        s.building = null;
        log('error', `Could not list the linkable files of ${folder.name}`, error);
        return new FolderIndex();
      },
    );
    s.building = building;
    return building;
  }

  /** The index for a note, or undefined when it is in no workspace folder. */
  async indexForNote(uri: vscode.Uri): Promise<{ location: NoteLocation; index: FolderIndex } | undefined> {
    const location = noteLocation(uri);
    if (!location) return undefined;
    return { location, index: await this.indexFor(location.folder) };
  }

  private async scan(folder: vscode.WorkspaceFolder, under?: vscode.Uri): Promise<string[]> {
    const pattern = new vscode.RelativePattern(under ?? folder, linkableGlob());
    const found = await vscode.workspace.findFiles(pattern, SKIP_GLOB);
    const out: string[] = [];
    for (const uri of found) {
      const rel = workspaceRelative(folder.uri, uri);
      if (rel !== null) out.push(rel);
    }
    return out;
  }

  private watch(state: FolderState): void {
    if (state.watcher) return;
    // Every create and delete (not content changes): a moved folder arrives as one event for the folder.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(state.folder, '**/*'),
      false,
      true,
      false,
    );
    watcher.onDidCreate((uri) => this.queue({ type: 'create', uri }));
    watcher.onDidDelete((uri) => this.queue({ type: 'delete', uri }));
    state.watcher = watcher;
  }

  private queue(event: FileEvent): void {
    if (this.disposed) return;
    this.events.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.applyEvents().catch((error: unknown) =>
        log('error', 'Could not bring the link index up to date', error),
      );
    }, CHANGE_DEBOUNCE_MS);
  }

  private async applyEvents(): Promise<void> {
    if (this.disposed) return;
    const batch = this.events.splice(0);
    let changed = false;
    const byFolder = new Map<FolderState, FileEvent[]>();
    for (const e of batch) {
      const state = this.stateFor(e.uri);
      if (!state) continue;
      if (state.building) {
        // Applied after the scan finishes.
        this.events.push(e);
        continue;
      }
      if (!state.index) continue;
      const list = byFolder.get(state);
      if (list) list.push(e);
      else byFolder.set(state, [e]);
    }
    for (const [state, events] of byFolder) {
      if (await this.applyTo(state, events)) changed = true;
    }
    if (changed) this.announce();
  }

  /** Applies one folder's events to its index. True when the index changed. */
  private async applyTo(state: FolderState, events: FileEvent[]): Promise<boolean> {
    const index = state.index!;
    let changed = false;
    const unknownCreated: vscode.Uri[] = [];
    const goneFolders = new Set<string>();
    for (const e of events) {
      const rel = workspaceRelative(state.folder.uri, e.uri);
      if (rel === null || isSkipped(rel)) continue;
      if (e.type === 'create') {
        if (isLinkable(rel)) changed = index.add(rel) || changed;
        else unknownCreated.push(e.uri);
      } else if (isLinkable(rel)) {
        changed = index.remove(rel) || changed;
      } else {
        goneFolders.add(rel);
      }
    }
    if (goneFolders.size) {
      for (const p of index.paths()) {
        for (let slash = p.indexOf('/'); slash > 0; slash = p.indexOf('/', slash + 1)) {
          if (goneFolders.has(p.slice(0, slash))) {
            changed = index.remove(p) || changed;
            break;
          }
        }
      }
    }
    if (unknownCreated.length > STAT_LIMIT) {
      // A large burst (a build, a checkout): list the folder again.
      const fresh = new FolderIndex(await this.scan(state.folder));
      const before = new Set(index.paths());
      const after = fresh.paths();
      if (after.length !== before.size || after.some((p) => !before.has(p))) {
        state.index = fresh;
        changed = true;
      }
      return changed;
    }
    for (const uri of unknownCreated) {
      const stat = await statOf(uri);
      if (!stat || !(stat.type & vscode.FileType.Directory)) continue;
      for (const rel of await this.scan(state.folder, uri)) changed = index.add(rel) || changed;
    }
    return changed;
  }

  private stateFor(uri: vscode.Uri): FolderState | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.folders.get(folder.uri.toString()) : undefined;
  }

  private dropFolder(key: string): void {
    const state = this.folders.get(key);
    state?.watcher?.dispose();
    this.folders.delete(key);
  }

  /** Tells every live panel that link answers may have changed. */
  private announce(): void {
    for (const p of panels.all()) {
      if (p.live) void p.post({ type: 'linksChanged' });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    for (const key of [...this.folders.keys()]) this.dropFolder(key);
    for (const d of this.disposables) d.dispose();
    if (service === this) service = null;
  }
}

let service: LinkService | null = null;

/** The one link service, made on first use. The links feature disposes it. */
export function linkService(): LinkService {
  service ??= new LinkService();
  return service;
}
