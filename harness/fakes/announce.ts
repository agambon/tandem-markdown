// A fake answer to which tab tells a screen reader of the changes from outside (`tellOutside`):
// the harness page has one rich tab, and it tells each change once, as src/host/announce.ts
// answers for a note open in one rich tab.

import { FakeHost, type MessageHandler } from '../fakeHost';

/** By host, the version up to which the page's tab has told the changes. */
const told = new WeakMap<FakeHost, number>();

const tellOutside: MessageHandler = (message, host) => {
  const upTo = typeof message.upTo === 'number' ? message.upTo : -1;
  const after = told.get(host) ?? -1;
  told.set(host, Math.max(after, upTo));
  return { after };
};

FakeHost.defaultHandlers.set('tellOutside', tellOutside);
