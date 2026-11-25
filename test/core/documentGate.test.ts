// The gate decides which change event is the holder's edit landing and which are foreign.
// Each outcome, driven by hand.
import { describe, expect, it } from 'vitest';
import { type DocEvent, type DocumentEdit, DocumentGate, documentEditRanges } from '../../src/core/documentGate';
import { textOf } from '../../src/core/positions';

function setup(initial: string) {
  let text = initial;
  let session = initial;
  const calls: DocumentEdit[] = [];
  let answer: ((ok: boolean) => void) | null = null;
  const log: string[] = [];
  const gate = new DocumentGate({
    document: {
      getText: () => text,
      isDirty: () => true,
      applyEdit: (edit) => {
        calls.push(edit);
        return new Promise<boolean>((r) => (answer = r));
      },
    },
    sessionText: () => session,
    sessionDoc: () => textOf(session),
    foreign: (e) => {
      log.push(`foreign ${e.lf}`);
      session = e.lf;
    },
    extra: (e) => {
      log.push(`extra ${e.lf}`);
      session = e.lf;
    },
    mismatch: (lf) => log.push(`mismatch ${lf}`),
    log: () => {},
  });
  const event = (lf: string): DocEvent => {
    text = lf;
    return {
      lf,
      changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '' }],
      dirty: true,
    };
  };
  return {
    gate,
    calls,
    log,
    answer: (ok: boolean) => answer!(ok),
    event,
    setSession: (s: string) => (session = s),
    setText: (t: string) => (text = t),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('DocumentGate', () => {
  it('true with events: the first is the edit landing; the rest are foreign, in order', async () => {
    const t = setup('abc');
    let committed = false;
    const done = t.gate.run((h) =>
      h.apply([{ from: 3, to: 3, insert: 'd' }], 'abcd', () => {
        committed = true;
        t.setSession('abcd');
        t.log.push('commit');
      }),
    );
    await tick();
    t.gate.documentChanged(t.event('abcd'));
    t.gate.documentChanged(t.event('abcde'));
    expect(t.log).toEqual([]); // held while applyEdit is pending
    t.answer(true);
    const out = await done;
    expect(out).toEqual({ kind: 'applied', landedText: 'abcd' });
    expect(committed).toBe(true);
    expect(t.log).toEqual(['commit', 'foreign abcde']);
    expect(t.calls[0]!.before.toString()).toBe('abc');
  });

  // applyEdit resolved true, and the text after the edit is not the one expected.
  it('passes the difference on as an extra update when the edit lands changed', async () => {
    const t = setup('a \nb');
    const done = t.gate.run((h) => h.apply([{ from: 4, to: 4, insert: 'c' }], 'a \nbc', () => t.setSession('a \nbc')));
    await tick();
    t.gate.documentChanged(t.event('a\nbc')); // VS Code also trimmed the space
    t.answer(true);
    expect(await done).toEqual({ kind: 'applied', landedText: 'a\nbc' });
    expect(t.log).toEqual(['extra a\nbc']);
  });

  it('true with no event: commits only if the document holds the expected text', async () => {
    const t = setup('abc');
    let committed = 0;
    const first = t.gate.run((h) => h.apply([{ from: 0, to: 1, insert: 'a' }], 'abc', () => committed++));
    await tick();
    t.answer(true);
    expect(await first).toEqual({ kind: 'applied', landedText: 'abc' });
    const second = t.gate.run((h) => h.apply([{ from: 0, to: 1, insert: 'x' }], 'xbc', () => committed++));
    await tick();
    t.answer(true);
    expect(await second).toEqual({ kind: 'failed' });
    expect(committed).toBe(1);
  });

  it('false: every held event is foreign, and the outcome is stale if there was one, else failed', async () => {
    const t = setup('abc');
    const stale = t.gate.run((h) => h.apply([{ from: 0, to: 0, insert: 'x' }], 'xabc', () => t.log.push('commit')));
    await tick();
    t.gate.documentChanged(t.event('abcY'));
    t.answer(false);
    expect(await stale).toEqual({ kind: 'stale' });
    expect(t.log).toEqual(['foreign abcY']);
    const failed = t.gate.run((h) => h.apply([{ from: 0, to: 0, insert: 'x' }], 'xabcY', () => t.log.push('commit')));
    await tick();
    t.answer(false);
    expect(await failed).toEqual({ kind: 'failed' });
    expect(t.log).toEqual(['foreign abcY']);
  });

  it('applies nothing when the document and the session disagree', async () => {
    const t = setup('abc');
    t.setText('abX');
    const out = await t.gate.run((h) => h.apply([{ from: 0, to: 0, insert: 'x' }], 'xabc', () => t.log.push('commit')));
    expect(out).toEqual({ kind: 'mismatch' });
    expect(t.calls.length).toBe(0);
    expect(t.log).toEqual(['mismatch abX']);
  });

  // Outside a holder's edit, every change event is foreign at once.
  it('runs holders one at a time, first come first served', async () => {
    const t = setup('abc');
    const order: string[] = [];
    let release!: () => void;
    const a = t.gate.run(async () => {
      order.push('a start');
      await new Promise<void>((r) => (release = r));
      order.push('a end');
    });
    const b = t.gate.run(async () => {
      order.push('b');
    });
    await tick();
    t.gate.documentChanged(t.event('abcZ'));
    expect(t.log).toEqual(['foreign abcZ']);
    expect(order).toEqual(['a start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a start', 'a end', 'b']);
  });

  it('documentEditRanges gives VS Code positions from the LF text', () => {
    const ranges = documentEditRanges({ before: textOf('ab\ncd'), changes: [{ from: 1, to: 4, insert: 'X\nY' }] });
    expect(ranges).toEqual([{ start: { line: 0, character: 1 }, end: { line: 1, character: 1 }, text: 'X\nY' }]);
  });
});
