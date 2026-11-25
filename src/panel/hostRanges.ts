// Ranges the host sends in its own text at one of its log versions (problems, change marks),
// placed in this panel's text. The panel shows the host's text at its synced version with its
// unsent changes on top, so a set for that version is carried over those changes. A set for a
// version the panel has not reached yet (its updates are still queued) is held, and placed by
// the transaction that reaches that version, over the updates after it. docs/ARCHITECTURE.md,
// "VS Code's features in the rich views".

import { getSyncedVersion, sendableUpdates } from '@codemirror/collab';
import {
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type StateEffectType,
  type Transaction,
} from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { panelContext } from './context';
import { receivedUpdates } from './sync';

export interface HostSpan {
  from: number;
  to: number;
}

/** Carries an item over a change; null when the change took it away. */
type MapSpan<T extends HostSpan> = (item: T, changes: ChangeDesc) => T | null;

/** A span that stays put when text is typed at either edge, and goes when its text is deleted. */
export function mapInner<T extends HostSpan>(item: T, changes: ChangeDesc): T | null {
  const from = changes.mapPos(item.from, 1);
  const to = changes.mapPos(item.to, -1);
  if (to < from || (to === from && item.to > item.from)) return null;
  return from === item.from && to === item.to ? item : { ...item, from, to };
}

function mapAll<T extends HostSpan>(items: readonly T[], changes: ChangeDesc, map: MapSpan<T>): T[] {
  const out: T[] = [];
  for (const item of items) {
    const moved = map(item, changes);
    if (moved) out.push(moved);
  }
  return out;
}

/** The host's log version the state is synced to; -1 for a state without sync (a test's bare state). */
export function syncedVersion(state: EditorState): number {
  try {
    return getSyncedVersion(state);
  } catch {
    return -1;
  }
}

/** This panel's unsent changes, oldest first: they turn the host's text at the synced version into the panel's. */
export function unsent(state: EditorState): readonly { changes: ChangeDesc }[] {
  try {
    return sendableUpdates(state);
  } catch {
    return [];
  }
}

/** A set of items as the host sent it. */
interface HostSet<T extends HostSpan> {
  version: number;
  items: readonly T[];
}

/**
 * Where items given in the host's text at `version` stand in `state`, or null when the state is
 * not synced to that version. A state without sync takes them as they are.
 */
function placeAt<T extends HostSpan>(state: EditorState, set: HostSet<T>, map: MapSpan<T>): readonly T[] | null {
  const synced = syncedVersion(state);
  if (synced !== -1 && synced !== set.version) return null;
  let items: readonly T[] = set.items;
  for (const u of unsent(state)) items = mapAll(items, u.changes, map);
  return items;
}

/**
 * A held set, in a transaction that applies updates from the host: placed when the transaction
 * reaches its version, 'wait' when it does not yet, 'drop' when it went past it (nothing can
 * carry the items over the updates it did not see).
 */
function placeHeld<T extends HostSpan>(
  tr: Transaction,
  set: HostSet<T>,
  map: MapSpan<T>,
): readonly T[] | 'wait' | 'drop' {
  const updates = tr.annotation(receivedUpdates);
  if (!updates) return 'wait';
  const before = syncedVersion(tr.startState);
  const after = syncedVersion(tr.state);
  if (set.version > after) return 'wait';
  if (set.version < before) return 'drop';
  let items: readonly T[] = set.items;
  for (let i = set.version - before; i < updates.length; i++) items = mapAll(items, updates[i]!.changes, map);
  for (const u of unsent(tr.state)) items = mapAll(items, u.changes, map);
  return items;
}

interface Held<T extends HostSpan> {
  items: readonly T[];
  /** A set for a version the panel had not reached when it came. */
  waiting: HostSet<T> | null;
}

/**
 * A state field of the items the host last sent, and the effect that hands it a new set. The
 * items move with every change; a new set replaces them once it can be placed, which can be
 * in a transaction that changes no text (one that only confirms this panel's own changes), so
 * a drawing of them follows the field itself.
 */
export function hostRangeField<T extends HostSpan>(
  map: MapSpan<T>,
): { field: StateField<Held<T>>; set: StateEffectType<HostSet<T>> } {
  const set = StateEffect.define<HostSet<T>>();
  const field = StateField.define<Held<T>>({
    create: () => ({ items: [], waiting: null }),
    update(value, tr) {
      let { items, waiting } = value;
      if (tr.docChanged && items.length > 0) items = mapAll(items, tr.changes, map);
      if (waiting) {
        const placed = placeHeld(tr, waiting, map);
        if (placed === 'drop') waiting = null;
        else if (placed !== 'wait') {
          items = placed;
          waiting = null;
        }
      }
      for (const e of tr.effects) {
        if (!e.is(set)) continue;
        const placed = placeAt(tr.state, e.value, map);
        if (placed) {
          items = placed;
          waiting = null;
        } else if (e.value.version > syncedVersion(tr.state)) {
          waiting = e.value;
        }
      }
      return items === value.items && waiting === value.waiting ? value : { items, waiting };
    },
  });
  return { field, set };
}

/**
 * Hands `set` every host message of `type`: its `version`, and the items `read` takes from its
 * field `key`. A message without a whole version is passed over.
 */
export function listenForHostSet<T extends HostSpan>(
  type: string,
  key: string,
  read: (value: unknown) => T[],
  set: StateEffectType<HostSet<T>>,
): Extension {
  return ViewPlugin.define((view) => {
    const stop = view.state.facet(panelContext)?.bridge.onMessage((message) => {
      if (message.type !== type) return;
      const m = message as unknown as Record<string, unknown>;
      if (!Number.isInteger(m.version)) return;
      view.dispatch({ effects: set.of({ version: m.version as number, items: read(m[key]) }) });
    });
    return { destroy: () => stop?.() };
  });
}
