// Ranges the host gives in its own text at a log version, placed in a panel's text through
// PanelSync as a real panel receives updates: over its unsent typing, held until the panel
// reaches the version, and carried over every edit after.

import { ChangeSet, EditorState, Text, type Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { stampOf } from '../../src/core/hash';
import { hostRangeField, mapInner, type HostSpan } from '../../src/panel/hostRanges';
import { PanelSync } from '../../src/panel/sync';

interface Item extends HostSpan {
  name: string;
}

/** A panel over `text` with the field, a host log that sends it updates, and a record of what it posted. */
function world(text: string) {
  const posted: { type: string; updates?: unknown[] }[] = [];
  const sync = new PanelSync({
    post: (m) => posted.push(m as { type: string }),
    schedule: { setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 },
  });
  const ranges = hostRangeField<Item>(mapInner);
  const ext = sync.start({ clientId: 'panel', version: 0 });
  const target = {
    state: EditorState.create({ doc: text, extensions: [ext, ranges.field] }),
    /** For each transaction: whether it changed the text. */
    changed: [] as boolean[],
    dispatch(tr: Transaction) {
      this.changed.push(tr.docChanged);
      this.state = tr.state;
    },
  };
  sync.bind(target);
  let host = text;
  let version = 0;
  const hostUpdate = (from: number, to: number, insert: string, clientId = '@host') => {
    const cs = ChangeSet.of([{ from, to, insert }], host.length);
    host = cs.apply(Text.of(host.split('\n'))).toString();
    return { clientId, changes: cs.toJSON() };
  };
  return {
    get state() {
      return target.state;
    },
    get version() {
      return version;
    },
    target,
    hostUpdate,
    receive(...updates: ReturnType<typeof hostUpdate>[]) {
      sync.handle({
        type: 'updates',
        fromVersion: version,
        updates,
        version: version + updates.length,
        ...stampOf(host),
      });
      version += updates.length;
    },
    /** The host's copy of what the panel pushed: the panel's own updates, as the host logs them. */
    confirmOwn() {
      const push = [...posted].reverse().find((m) => m.type === 'push') as { updates: unknown[] } | undefined;
      if (!push) throw new Error('nothing was pushed');
      const updates = push.updates.map((changes) => {
        const cs = ChangeSet.fromJSON(changes);
        host = cs.apply(Text.of(host.split('\n'))).toString();
        return { clientId: 'panel', changes };
      });
      this.receive(...updates);
    },
    type(at: number, insert: string) {
      target.dispatch(target.state.update({ changes: { from: at, insert }, userEvent: 'input.type' }));
    },
    give(items: Item[], at = version) {
      target.dispatch(target.state.update({ effects: ranges.set.of({ version: at, items }) }));
    },
    /** Each item as the text it covers now. */
    covered(): string[] {
      return target.state.field(ranges.field).items.map((i) => `${i.name}:${target.state.sliceDoc(i.from, i.to)}`);
    },
    flushPush() {
      void sync.flush();
    },
  };
}

const TEXT = 'Alpha beta gamma.\nDelta epsilon.';
const span = (name: string, word: string, text = TEXT): Item => {
  const from = text.indexOf(word);
  return { name, from, to: from + word.length };
};

describe('ranges from the host in the panel', () => {
  it('stand on their text in a panel at their version', () => {
    const w = world(TEXT);
    w.give([span('a', 'beta'), span('b', 'epsilon')]);
    expect(w.covered()).toEqual(['a:beta', 'b:epsilon']);
  });

  it("are carried over the panel's unsent typing", () => {
    const w = world(TEXT);
    w.type(0, 'New words. ');
    w.give([span('a', 'beta'), span('b', 'epsilon')]);
    expect(w.covered()).toEqual(['a:beta', 'b:epsilon']);
  });

  it('move with every edit after they are placed, and go when their text is deleted', () => {
    const w = world(TEXT);
    w.give([span('a', 'beta'), span('b', 'epsilon')]);
    w.type(0, 'Up front. ');
    w.receive(w.hostUpdate(0, 0, 'Host. '));
    expect(w.covered()).toEqual(['a:beta', 'b:epsilon']);
    const at = w.state.doc.toString().indexOf('beta');
    w.target.dispatch(w.state.update({ changes: { from: at - 1, to: at + 5 } }));
    expect(w.covered()).toEqual(['b:epsilon']);
  });

  it('wait for the version they were given at, then land over the updates after it', () => {
    const w = world(TEXT);
    const u1 = w.hostUpdate(0, 0, 'One. ');
    const afterOne = `One. ${TEXT}`;
    const u2 = w.hostUpdate(0, 0, 'Two. ');
    // Given at version 1, while the panel is still at 0.
    w.give([span('a', 'gamma', afterOne)], 1);
    expect(w.covered()).toEqual([]);
    w.type(w.state.doc.length, ' Typed.');
    w.receive(u1, u2);
    expect(w.state.doc.toString()).toBe(`Two. One. ${TEXT} Typed.`);
    expect(w.covered()).toEqual(['a:gamma']);
  });

  it('are dropped when given at a version the panel has passed', () => {
    const w = world(TEXT);
    w.receive(w.hostUpdate(0, 0, 'One. '));
    w.give([span('a', 'beta')], 0);
    expect(w.covered()).toEqual([]);
  });

  it("land on an update that only confirms the panel's own typing, which changes no text", () => {
    const w = world(TEXT);
    w.type(0, 'Mine. ');
    w.flushPush();
    // The host logs the push as version 1 and sends ranges in that text before the panel hears back.
    w.give([span('a', 'beta', `Mine. ${TEXT}`)], 1);
    expect(w.covered()).toEqual([]);
    w.target.changed.length = 0;
    w.confirmOwn();
    expect(w.target.changed).toEqual([false]);
    expect(w.covered()).toEqual(['a:beta']);
  });
});
