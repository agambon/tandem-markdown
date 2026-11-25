// The session log. What it logs is what every panel shows and what every push is checked
// against.
import { collab, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { ChangeSet, EditorState, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { applyChanges } from '../../src/core/diff';
import { stampOf } from '../../src/core/hash';
import { textOf } from '../../src/core/positions';
import { LOG_LIMIT, SyncSession } from '../../src/core/session';

const forty = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the document`).join('\n');

function sizes(cs: ChangeSet): number[] {
  const out: number[] = [];
  cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => out.push(toA - fromA + inserted.length));
  return out;
}

describe('acceptForeign', () => {
  it('logs nothing when the text did not change (a line-ending flip)', () => {
    const s = new SyncSession(forty);
    expect(s.acceptForeign(forty, [{ from: 0, to: forty.length, insert: forty }])).toBeNull();
    expect(s.version).toBe(0);
  });

  it('turns a whole-document replacement that differs in two places into two small changes', () => {
    const s = new SyncSession(forty);
    const next = forty.replace('line 5 of', 'LINE FIVE of').replace('line 35 of', 'LINE THIRTY-FIVE of');
    const r = s.acceptForeign(next, [{ from: 0, to: forty.length, insert: next }], 'outside')!;
    expect(s.text).toBe(next);
    expect(r.entry.reason).toBe('outside');
    expect(r.anomaly).toBeUndefined();
    const parts = sizes(r.entry.changes);
    expect(parts.length).toBe(2);
    for (const n of parts) expect(n).toBeLessThan(30);
  });

  it('keeps unsent typing on its own line when a reload of lines 5 to 35 arrives', () => {
    const s = new SyncSession(forty);
    let panel = EditorState.create({ doc: forty, extensions: [collab({ startVersion: 0, clientID: 'p' })] });
    const at = panel.doc.line(20).to;
    panel = panel.update({ changes: { from: at, insert: ' WOR' } }).state;
    const from = panel.doc.line(5).from;
    const to = textOf(forty).line(35).to;
    const next = forty.replace('line 5 of', 'LINE FIVE of').replace('line 35 of', 'LINE THIRTY-FIVE of');
    const coarse = next.slice(from, next.length - (forty.length - to));
    const r = s.acceptForeign(next, [{ from, to, insert: coarse }])!;
    panel = receiveUpdates(panel, [{ changes: r.entry.changes, clientID: '@host' }]).state;
    const text = panel.doc.toString();
    expect(panel.doc.lineAt(text.indexOf(' WOR')).number).toBe(20);
    expect(sendableUpdates(panel).length).toBe(1);
  });

  it('rebuilds the change from the texts when the event does not reproduce them, and says so', () => {
    const s = new SyncSession('abc\ndef\n');
    const r = s.acceptForeign('abX\ndef\n', [{ from: 0, to: 1, insert: 'z' }])!;
    expect(r.anomaly).toBeDefined();
    expect(s.text).toBe('abX\ndef\n');
    expect(r.entry.changes.apply(Text.of(['abc', 'def', ''])).toString()).toBe('abX\ndef\n');
  });

  it('places an outside insertion at a word boundary, not after a shared first letter', () => {
    const s = new SyncSession('the fox jumps over\n');
    const r = s.acceptForeign('the fox jacket jumps over\n', null)!;
    const changes: { from: number; insert: string }[] = [];
    r.entry.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) =>
      changes.push({ from: fromA, insert: inserted.toString() }),
    );
    expect(changes).toEqual([{ from: 8, insert: 'jacket ' }]);
  });
});

describe('preparePush and commitPush', () => {
  const base = 'hello world\n';
  const update = (spec: { from: number; to?: number; insert?: string }, length: number) =>
    ChangeSet.of(spec, length).toJSON();

  it('refuses a push made on another version as stale, and one ahead of the log as invalid', () => {
    const s = new SyncSession(base);
    s.acceptForeign('hello world!\n', null);
    const u = [update({ from: 0, insert: 'x' }, base.length)];
    expect(s.preparePush('p', 0, u, stampOf('xhello world\n'))).toMatchObject({ ok: false, reason: 'stale' });
    expect(s.preparePush('p', 5, u, stampOf('x'))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses updates that are not change sets, or do not fit the text', () => {
    const s = new SyncSession(base);
    expect(s.preparePush('p', 0, [[-3, 4]], stampOf(base))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(s.preparePush('p', 0, ['nope'], stampOf(base))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(s.preparePush('p', 0, [update({ from: 0, insert: 'x' }, base.length + 1)], stampOf(base))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(s.preparePush('p', 0, [], stampOf(base))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it("refuses a push whose result is not the panel's text as diverged", () => {
    const s = new SyncSession(base);
    const u = [update({ from: 0, insert: 'x' }, base.length)];
    expect(s.preparePush('p', 0, u, stampOf('yhello world\n'))).toMatchObject({ ok: false, reason: 'diverged' });
  });

  it('composes the updates into ascending changes and marks a push that changes nothing', () => {
    const s = new SyncSession(base);
    const u1 = ChangeSet.of({ from: 5, insert: ',' }, base.length);
    const u2 = ChangeSet.of({ from: 0, to: 1, insert: 'H' }, u1.newLength);
    const prep = s.preparePush('p', 0, [u1.toJSON(), u2.toJSON()], stampOf('Hello, world\n'));
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.noop).toBe(false);
    expect(applyChanges(base, prep.changes)).toBe('Hello, world\n');
    const entries = s.commitPush(prep);
    expect(entries.map((e) => e.clientId)).toEqual(['p', 'p']);
    expect(s.version).toBe(2);
    expect(s.text).toBe('Hello, world\n');

    const ins = ChangeSet.of({ from: 3, insert: 'x' }, s.text.length);
    const del = ChangeSet.of({ from: 3, to: 4 }, ins.newLength);
    const noop = s.preparePush('p', 2, [ins.toJSON(), del.toJSON()], stampOf(s.text));
    expect(noop).toMatchObject({ ok: true, noop: true });
  });

  it('commitPush refuses a push prepared on an older version', () => {
    const s = new SyncSession(base);
    const prep = s.preparePush('p', 0, [update({ from: 0, insert: 'x' }, base.length)], stampOf('x' + base));
    s.acceptForeign('other\n', null);
    expect(() => prep.ok && s.commitPush(prep)).toThrow();
  });
});

describe('the log', () => {
  it('serves updates since a version, and nothing once the log no longer reaches back', () => {
    const s = new SyncSession('');
    for (let i = 0; i < LOG_LIMIT + 10; i++) s.acceptForeign(s.text + 'x', null);
    expect(s.version).toBe(LOG_LIMIT + 10);
    expect(s.updatesSince(5)).toBeNull();
    expect(s.updatesSince(s.version - 3)!.length).toBe(3);
    expect(s.updatesSince(s.version)!.length).toBe(0);
    expect(s.updatesSince(s.version + 1)).toBeNull();
  });

  it('reseed keeps the version and empties the log', () => {
    const s = new SyncSession('a');
    s.acceptForeign('ab', null);
    s.reseed('zzz');
    expect(s.text).toBe('zzz');
    expect(s.version).toBe(1);
    expect(s.updatesSince(0)).toBeNull();
    expect(s.updatesSince(1)).toEqual([]);
  });
});
