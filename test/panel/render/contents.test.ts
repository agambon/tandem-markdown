// The headings a contents list is drawn from, and their emoji codes: read as typed before the
// emoji list has loaded and as emoji once it has, with no keystroke between. The watcher that
// reads them again runs against a stand-in view: it only reads the state and dispatches.
import type { EditorState } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelSettings } from '../../../src/core/protocol';
import { HeadingWatcher, headingsField } from '../../../src/panel/render/contents';
import { emojiNames } from '../../../src/panel/render/emoji';
import { fakeContext, standInView, stateOf, testSettings } from '../helpers';

const NOTE = '[TOC]\n\n## Launch :rocket:\n\n## Run `:rocket:`\n';

const texts = (state: EditorState) => state.field(headingsField)?.map((h) => h.text);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the contents list and emoji codes', () => {
  it('keeps codes as typed while the emoji setting is off, and never asks for the list', () => {
    vi.useFakeTimers();
    const load = vi.spyOn(emojiNames, 'load');
    const { ctx } = fakeContext({ settings: { syntax: { emoji: false } } });
    const view = standInView(stateOf(NOTE, { ctx }));
    const watcher = new HeadingWatcher(view);
    vi.runAllTimers();
    expect(texts(view.state)).toEqual(['Launch :rocket:', 'Run :rocket:']);
    expect(load).not.toHaveBeenCalled();
    watcher.destroy();
  });

  it('reads codes as typed before the list has loaded, then as emoji once it has, with no keystroke', async () => {
    expect(emojiNames.loaded()).toBeUndefined();
    const view = standInView(stateOf(NOTE));
    expect(texts(view.state)).toEqual(['Launch :rocket:', 'Run :rocket:']);
    const watcher = new HeadingWatcher(view);
    try {
      await vi.waitFor(() => expect(texts(view.state)).toEqual(['Launch 🚀', 'Run :rocket:']), { timeout: 5000 });
    } finally {
      watcher.destroy();
    }
  });

  it('reads codes as emoji at once in a file opened after the list has loaded', async () => {
    await emojiNames.load();
    expect(texts(stateOf(NOTE))).toEqual(['Launch 🚀', 'Run :rocket:']);
  });

  it('reads the headings again when the emoji setting is turned off', async () => {
    await emojiNames.load();
    vi.useFakeTimers();
    const { ctx } = fakeContext();
    const view = standInView(stateOf(NOTE, { ctx }));
    const watcher = new HeadingWatcher(view);
    vi.runAllTimers();
    expect(texts(view.state)).toEqual(['Launch 🚀', 'Run :rocket:']);
    (ctx as { settings: PanelSettings }).settings = { ...testSettings, syntax: { emoji: false } };
    const update = { docChanged: false, state: view.state, startState: view.state } as unknown as ViewUpdate;
    watcher.update(update);
    vi.runAllTimers();
    expect(texts(view.state)).toEqual(['Launch :rocket:', 'Run :rocket:']);
    watcher.destroy();
  });
});
