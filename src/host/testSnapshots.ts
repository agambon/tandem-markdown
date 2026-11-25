// What the test hook (testApi.ts) reads of each feature: a feature hands over a reader with
// `exposeSnapshot`, in test mode only, and the hook reads it with `snapshot`. It declares only the
// readers, so a feature that hands one over does not import the hook, which imports features.

import type * as vscode from 'vscode';
import type { OutlineTestState } from './outlineView';
import type { ScrollSyncTestState } from './scrollSync';
import type { StatusBarTestState } from './statusBar';
import type { PlacesTestState } from './viewPlaces';

/** What the suite reads of a feature, by feature. */
interface Snapshots {
  statusBar: StatusBarTestState;
  outline: OutlineTestState;
  scrollSync: ScrollSyncTestState;
  places: PlacesTestState;
}

/** Each reader is set by `exposeSnapshot` under its own name, so it returns that name's type. */
const snapshotReaders = new Map<keyof Snapshots, () => Snapshots[keyof Snapshots]>();

/**
 * Lets the test hook read what a feature shows. Features call it in test mode only; disposing
 * the result forgets the reader.
 */
export function exposeSnapshot<K extends keyof Snapshots>(name: K, read: () => Snapshots[K]): vscode.Disposable {
  snapshotReaders.set(name, read);
  return {
    dispose: () => {
      if (snapshotReaders.get(name) === read) snapshotReaders.delete(name);
    },
  };
}

/** What the feature `name` shows now, through the reader it handed over; throws where it is not running. */
export function snapshot<K extends keyof Snapshots>(name: K): Snapshots[K] {
  const read = snapshotReaders.get(name);
  if (!read) throw new Error(`The ${name} feature is not running`);
  return read() as Snapshots[K];
}
