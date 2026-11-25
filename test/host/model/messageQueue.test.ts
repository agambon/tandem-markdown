// The order of the messages that ask the user something: one pop-up at a time, the others waiting,
// those with a strip in their note's strip, and the next popping up once the pop-up up is gone,
// pressed, closed or hidden by VS Code, even when its message settled elsewhere; a reply popping
// up at once; the offer of agent instructions only while nothing else is open, and as soon as
// nothing is; a message popped up again at the user's asking.

import { describe, expect, it } from 'vitest';
import { MessageQueue } from '../../../src/host/model/messageQueue';

const NOTE = 'file:///notes/Plans.md';
const OTHER = 'file:///notes/Field notes.md';

/** A message about `note`, with a strip unless said otherwise. */
const m = (id: string, note: string | null, more: { strip?: boolean; last?: boolean } = {}) => ({
  id,
  note,
  strip: more.strip ?? true,
  last: more.last ?? false,
});

describe('the message queue', () => {
  it('pops up one message at a time, and the next waiting one when that pop-up is gone', () => {
    const q = new MessageQueue();
    expect(q.add(m('a', NOTE))).toBe(true);
    expect(q.add(m('b', NOTE))).toBe(false);
    expect(q.add(m('c', OTHER, { strip: false }))).toBe(false);
    expect(q.popupGone('a')).toBe('b');
    expect(q.popupGone('b')).toBe('c');
    expect(q.popupGone('c')).toBe(null);
    expect([q.isOpen('a'), q.isOpen('b'), q.isOpen('c')]).toEqual([true, true, true]);
  });

  it('pops up a reply at once, whatever pop-up is up, and the next waiting one when the reply is gone', () => {
    const q = new MessageQueue();
    q.add(m('a', NOTE));
    q.add(m('b', OTHER));
    expect(q.add(m('reply', NOTE), true)).toBe(true);
    expect(q.upNow()).toBe('reply');
    expect(q.popupGone('a')).toBe(null);
    expect(q.popupGone('reply')).toBe('b');
  });

  it("keeps a message with a strip waiting until its turn in its note's strip, oldest first, counting those behind it", () => {
    const q = new MessageQueue();
    q.add(m('a', NOTE));
    q.add(m('quiet', NOTE, { strip: false }));
    q.add(m('b', NOTE));
    q.add(m('c', NOTE));
    expect(q.shownFor(NOTE)).toEqual({ id: 'a', more: 2 });
    expect(q.waitingCount()).toBe(3);
    q.settle('a');
    expect(q.shownFor(NOTE)).toEqual({ id: 'b', more: 1 });
    expect(q.waitingCount()).toBe(2);
    q.settle('b');
    expect(q.shownFor(NOTE)).toEqual({ id: 'c', more: 0 });
    q.settle('c');
    expect(q.shownFor(NOTE)).toBe(null);
    expect(q.waitingCount()).toBe(0);
  });

  it('holds the pop-up of a message settled elsewhere as up until it is gone, then pops up the next', () => {
    const q = new MessageQueue();
    q.add(m('a', NOTE));
    q.add(m('b', NOTE));
    expect(q.settle('a')).toBe(null);
    expect(q.hasPopped('b')).toBe(false);
    expect(q.add(m('c', OTHER))).toBe(false);
    expect(q.popupGone('a')).toBe('b');
    expect(q.popupGone('b')).toBe('c');
  });

  it('pops up the offer only while no other message is open, and as soon as none is', () => {
    const q = new MessageQueue();
    q.add(m('a', NOTE));
    expect(q.add(m('offer', null, { strip: false, last: true }))).toBe(false);
    q.add(m('b', NOTE));
    expect(q.popupGone('a')).toBe('b');
    expect(q.popupGone('b')).toBe(null);
    expect(q.settle('a')).toBe(null);
    expect(q.firstWithNote()?.id).toBe('b');
    expect(q.settle('b')).toBe('offer');
    const alone = new MessageQueue();
    expect(alone.add(m('offer', null, { strip: false, last: true }))).toBe(true);
  });

  it('pops a message up again at the asking, and the pop-up it took the place of changes nothing when gone', () => {
    const q = new MessageQueue();
    q.add(m('a', NOTE));
    q.add(m('b', OTHER));
    q.add(m('c', OTHER));
    q.popAgain('b');
    expect(q.upNow()).toBe('b');
    expect(q.popupGone('a')).toBe(null);
    expect(q.popupGone('b')).toBe('c');
  });

  it('names in the status bar only a message in a strip', () => {
    const q = new MessageQueue();
    q.add(m('window', null, { strip: false }));
    q.add(m('quiet', NOTE, { strip: false }));
    expect(q.firstWithNote()).toBe(null);
    q.add(m('a', NOTE));
    expect(q.firstWithNote()).toEqual({ id: 'a', note: NOTE });
    expect(q.hasNote(NOTE)).toBe(true);
    expect(q.hasNote(OTHER)).toBe(false);
  });
});
