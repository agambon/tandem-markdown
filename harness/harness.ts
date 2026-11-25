// The two-sided harness page: on the left, VS Code's document and the file on disk; on the
// right, the real panel (bootPanel) talking to the real DocumentCoordinator that runs in this
// page (fakeHost.ts). Query string: ?sample=<file in samples/>, ?mode=view|edit,
// ?theme=dark|light|<a VS Code theme> (theme.ts), ?init=protocol|fields (a malformed first init: another protocol, no text).
//
// Keys in the panel work as VS Code's keybindings would: Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z run the
// document's undo and redo through the host (a field's own undo while one has focus), Ctrl+S
// sends unsent typing and saves, and the formatting keys and Alt+Enter run the panel's commands
// through the host's `command` message. In the document box they are Source's own keys.
//
// The specs drive the page through `window.__harness`, set at the end of this file.

import { getSyncedVersion, sendableUpdates } from '@codemirror/collab';
import { ChangeSet } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { diffChanges } from '../src/core/diff';
import { errorMessage } from '../src/core/errors';
import type { PanelTestState } from '../src/core/featureProtocol';
import { sameStamp, stampOf } from '../src/core/hash';
import type { Mode } from '../src/core/protocol';
import { summarizeNotice } from '../src/host/model/messageForms';
import { bootPanel, type PanelHandle } from '../src/panel/boot';
import { runCommand } from '../src/panel/commands/registry';
import { corruption } from '../src/panel/corruption';
import { getMode } from '../src/panel/modes';
import { countKinds } from '../src/panel/syntax/kinds';
import { Rng, markersIn, safePositions } from '../test/sync/world';
import { barSelect } from './barSelect';
import { FakeHost } from './fakeHost';
import './fakes/announce';
import './fakes/embeds';
import './fakes/links';
import './fakes/vscode';
import { fetchSample, listSamples } from './sampleList';
import { themeSelect } from './theme';

const params = new URLSearchParams(location.search);

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The harness page has no #${id}`);
  return found as T;
}

const panelRoot = element<HTMLElement>('tm-root');
const documentBox = element<HTMLTextAreaElement>('hx-document');
const diskBox = element<HTMLTextAreaElement>('hx-disk');
const diskHint = element<HTMLElement>('hx-disk-hint');
const statusLine = element<HTMLElement>('hx-status');
const noticeList = element<HTMLUListElement>('hx-notices');
const autoSaveBox = element<HTMLInputElement>('hx-autosave');

let host!: FakeHost;
let panel!: PanelHandle;

/** The panel's editor, found where CodeMirror keeps it; null before the first init is drawn and after a failure. */
function panelView(): EditorView | null {
  const dom = panelRoot.querySelector<HTMLElement>('.tm-editor > .cm-editor');
  return dom ? EditorView.findFromDOM(dom) : null;
}

/** Whether the panel's failure page is showing. */
const panelFailed = (): boolean => panelRoot.querySelector('.tm-failed') !== null;
let unwire: (() => void)[] = [];
let diskDraft = false;
let storming: { done: number; total: number; seed: number } | null = null;
let lastStorm: StormReport | null = null;
let initFault =
  params.get('init') === 'protocol' || params.get('init') === 'fields'
    ? (params.get('init') as 'protocol' | 'fields')
    : null;

// ---------------------------------------------------------------------------
// Opening a document

function bootInto(): void {
  panel = bootPanel(host.connect(), panelRoot);
}

/** Opens `text` as a fresh file: a new document, disk and coordinator, and a new panel. */
function open(text: string, fileName = 'sample.md'): Promise<void> {
  for (const undo of unwire.splice(0)) undo();
  panel?.dispose();
  host?.dispose();
  host = new FakeHost({ text, fileName, mode: modeSelect.value as Mode, initFault });
  initFault = null;
  host.autoSave = autoSaveBox.checked;
  diskDraft = false;
  unwire.push(
    host.onChange(() => {
      followMode();
      scheduleRefresh();
    }),
    host.onDocumentChange(() => showDocument()),
    host.onDiskChange(() => showDisk()),
    host.onPanelReload(() => {
      panel.dispose();
      bootInto();
      scheduleRefresh();
    }),
  );
  showDocument(true);
  showDisk(true);
  bootInto();
  scheduleRefresh();
  return host.until(
    () => panelFailed() || (panelView() !== null && host.panelId !== null),
    10_000,
    'the panel did not start',
  );
}

async function loadSample(name: string): Promise<void> {
  await open(await fetchSample(name), name);
}

// ---------------------------------------------------------------------------
// The document and the file

/** Puts VS Code's in-memory text in the document box, keeping the caret where it was in the text. */
function showDocument(force = false): void {
  const next = host.documentText();
  const shown = documentBox.value;
  if (!force && shown === next) return;
  if (document.activeElement === documentBox && !force) {
    const changes = ChangeSet.of(diffChanges(shown, next), shown.length);
    const start = changes.mapPos(documentBox.selectionStart, 1);
    const end = changes.mapPos(documentBox.selectionEnd, 1);
    documentBox.value = next;
    documentBox.setSelectionRange(start, end);
  } else {
    documentBox.value = next;
  }
}

function showDisk(force = false): void {
  if (diskDraft && !force) return;
  diskBox.value = host.diskText() ?? '';
  diskDraft = false;
  diskHint.textContent = '';
}

documentBox.addEventListener('input', () => host.setSourceText(documentBox.value));
// The document box stands for Source: while it has focus, it is VS Code's active text editor.
documentBox.addEventListener('focus', () => {
  if (host) host.sourceActive = true;
});
documentBox.addEventListener('blur', () => {
  if (host) host.sourceActive = false;
});
documentBox.addEventListener('beforeinput', (event) => {
  // Source's undo is VS Code's, on the document; the box's own history must not run.
  if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
    event.preventDefault();
    host.sourceHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo');
  }
});
documentBox.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey) return;
  if (event.code === 'KeyZ' || event.code === 'KeyY') {
    event.preventDefault();
    host.sourceHistory(event.code === 'KeyY' || event.shiftKey ? 'redo' : 'undo');
  } else if (event.code === 'KeyS') {
    event.preventDefault();
    void host.sourceSave().catch(report);
  }
});

diskBox.addEventListener('input', () => {
  diskDraft = true;
  diskHint.textContent = 'Not written yet.';
});
element('hx-write').addEventListener('click', () => {
  diskDraft = false;
  diskHint.textContent = '';
  host.writeOutside(diskBox.value);
});
element('hx-flip').addEventListener('click', () => host.flipLineEndings());
element('hx-save').addEventListener('click', () => void host.save().catch(report));
autoSaveBox.addEventListener('change', () => {
  host.autoSave = autoSaveBox.checked;
});
element('hx-undo').addEventListener('click', () => void host.history('undo').catch(report));
element('hx-redo').addEventListener('click', () => void host.history('redo').catch(report));
window.addEventListener('focus', () => host?.windowFocused());

function report(error: unknown): void {
  console.error(error);
  host.hostMessages.push(errorMessage(error));
  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// VS Code's keybindings for the panel

const formattingKeys: Record<string, string> = {
  'ctrl+KeyB': 'toggleBold',
  'ctrl+KeyI': 'toggleItalic',
  'alt+KeyS': 'toggleStrikethrough',
  'alt+KeyK': 'insertLink',
  'alt+KeyC': 'toggleTask',
  'ctrl+shift+BracketRight': 'headingUp',
  'ctrl+shift+BracketLeft': 'headingDown',
  F2: 'rename',
  'ctrl+Period': 'quickFix',
};
const findKeys: Record<string, string> = { 'ctrl+KeyF': 'find', 'ctrl+KeyH': 'replace' };
/** Keys for both views (outside a text field): Open Link. */
const bothViewKeys: Record<string, string> = { 'alt+Enter': 'openLink' };

// On the window, bubbling, where VS Code's webview listens for keys: the panel's own key
// handlers see a key first, as they do inside VS Code, so a panel binding that collides with
// one of these keys shows here. Like VS Code, this does not ask whether the panel already
// handled the key; it only cancels the browser's own action for the keys it takes. The keys
// need `tandemMarkdown.editorFocus`, which the panel reports while focus is anywhere in it, its
// toolbar and notices included; here, a key from inside the panel's root.
window.addEventListener('keydown', (event) => {
  const v = panelView();
  const focus = host.lastFocus;
  if (!v || !panelRoot.contains(event.target as Node) || event.metaKey) return;
  const key = `${event.ctrlKey ? 'ctrl+' : ''}${event.shiftKey ? 'shift+' : ''}${event.altKey ? 'alt+' : ''}${event.code}`;
  const field = !!focus?.field;
  let handled = true;
  if (key === 'ctrl+KeyZ' || key === 'ctrl+KeyY' || key === 'ctrl+shift+KeyZ') {
    const redo = key !== 'ctrl+KeyZ';
    if (field) host.post({ type: 'command', id: redo ? 'fieldRedo' : 'fieldUndo' });
    else void host.history(redo ? 'redo' : 'undo').catch(report);
  } else if (key === 'ctrl+KeyS') {
    void host.save().catch(report);
  } else if (findKeys[key]) {
    host.post({ type: 'command', id: findKeys[key]! });
  } else if (key === 'ctrl+shift+KeyV' && getMode(v.state) === 'edit') {
    // As the host does: the clipboard's text read on the host's side, sent with the command.
    void navigator.clipboard
      .readText()
      .then((text) => host.post({ type: 'command', id: 'pastePlain', args: { text } }))
      .catch(report);
  } else if (formattingKeys[key] && getMode(v.state) === 'edit' && !field) {
    host.post({ type: 'command', id: formattingKeys[key]! });
  } else if (bothViewKeys[key] && !field) {
    host.post({ type: 'command', id: bothViewKeys[key]! });
  } else {
    handled = false;
  }
  if (handled) event.preventDefault();
});

// ---------------------------------------------------------------------------
// Faults

let poisonSeq = 0;

/**
 * Changes the panel's text without PanelSync knowing (a bug in the panel), under any edits it
 * has not had confirmed (`corruption`). The text is visible in the panel; it must never reach
 * the document.
 */
function corruptPanel(): string | null {
  const v = panelView();
  if (!v) return null;
  const poison = `⟦P${++poisonSeq}⟧`;
  const text = v.state.doc.toString();
  const positions = safePositions(text);
  const at = positions[Math.floor(positions.length / 2)] ?? 0;
  v.dispatch(corruption(v.state, at, poison));
  scheduleRefresh();
  return poison;
}

// ---------------------------------------------------------------------------
// The bar

const bar = element('hx-bar');

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  bar.appendChild(b);
  return b;
}

const sampleSelect = barSelect(bar, 'Sample', [], (name) => void loadSample(name).catch(report));
const modeSelect = barSelect(
  bar,
  'View',
  [
    ['edit', 'Rich editor'],
    ['view', 'Rich view'],
  ],
  (mode) => host.setMode(mode as Mode),
);
const setTheme = themeSelect(bar, params);
const stormButton = button('Storm', () => {
  const seed = (lastStorm?.seed ?? 0) + 1;
  void storm(300, seed).catch(report);
});
button('Drop next message', () => {
  host.dropNextMessage();
  scheduleRefresh();
});
button('Corrupt panel', () => void corruptPanel());

modeSelect.value = params.get('mode') === 'view' ? 'view' : 'edit';

/**
 * Shows the panel's view in the View box. Called after every step of the host, not on the next
 * frame: a file opened next opens in the view the box shows.
 */
function followMode(): void {
  const v = panelView();
  if (v && modeSelect.value !== getMode(v.state)) modeSelect.value = getMode(v.state);
}

// ---------------------------------------------------------------------------
// The status line and the notices

let refreshQueued = false;

function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refresh();
  });
}

function part(text: string, bad = false): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  if (bad) span.className = 'hx-bad';
  return span;
}

function refresh(): void {
  if (!host) return;
  const v = panelView();
  const parts: HTMLElement[] = [];
  const logVersion = host.coordinator.inspect().version;
  parts.push(part(`Document v${host.doc.version}`), part(`Log v${logVersion}`));
  if (v) {
    const unsent = sendableUpdates(v.state).length;
    parts.push(part(`Panel v${getSyncedVersion(v.state)}`));
    const agrees = agree();
    parts.push(part(`Agree: ${agrees ? 'yes' : 'no'}`, !agrees && unsent === 0));
    if (unsent > 0) parts.push(part(`Unsent: ${unsent}`));
    followMode();
  } else {
    parts.push(part(panelFailed() ? 'Panel: could not start' : 'Panel: starting', panelFailed()));
  }
  parts.push(part(`Dirty: ${host.dirty ? 'yes' : 'no'}`));
  parts.push(part(host.documentEol === '\r\n' ? 'Document CRLF' : 'Document LF'));
  parts.push(part(host.diskEol === '\r\n' ? 'File CRLF' : 'File LF'));
  parts.push(part(`Notices: ${host.notices.length}`));
  if (host.willDropNext) parts.push(part('Next message will be dropped'));
  if (storming) parts.push(part(`Storm ${storming.done} of ${storming.total} (seed ${storming.seed})`));
  else if (lastStorm)
    parts.push(
      part(
        `Last storm (seed ${lastStorm.seed}): ${lastStorm.ok ? 'agree, nothing lost' : lastStorm.failures[0]}`,
        !lastStorm.ok,
      ),
    );
  const line: Node[] = [];
  parts.forEach((p, i) => {
    if (i > 0) line.push(document.createTextNode(' · '));
    line.push(p);
  });
  statusLine.replaceChildren(...line);
  stormButton.disabled = !!storming;
  autoSaveBox.checked = host.autoSave;
  showNotices();
}

let shownNotices = -1;

function showNotices(): void {
  const count = host.notices.length + host.hostMessages.length;
  if (count === shownNotices) return;
  shownNotices = count;
  const items: HTMLElement[] = [];
  for (const n of host.notices) {
    const li = document.createElement('li');
    li.textContent = summarizeNotice(host.fileName, n);
    if ('backupPath' in n && n.backupPath !== null) li.title = `Saved as ${n.backupPath}`;
    const label =
      n.kind === 'conflict'
        ? n.choice === 'use'
          ? 'Use Change from Disk'
          : n.choice === 'replace'
            ? 'Replace My View'
            : null
        : n.kind === 'applied' && n.canUndo
          ? 'Undo'
          : null;
    if (label !== null) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => void host.press(n));
      li.appendChild(b);
    }
    items.push(li);
  }
  for (const m of host.hostMessages) {
    const li = document.createElement('li');
    li.textContent = m;
    items.push(li);
  }
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'None.';
    items.push(li);
  }
  noticeList.replaceChildren(...items);
}

// ---------------------------------------------------------------------------
// Reading the two sides

function panelText(): string | null {
  const v = panelView();
  return v ? v.state.doc.toString() : null;
}

/** The panel and the document hold the same text (length and hash). */
function agree(): boolean {
  const text = panelText();
  return text !== null && sameStamp(stampOf(text), host.documentStamp());
}

function panelNotices(): string[] {
  return [...panelRoot.querySelectorAll('.tm-notice-text')].map((n) => n.textContent ?? '');
}

// ---------------------------------------------------------------------------
// The storm

export interface StormReport {
  seed: number;
  steps: number;
  ok: boolean;
  /** The panel, the document and the core's log hold the same text at the same version. */
  agree: boolean;
  /** Every promise that did not hold, in plain words. Empty when ok. */
  failures: string[];
  outsideWrites: { writes: number; markers: number; inFile: number; backedUp: number; removedOnPurpose: number };
  typed: { panel: number; source: number };
  saves: number;
  undos: number;
  conflicts: number;
  resyncs: number;
  ms: number;
  /** With `{ trace: true }`: one line per operation, with the markers it made and whether the panel holds them. */
  trace?: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'echo', 'fox', 'golf', 'hotel', 'india', 'kilo', 'lima', 'mike'];

/**
 * `n` random operations across typing in the panel, typing in the document, outside writes,
 * saves and undos, with random delays and random waits on every channel; then everything is
 * sent and saved, and the result checked: the two sides agree, and every outside write is in
 * the file, or was removed on purpose (deleted, or undone), or is in a backup with a notice.
 */
async function storm(n = 300, seed = 1, options: { trace?: boolean } = {}): Promise<StormReport> {
  if (storming) throw new Error('A storm is already running');
  const trace: string[] | null = options.trace ? [] : null;
  const started = performance.now();
  const h = host;
  const rng = new Rng(seed);
  storming = { done: 0, total: n, seed };
  scheduleRefresh();

  let markerSeq = 0;
  const origin = new Map<string, 'panel' | 'source' | 'outside'>();
  const removed = new Set<string>();
  const counts = { writes: 0, panel: 0, source: 0, saves: 0, undos: 0 };
  const initsBefore = h.inits.length;
  const logsBefore = h.logs.length;
  const noticesBefore = h.notices.length;
  const failures: string[] = [];

  /** For a marker that is missing at the end: what deleted it from the document, the last time that happened. */
  const leftBy = new Map<string, string>();
  const offDoc = h.onDocumentChange((before, after, cause) => {
    const now = new Set(markersIn(after));
    for (const m of markersIn(before)) {
      if (now.has(m)) continue;
      leftBy.set(m, cause.kind);
      if (trace) {
        const at = before.indexOf(m);
        trace.push(
          `document ${cause.kind}: ${m} left; it was in ${JSON.stringify(before.slice(Math.max(0, at - 25), at + m.length + 25))}`,
        );
      }
      // Text the user deleted in Source, or that an undo or redo deleted, left on purpose.
      if (cause.kind === 'source' || cause.kind === 'undo' || cause.kind === 'redo') removed.add(m);
    }
  });
  const marker = (who: 'panel' | 'source' | 'outside') => {
    const m = `⟦${++markerSeq}⟧`;
    origin.set(m, who);
    return m;
  };
  const token = (r: Rng, who: 'panel' | 'source' | 'outside') => (r.chance(0.6) ? marker(who) : r.pick(WORDS));
  const view = (): EditorView => {
    const v = panelView();
    if (!v) throw new Error('The panel has no editor');
    return v;
  };
  const quietly = (p: Promise<unknown>) =>
    void p.catch((error) => failures.push(`an operation failed: ${errorMessage(error)}`));

  h.setMode('edit');
  await h.until(
    () => {
      const v = panelView();
      return !!v && getMode(v.state) === 'edit';
    },
    5000,
    'the panel did not switch to Rich editor',
  );
  h.setLatency({ messages: 25, disk: 10, rng: new Rng(seed ^ 0x5bd1e995) });

  const ops: [number, (r: Rng) => Promise<void> | void][] = [
    // Typing in the panel, a character at a time, sometimes with pauses inside a word. A marker
    // is inserted as one piece: an undo can rightly take back half a word that a flush sent (the
    // flush before every undo sends whatever is typed so far), and half a marker could not be
    // traced afterward.
    [
      5,
      async (r) => {
        const v = view();
        v.dispatch({ selection: { anchor: r.pick(safePositions(v.state.doc.toString())) }, userEvent: 'select' });
        const word = token(r, 'panel');
        const pieces: string[] = word.startsWith('⟦') ? [word] : Array.from(word);
        const end = r.next();
        if (end < 0.45) pieces.push(' ');
        else if (end < 0.55) pieces.push('\n');
        else if (end < 0.6) {
          pieces.unshift(' ');
          pieces.push('.');
        }
        counts.panel++;
        const slow = r.chance(0.2);
        for (const ch of pieces) {
          // At the cursor, which updates arriving during a pause have moved with the text.
          const cur = view();
          const at = cur.state.selection.main.head;
          cur.dispatch({
            changes: { from: at, insert: ch },
            selection: { anchor: at + ch.length },
            userEvent: 'input.type',
          });
          if (slow) await sleep(r.int(15));
        }
      },
    ],
    // Pasting in the panel.
    [
      0.6,
      (r) => {
        const v = view();
        const at = r.pick(safePositions(v.state.doc.toString()));
        const parts: string[] = [];
        for (let i = 0, k = 1 + r.int(4); i < k; i++) parts.push(token(r, 'panel'));
        counts.panel++;
        v.dispatch({
          changes: { from: at, insert: (r.chance(0.5) ? '\n' : ' ') + parts.join(' ') + ' ' },
          userEvent: 'input.paste',
        });
      },
    ],
    // Deleting in the panel.
    [
      1.2,
      (r) => {
        const v = view();
        const range = safeRange(v.state.doc.toString(), r, r.chance(0.4) ? 1 : 25);
        if (!range) return;
        for (const m of markersIn(v.state.sliceDoc(range[0], range[1]))) removed.add(m);
        v.dispatch({
          changes: { from: range[0], to: range[1] },
          userEvent: range[1] - range[0] <= 1 ? 'delete.backward' : 'delete.selection',
        });
      },
    ],
    // Typing and deleting in the document (Source).
    [
      1.5,
      (r) => {
        const at = r.pick(safePositions(h.documentText()));
        counts.source++;
        h.sourceEdit({ from: at, to: at, insert: token(r, 'source') + (r.chance(0.7) ? ' ' : '\n') });
      },
    ],
    [
      0.5,
      (r) => {
        const range = safeRange(h.documentText(), r, 20);
        if (range) h.sourceEdit({ from: range[0], to: range[1], insert: '' });
      },
    ],
    // Another program writes the file, never in the middle of a save: an outside write there can
    // be overwritten, a limit docs/ARCHITECTURE.md states ("Outside changes", "Limits").
    [
      0.8,
      (r) => {
        if (h.doc.saving) return;
        const current = h.diskText();
        if (current === null) return;
        let next: string = current;
        for (let i = 0, k = 1 + r.int(3); i < k; i++) {
          const m = marker('outside');
          if (r.chance(0.55)) {
            const at = r.pick(safePositions(next));
            next = `${next.slice(0, at)} ${m} ${next.slice(at)}`;
          } else {
            const lines = next.split('\n');
            lines.splice(r.int(lines.length + 1), 0, `${r.pick(WORDS)} ${m} ${r.pick(WORDS)}`);
            next = lines.join('\n');
          }
        }
        counts.writes++;
        h.writeOutside(next);
      },
    ],
    [
      0.1,
      () => {
        if (!h.doc.saving) h.flipLineEndings();
      },
    ],
    // Saving: from the panel (sends unsent typing first), in Source, or by auto-save.
    [
      0.25,
      () => {
        counts.saves++;
        quietly(h.save());
      },
    ],
    [
      0.15,
      () => {
        counts.saves++;
        quietly(h.sourceSave());
      },
    ],
    [
      0.1,
      () => {
        h.autoSave = !h.autoSave;
      },
    ],
    // Undo and redo: from the panel (through the host), and in Source.
    [
      0.3,
      () => {
        counts.undos++;
        quietly(h.history('undo'));
      },
    ],
    [0.12, () => void quietly(h.history('redo'))],
    [
      0.3,
      () => {
        counts.undos++;
        h.sourceHistory('undo');
      },
    ],
    [0.12, () => void h.sourceHistory('redo')],
    [0.1, () => h.windowFocused()],
  ];
  const names = [
    'type in panel',
    'paste in panel',
    'delete in panel',
    'type in Source',
    'delete in Source',
    'outside write',
    'flip line endings',
    'save from panel',
    'save in Source',
    'auto-save switch',
    'undo from panel',
    'redo from panel',
    'undo in Source',
    'redo in Source',
    'window focus',
  ];
  const total = ops.reduce((sum, [w]) => sum + w, 0);
  const delays = [0, 0, 0, 1, 2, 5, 10, 20, 40, 80, 150, 450];

  try {
    for (let i = 0; i < n; i++) {
      const r = new Rng(rng.int(0x7fffffff));
      let x = rng.next() * total;
      const index = ops.findIndex(([w]) => (x -= w) < 0);
      const op = ops[index < 0 ? 0 : index]!;
      const firstMarker = markerSeq + 1;
      await op[1](r);
      if (trace) {
        const made: string[] = [];
        for (let k = firstMarker; k <= markerSeq; k++) made.push(`⟦${k}⟧`);
        const v = panelView();
        const panelNow = v?.state.doc.toString() ?? '';
        const head = v?.state.selection.main.head ?? 0;
        const near = JSON.stringify(panelNow.slice(Math.max(0, head - 30), head + 10));
        const shown = made
          .map((m) => `${m}${panelNow.includes(m) ? ' in panel' : ` not in panel (near the cursor: ${near})`}`)
          .join(', ');
        trace.push(`${i + 1} ${names[index < 0 ? 0 : index]}${shown ? `: ${shown}` : ''}`);
      }
      storming.done = i + 1;
      scheduleRefresh();
      await sleep(rng.pick(delays));
    }

    // Everything sent, delivered and saved.
    h.autoSave = false;
    h.setLatency(null);
    let state: PanelTestState | null = null;
    for (let round = 0; round < 8; round++) {
      await h.runInPanel([{ type: 'flush' }]);
      await h.whenQuiet();
      await h.sourceSave();
      await h.whenQuiet();
      state = (await h.runInPanel([{ type: 'state' }])).result as PanelTestState;
      const s = h.coordinator.inspect();
      if (
        !h.dirty &&
        h.diskText() === h.documentText() &&
        s.pendings === 0 &&
        state.unconfirmed === 0 &&
        state.text === h.documentText()
      )
        break;
    }
    if (!state) throw new Error('the panel did not answer');

    // The checks.
    const doc = h.documentText();
    const file = h.diskText() ?? '';
    const core = h.coordinator.inspect();
    const agrees = state.text === doc && core.text === doc && state.version === core.version && state.unconfirmed === 0;
    if (state.text !== doc) failures.push('the panel does not hold the document text');
    if (core.text !== doc) failures.push("the core's log does not hold the document text");
    if (state.version !== core.version)
      failures.push(`the panel is at version ${state.version}, the core at ${core.version}`);
    if (state.unconfirmed !== 0) failures.push(`the panel still has ${state.unconfirmed} unsent changes`);
    if (file !== doc) failures.push('the file is not the document after the last save');
    if (h.dirty) failures.push('the document is still dirty after the last save');
    if (core.pendings > 0) failures.push(`${core.pendings} outside versions are still waiting to be merged`);
    if (/⟦P\d+⟧/.test(file)) failures.push('text from a corrupted panel reached the file');

    const inFile = new Map<string, number>();
    for (const m of markersIn(file)) inFile.set(m, (inFile.get(m) ?? 0) + 1);
    // A marker twice is text applied twice, except the stated cost (docs/ARCHITECTURE.md, an
    // addition beside an addition): a line the user added and saved, which another program edited
    // in a way the edit test refuses, stands twice, the program's copy beside the user's. So a
    // second copy of the user's marker counts only on a line that holds no outside marker the
    // first copy's line lacks; an outside marker twice always counts.
    const lines = file.split('\n');
    const outsideOn = (line: string) => markersIn(line).filter((x) => origin.get(x) === 'outside');
    for (const [m, k] of inFile) {
      if (k < 2 || !origin.has(m)) continue;
      const holding = lines.filter((l) => l.includes(m));
      const first = new Set(outsideOn(holding[0] ?? ''));
      const programsCopy = (l: string) => outsideOn(l).some((x) => !first.has(x));
      const statedCost = origin.get(m) !== 'outside' && holding.length === k && holding.slice(1).every(programsCopy);
      if (!statedCost) failures.push(`${m} is in the file ${k} times`);
    }
    const noticed = new Set(h.notices.slice(noticesBefore).map((x) => ('backupPath' in x ? x.backupPath : '')));
    const backups = h.backups().filter((b) => noticed.has(b.path));
    const backedUp = (m: string) => backups.some((b) => b.text.includes(m));

    const outside = { writes: counts.writes, markers: 0, inFile: 0, backedUp: 0, removedOnPurpose: 0 };
    for (const [m, who] of origin) {
      if (who === 'outside') {
        outside.markers++;
        if (inFile.has(m)) outside.inFile++;
        else if (removed.has(m)) outside.removedOnPurpose++;
        else if (backedUp(m)) outside.backedUp++;
        else failures.push(`an outside write's ${m} is not in the file and not in a backup with a notice`);
      } else if (!inFile.has(m) && !removed.has(m)) {
        const how = leftBy.has(m)
          ? `it left the document in a change of kind "${leftBy.get(m)}"`
          : 'it never reached the document';
        failures.push(`${m}, typed in ${who === 'panel' ? 'the panel' : 'Source'}, was lost: ${how}`);
      }
    }
    const resyncs = h.inits.slice(initsBefore).filter((x) => x.reason === 'resync').length;
    if (resyncs > 0) failures.push(`the panel was reloaded ${resyncs} times with no fault injected`);
    for (const l of h.logs.slice(logsBefore))
      if (l.level === 'error') failures.push(`an error was logged: ${l.message}`);

    const result: StormReport = {
      seed,
      steps: n,
      ok: failures.length === 0,
      agree: agrees,
      failures,
      outsideWrites: outside,
      typed: { panel: counts.panel, source: counts.source },
      saves: counts.saves,
      undos: counts.undos,
      conflicts: h.notices.slice(noticesBefore).filter((x) => x.kind === 'conflict').length,
      resyncs,
      ms: Math.round(performance.now() - started),
    };
    if (trace) result.trace = trace;
    lastStorm = result;
    console.log('Storm', result);
    return result;
  } finally {
    offDoc();
    h.setLatency(null);
    storming = null;
    scheduleRefresh();
  }
}

/** A range of `text` with both ends outside every marker, at most about `maxLength` long. */
function safeRange(text: string, r: Rng, maxLength: number): [number, number] | null {
  const pos = safePositions(text);
  if (pos.length < 2) return null;
  const i = r.int(pos.length - 1);
  const a = pos[i]!;
  const limit = a + 1 + r.int(maxLength);
  let j = i + 1;
  while (j + 1 < pos.length && pos[j + 1]! <= limit) j++;
  const b = pos[j]!;
  return b > a ? [a, b] : null;
}

// ---------------------------------------------------------------------------
// Start

async function start(): Promise<void> {
  const first = await listSamples(sampleSelect, params.get('sample'));
  if (!first) throw new Error('There are no samples');
  await loadSample(first);
}

const ready = start();
ready.catch((error) => console.error('The harness could not start', error));

declare global {
  interface Window {
    __harness: unknown;
  }
}

window.__harness = {
  get host() {
    return host;
  },
  get view() {
    return panelView();
  },
  /** Whether the panel's failure page is showing. */
  get failed() {
    return panelFailed();
  },
  ready,
  documentText: () => host.documentText(),
  diskText: () => host.diskText(),
  panelText,
  agree,
  storm,
  get lastStorm() {
    return lastStorm;
  },
  notices: () => ({
    panel: panelNotices(),
    host: [...host.notices.map((x) => summarizeNotice(host.fileName, x)), ...host.hostMessages],
  }),
  runCommand: (id: string, args?: unknown) => {
    const v = panelView();
    return v ? runCommand(v, id, args) : false;
  },
  open,
  loadSample,
  corruptPanel,
  setTheme,
  // How many of each kind (src/panel/syntax/kinds.ts) the panel shows, or the element `selector` names.
  countKinds: (names: string[], selector = '#tm-root .cm-content') => {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`Nothing on the page matches ${selector}`);
    return countKinds(root, names);
  },
};
