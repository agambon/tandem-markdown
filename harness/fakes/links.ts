// Fake answers for links, wikilinks and images on the harness page, so the page draws them as
// it would inside VS Code: `resolveLinks`, `listLinkTargets`, `openLink`, `resolveImages`,
// `pickImage` and `saveImage`.
//
// The note being edited is taken to be `notes/<sample name>` in the made-up workspace
// (harness/fakes/workspace.ts), so wikilinks and pictures follow the host's rules. Opening is
// recorded in `window.__linkFakes.opened` and nothing is opened, except `#heading` links, which
// scroll the panel as the host makes them do. The handlers are in `FakeHost.defaultHandlers`,
// so the new FakeHost the harness makes for every file it opens answers them all.

import { buildOutline } from '../../src/core/outline';
import { findHeading } from '../../src/host/model/headingAnchors';
import { FakeHost, type MessageHandler } from '../fakeHost';
import { imageAnswers, index, linkAnswers, WORKSPACE } from './workspace';

interface Opened {
  kind: unknown;
  href: unknown;
  mode: unknown;
}

const opened: Opened[] = [];

declare global {
  interface Window {
    __linkFakes: unknown;
  }
}

window.__linkFakes = { opened, workspace: WORKSPACE, index };

/** The note a request is about: the embedded note it names, or the note being edited. */
function notePath(host: FakeHost, note?: unknown): string {
  return typeof note === 'string' ? note : `notes/${host.fileName}`;
}

function revealHeading(host: FakeHost, fragment: string): void {
  const headings = buildOutline(host.documentText());
  const i = findHeading(
    headings.map((h) => h.text),
    fragment,
  );
  if (i >= 0) host.post({ type: 'command', id: 'revealHeading', args: { from: headings[i]!.from } });
  else host.post({ type: 'notice', kind: 'warning', text: `No heading "${fragment}" in ${host.fileName}.` });
}

const handlers: Record<string, MessageHandler> = {
  resolveLinks: (m, host) => linkAnswers(m.targets, notePath(host, m.note)),
  listLinkTargets: (m, host) => ({ items: index.targets(typeof m.query === 'string' ? m.query : '', notePath(host)) }),
  resolveImages: (m, host) =>
    imageAnswers(m.sources, notePath(host, m.note), (url) =>
      host.settings.imagesAllowRemote ? { uri: url } : { reason: 'Remote images are off' },
    ),
  openLink: (m, host) => {
    opened.push({ kind: m.kind, href: m.href, mode: m.mode });
    // `#heading` (a link, or a wikilink with no target) scrolls this panel, as the host does.
    const href = typeof m.href === 'string' ? m.href : '';
    if (href.startsWith('#')) revealHeading(host, href.slice(1));
  },
  pickImage: () => ({ markdownPath: 'img/pic.png' }),
  saveImage: () => {
    const name = `img/pasted-${Date.now()}.png`;
    index.add(`notes/${name}`);
    return { markdownPath: name };
  },
};

for (const [type, handler] of Object.entries(handlers)) FakeHost.defaultHandlers.set(type, handler);
