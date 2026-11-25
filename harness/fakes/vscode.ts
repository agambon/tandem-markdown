// Fake answers for VS Code's own features on the harness page, given the way the host gives
// them inside VS Code: `prepareRename` and `rename` for a heading's text, `completions` for the
// files of the made-up workspace (fakes/workspace.ts), `codeActions` and `applyCodeAction` for the
// problems published here. Like the host, each request first has the panel send what is unsent
// and is answered `stale` when the document is not the text the panel asked about. A spec
// publishes problems and change marks through `window.__vscodeFakes`; they reach the panel in
// the host's text at its log version, as src/host/diagnostics.ts and changeMarks.ts send them.
// VS Code's edits are applied to the document as Source's are.

import type { DiagnosticItem, SuggestionItem } from '../../src/core/featureProtocol';
import { isStamp, sameStamp, stampOf } from '../../src/core/hash';
import { textOf } from '../../src/core/positions';
import { lineChanges } from '../../src/host/model/lineChanges';
import { FakeHost, type MessageHandler } from '../fakeHost';
import { WORKSPACE } from './workspace';

/** A problem as a spec publishes it: offsets in the document's text, and the fix it offers. */
interface Published extends DiagnosticItem {
  fix?: { title: string; insert: string };
}

/** What the fakes were asked, newest last, for the specs to read. */
const requests: { type: string; [field: string]: unknown }[] = [];
let published: Published[] = [];
let listed = new Map<string, { from: number; to: number; insert: string; text: string }>();
let fixCount = 0;

/** The current page's host: a new FakeHost is made for every file the harness opens. */
function currentHost(): FakeHost {
  return (window.__harness as { host: FakeHost }).host;
}

/** The panel has sent what is unsent, and the document is the text whose stamp the panel sent. */
async function sameText(host: FakeHost, expect: unknown): Promise<boolean> {
  await host.coordinator.flushPanels();
  return isStamp(expect) && sameStamp(stampOf(host.documentText()), expect);
}

function post(host: FakeHost): void {
  const { version } = host.coordinator.inspect();
  host.post({ type: 'diagnostics', version, items: published.map(({ fix: _fix, ...item }) => item) });
}

/** A heading's text, and where it stands in the document. */
interface Heading {
  from: number;
  to: number;
  text: string;
}

/** The text of the heading on the line holding `at`, or null when that line is no heading. */
function headingAt(text: string, at: number): Heading | null {
  const line = textOf(text).lineAt(at);
  const m = /^(#{1,6}[ \t]+)(.*?)[ \t]*$/.exec(line.text);
  if (!m || !m[2]) return null;
  const from = line.from + m[1]!.length;
  return { from, to: from + m[2].length, text: m[2] };
}

/** The entries of `notes/<folder>` in the made-up workspace: folders (ending in `/`), then files. */
function entriesOf(folder: string): string[] {
  const under = `notes/${folder}`;
  const names = new Set<string>();
  for (const path of WORKSPACE) {
    if (!path.startsWith(under)) continue;
    const rest = path.slice(under.length);
    const slash = rest.indexOf('/');
    names.add(slash < 0 ? rest : rest.slice(0, slash + 1));
  }
  const folders = [...names].filter((name) => name.endsWith('/'));
  return [...folders, ...[...names].filter((name) => !name.endsWith('/'))];
}

/**
 * A handler for a rename request, `prepareRename` or `rename`, whose `answer` is given the
 * heading on the line the request names: a stale request is answered `stale`, and one on a line
 * that holds no heading is refused.
 */
function renaming(
  answer: (m: Parameters<MessageHandler>[0], host: FakeHost, heading: Heading) => unknown,
): MessageHandler {
  return async (m, host) => {
    requests.push({ ...m });
    if (!(await sameText(host, m.expect))) return { stale: true };
    const heading = headingAt(host.documentText(), Number(m.at));
    if (!heading) return { refused: 'Renaming is not supported here. Try renaming a header or link.' };
    return answer(m, host, heading);
  };
}

const handlers: Record<string, MessageHandler> = {
  prepareRename: renaming((_m, _host, heading) => ({ from: heading.from, to: heading.to, placeholder: heading.text })),
  rename: renaming((m, host, heading) => {
    host.sourceEdit({ from: heading.from, to: heading.to, insert: String(m.newName) });
    return { done: true };
  }),
  completions: async (m, host) => {
    requests.push({ ...m });
    if (!(await sameText(host, m.expect))) return { stale: true };
    const text = host.documentText();
    const at = Number(m.at);
    const line = textOf(text).lineAt(at);
    const before = line.text.slice(0, at - line.from);
    const typed = /\]\((?:\.\/)?([^\s()]*)$/.exec(before)?.[1];
    if (typed === undefined) return { from: at, items: [] };
    const slash = typed.lastIndexOf('/');
    const folder = typed.slice(0, slash + 1);
    const items: SuggestionItem[] = entriesOf(folder).map((name) => ({
      label: name,
      filter: name,
      detail: name.endsWith('/') ? 'Folder' : 'File',
      insert: name,
      cursor: name.length,
      again: name.endsWith('/'),
    }));
    return { from: at - (typed.length - slash - 1), items };
  },
  codeActions: async (m, host) => {
    requests.push({ ...m });
    if (!(await sameText(host, m.expect))) return { stale: true };
    const from = Number(m.from);
    const to = Number(m.to);
    const text = host.documentText();
    listed = new Map();
    const fixes = published
      .filter((p) => p.fix && p.from <= to && p.to >= from)
      .map((p) => {
        const id = String(++fixCount);
        listed.set(id, { from: p.from, to: p.to, insert: p.fix!.insert, text });
        return { id, title: p.fix!.title, preferred: true };
      });
    return { fixes };
  },
  applyCodeAction: (m, host) => {
    requests.push({ ...m });
    const fix = listed.get(String(m.id));
    if (!fix) return { refused: 'That quick fix is out of date, so it was not applied.' };
    listed = new Map();
    if (host.documentText() !== fix.text) return { refused: 'That quick fix is out of date, so it was not applied.' };
    host.sourceEdit({ from: fix.from, to: fix.to, insert: fix.insert });
    // A spell checker checks the text again and finds nothing there now.
    const delta = fix.insert.length - (fix.to - fix.from);
    published = published
      .filter((p) => !(p.from === fix.from && p.to === fix.to))
      .map((p) => (p.from >= fix.to ? { ...p, from: p.from + delta, to: p.to + delta } : p));
    setTimeout(() => post(host), 0);
    return { done: true };
  },
};

for (const [type, handler] of Object.entries(handlers)) FakeHost.defaultHandlers.set(type, handler);

declare global {
  interface Window {
    __vscodeFakes: unknown;
  }
}

window.__vscodeFakes = {
  requests,
  /** Publishes problems at offsets of the document's current text; an empty list takes them all away. */
  publish(items: (Pick<Published, 'from' | 'to' | 'severity' | 'message'> & Partial<Published>)[]) {
    published = items.map((p) => ({ source: '', code: '', unnecessary: false, deprecated: false, ...p }));
    post(currentHost());
  },
  /** Sends the change marks of the document against `committed`, the file's text at the last commit. */
  marks(committed: string) {
    const host = currentHost();
    const { version, text } = host.coordinator.inspect();
    host.post({ type: 'changeMarks', version, marks: lineChanges(committed, textOf(text)) });
  },
};
