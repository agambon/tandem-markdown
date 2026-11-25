// Unsent typing goes to the host at once whenever the user is about to act outside the page,
// and otherwise waits for the pause that makes undo go by word. PanelReports runs here against
// stand-ins for the page's window, document and root, over a real PanelSync whose clock never
// moves, so no push can come from a timer.
import { ChangeSet, EditorState, Text, type Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import type { PanelToHost } from '../../src/core/protocol';
import { PanelReports } from '../../src/panel/reports';
import { PanelSync, type SyncTarget } from '../../src/panel/sync';
import { FakeClock } from '../sync/fakes/clock';

class Target implements SyncTarget {
  composing = false;
  hasFocus = true;
  constructor(public state: EditorState) {}
  dispatch(tr: Transaction): void {
    this.state = tr.state;
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  readonly activeElement = null;
  constructor(readonly defaultView: EventTarget) {
    super();
  }
  hasFocus(): boolean {
    return false;
  }
}

const TEXT = 'one two';
const opened: PanelReports[] = [];

afterEach(() => {
  for (const reports of opened.splice(0)) reports.dispose();
});

/** A panel over TEXT with its reports listening on stand-ins for the page, and what it posts. */
function panel() {
  const posted: PanelToHost[] = [];
  const sync = new PanelSync({ post: (message) => posted.push(message), schedule: new FakeClock() });
  const target = new Target(
    EditorState.create({ doc: TEXT, extensions: [sync.start({ clientId: 'c1', version: 0 })] }),
  );
  sync.bind(target);
  const win = new EventTarget();
  const doc = new FakeDocument(win);
  const root = Object.assign(new EventTarget(), { ownerDocument: doc });
  // What viewStateOf reads of an EditorView.
  const view = {
    get state() {
      return target.state;
    },
    scrollDOM: { scrollTop: 0 },
    documentPadding: { top: 0 },
    lineBlockAtHeight: () => ({ from: 0, top: 0 }),
  } as unknown as EditorView;
  const reports = new PanelReports({
    root: root as unknown as HTMLElement,
    post: (message) => posted.push(message),
    view: () => view,
    stopped: () => false,
    flush: () => void sync.flush(),
    log: () => {},
  });
  reports.listen((on, type, fn, options) => on.addEventListener(type, fn, options));
  opened.push(reports);
  return {
    win,
    doc,
    root,
    /** The user types one character at the end: plain typing, which waits for the pause. */
    type(ch: string) {
      const end = target.state.doc.length;
      target.dispatch(target.state.update({ changes: { from: end, insert: ch }, userEvent: 'input.type' }));
    },
    /** An input method composes `text` at the end, and its composition stays open. */
    compose(text: string) {
      target.composing = true;
      const end = target.state.doc.length;
      target.dispatch(target.state.update({ changes: { from: end, insert: text }, userEvent: 'input.type.compose' }));
    },
    /** The host's text once every push so far is applied. */
    pushedText(): string {
      let text = Text.of(TEXT.split('\n'));
      for (const m of posted)
        if (m.type === 'push') for (const u of m.updates) text = ChangeSet.fromJSON(u).apply(text);
      return text.toString();
    },
  };
}

function key(init: { key: string; code: string; ctrlKey?: boolean; shiftKey?: boolean }): Event {
  return Object.assign(new Event('keydown'), {
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...init,
    getModifierState: () => false,
  });
}

const triggers: [string, (p: ReturnType<typeof panel>) => void][] = [
  ['the pointer leaves the panel', (p) => p.root.dispatchEvent(new Event('pointerleave'))],
  ['the window loses focus', (p) => p.win.dispatchEvent(new Event('blur'))],
  [
    'the page is hidden',
    (p) => {
      p.doc.visibilityState = 'hidden';
      p.doc.dispatchEvent(new Event('visibilitychange'));
    },
  ],
  ['the page is unloaded', (p) => p.win.dispatchEvent(new Event('pagehide'))],
  ['a command chord is pressed', (p) => p.win.dispatchEvent(key({ key: 'w', code: 'KeyW', ctrlKey: true }))],
];

describe('typing not yet sent', () => {
  for (const [when, trigger] of triggers) {
    it(`is pushed at once when ${when}`, () => {
      const p = panel();
      p.type('s');
      expect(p.pushedText()).toBe(TEXT);
      trigger(p);
      expect(p.pushedText()).toBe(`${TEXT}s`);
    });

    it(`is pushed at once when ${when}, with an input method's open composition`, () => {
      const p = panel();
      p.type('s');
      p.compose('ka');
      expect(p.pushedText()).toBe(TEXT);
      trigger(p);
      expect(p.pushedText()).toBe(`${TEXT}ska`);
    });
  }

  it('waits for the pause through keys without a command modifier', () => {
    const p = panel();
    p.type('s');
    p.win.dispatchEvent(key({ key: 'S', code: 'KeyS', shiftKey: true }));
    p.win.dispatchEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    expect(p.pushedText()).toBe(TEXT);
  });
});
