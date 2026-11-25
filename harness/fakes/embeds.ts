// Fake answers for embedded notes on the harness page (harness/fakes/notes.ts), so the page
// draws them as it would inside VS Code. A note's text can be changed from a script with
// `window.__embedFakes.change(path, text)`, which tells the page `embedsChanged`, as the host
// does when a note it embeds changes.

import { FakeHost, type MessageHandler } from '../fakeHost';
import { changeNote, embedAnswers, NOTES } from './notes';

let lastHost: FakeHost | null = null;

declare global {
  interface Window {
    __embedFakes: unknown;
  }
}

window.__embedFakes = {
  notes: NOTES,
  /** Changes, adds (or with null, removes) a note, and tells the page as the host would. */
  change(path: string, text: string | null) {
    changeNote(path, text);
    lastHost?.post({ type: 'embedsChanged' });
  },
};

const embedNotes: MessageHandler = (m, host) => {
  lastHost = host;
  return embedAnswers(m.targets, typeof m.note === 'string' ? m.note : `notes/${host.fileName}`);
};

FakeHost.defaultHandlers.set('embedNotes', embedNotes);
