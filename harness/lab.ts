// The render lab: the editor with every drawing feature, over a bridge that goes nowhere, except
// that embedded notes, pictures and wikilinks are answered at once, as a host would, from the
// made-up notes (harness/fakes/notes.ts) and workspace (harness/fakes/workspace.ts), the note
// being `notes/sample.md`.
//
// Query string: ?sample=<file in samples/>  ?mode=view|edit  ?theme=dark|light|<a VS Code theme>
//   ?faults  adds two features that throw (one in its build, one in a widget's draw),
//            triggered by the words THROW-IN-BUILD and THROW-IN-DRAW in the text.
//   ?readonly  opens the document as read-only.
//
// The specs drive the page through `window.__lab`, set at the end of this file.

import type { EditorView } from '@codemirror/view';
import type { ImageAnswer } from '../src/core/featureProtocol';
import {
  SETTING_DEFAULTS,
  type Mode,
  type PanelSettings,
  type PanelToHost,
  type ReplyMessage,
} from '../src/core/protocol';
import { runCommand } from '../src/panel/commands/registry';
import { createPanelContext, type HostBridge, type PanelSlots } from '../src/panel/context';
import { createEditorState, createEditorView } from '../src/panel/editor';
import { features, type Feature } from '../src/panel/features';
import { getMode, setModeEffect } from '../src/panel/modes';
import { whenAllLoaded } from '../src/panel/onDemand';
import { faultedFeatures } from '../src/panel/render/faults';
import * as framework from '../src/panel/render/framework';
import { blockFeature, inlineFeature, RichWidget } from '../src/panel/render/framework';
import { countKinds } from '../src/panel/syntax/kinds';
import { barSelect } from './barSelect';
import { embedAnswers } from './fakes/notes';
import { imageAnswers, linkAnswers } from './fakes/workspace';
import { fetchSample, listSamples } from './sampleList';
import { themeSelect } from './theme';

const params = new URLSearchParams(location.search);

const settings: PanelSettings = { ...SETTING_DEFAULTS, workspaceTrusted: true };

/** The note the lab's text is taken to be, in the made-up workspace. */
const NOTE = 'notes/sample.md';
/** The lab fetches nothing from outside: what an https address names is not found. */
const offline = (): ImageAnswer => ({ reason: 'Not found' });

/** Everything the panel posted to the (absent) host. */
const posted: PanelToHost[] = [];
/** Picture answers kept back while a script holds them (`holdPictures`), so it can see a picture waiting. */
let heldPictures: (() => void)[] | null = null;
let savedState: unknown;

/** Replies to the panel's request `requestId`, as a host would, once the current task is done. */
function answer(requestId: string, result: unknown): void {
  const reply: ReplyMessage = { type: 'reply', requestId, ok: true, result };
  queueMicrotask(() => ctx.handleReply(reply));
}

const bridge: HostBridge = {
  post(message) {
    posted.push(message);
    if (message.type === 'reloadView') location.reload();
    // A request from an embedded note's editor names that note.
    const note = 'note' in message && message.note !== undefined ? message.note : NOTE;
    if (message.type === 'embedNotes' && message.requestId) {
      answer(message.requestId, embedAnswers(message.targets, note));
    }
    if (message.type === 'resolveLinks' && message.requestId) {
      const { requestId, targets } = message;
      void linkAnswers(targets, note).then((result) => answer(requestId, result));
    }
    if (message.type === 'resolveImages' && message.requestId) {
      const { requestId, sources } = message;
      const send = () => answer(requestId, imageAnswers(sources, note, offline));
      if (heldPictures) heldPictures.push(send);
      else send();
    }
  },
  onMessage: () => () => {},
  getState: <T>() => savedState as T | undefined,
  setState: (state) => {
    savedState = state;
  },
};

function slot(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`The lab page has no ${selector}`);
  return element;
}

const slots: PanelSlots = { toolbar: slot('.tm-toolbar'), notices: slot('.tm-notices'), editor: slot('.tm-editor') };
const ctx = createPanelContext({
  bridge,
  doc: { uri: 'lab:/sample.md', fileName: 'sample.md', workspacePath: null, readOnly: params.has('readonly') },
  slots,
  settings,
});

// ---------------------------------------------------------------------------
// Test features for fault isolation (?faults)

class ThrowingWidget extends RichWidget {
  draw(): HTMLElement {
    throw new Error('Lab: a widget that throws while drawing');
  }
}

const throwInDraw: Feature = {
  id: 'labThrowInDraw',
  extension: () =>
    inlineFeature('labThrowInDraw', (d) => {
      const word = 'THROW-IN-DRAW';
      const text = d.doc.sliceString(d.from, d.to);
      for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
        d.replace(d.from + i, d.from + i + word.length, new ThrowingWidget(word));
      }
    }),
};

const throwInBuild: Feature = {
  id: 'labThrowInBuild',
  extension: () =>
    blockFeature('labThrowInBuild', (d) => {
      if (d.doc.toString().includes('THROW-IN-BUILD')) throw new Error('Lab: a build that throws');
    }),
};

if (params.has('faults')) features.push(throwInBuild, throwInDraw);

// ---------------------------------------------------------------------------
// The editor

const initialMode: Mode = params.get('mode') === 'view' ? 'view' : 'edit';
const view: EditorView = createEditorView({ ctx, text: '', mode: initialMode, parent: slots.editor });

/** Loads `text`. `{ features: false }` loads it with no drawing feature (for timing). */
function load(text: string, options: { features?: boolean } = {}): void {
  const saved = options.features === false ? features.splice(0, features.length) : null;
  try {
    view.setState(createEditorState({ ctx, text, mode: getMode(view.state) }));
  } finally {
    if (saved) features.push(...saved);
  }
}

async function loadSample(name: string): Promise<void> {
  load(await fetchSample(name));
}

function setMode(mode: Mode): void {
  view.dispatch({ effects: setModeEffect.of(mode) });
  modeSelect.value = mode;
}

// ---------------------------------------------------------------------------
// Controls

const bar = slot('#lab-bar');
const sampleSelect = barSelect(bar, 'Sample', [], (name) => void loadSample(name));
const modeSelect = barSelect(
  bar,
  'Mode',
  [
    ['edit', 'Rich editor'],
    ['view', 'Rich view'],
  ],
  (mode) => setMode(mode as Mode),
);
const setTheme = themeSelect(bar, params);
modeSelect.value = initialMode;

async function start(): Promise<void> {
  const first = await listSamples(sampleSelect, params.get('sample'));
  if (first) await loadSample(first);
}

const ready = start();
ready.catch((error) => ctx.log('error', 'The lab could not start', error));

declare global {
  interface Window {
    __lab: unknown;
  }
}

window.__lab = {
  get view() {
    return view;
  },
  text: () => view.state.doc.toString(),
  setMode,
  setTheme,
  load,
  loadSample,
  posted,
  faults: () => faultedFeatures(ctx),
  ready,
  whenLoaded: () => whenAllLoaded(),
  // For trying a feature out from a script: push one onto `features`, then `load(text)`.
  features,
  framework,
  // Runs a panel command through the command registry, as the host's `command` message does.
  runCommand: (id: string, args?: unknown) => runCommand(view, id, args),
  // Changes settings as the host's `settings` message does: `setSettings({ syntax: { math: false } })`.
  setSettings: (changes: Partial<PanelSettings>) => ctx.setSettings({ ...ctx.settings, ...changes }),
  // The HTML door itself, for the attack corpus (harness/tests/attacks.spec.mjs).
  door: () => import('../src/panel/html/door'),
  // Keeps picture requests unanswered until `releasePictures()`, which answers them all.
  holdPictures: () => {
    heldPictures ??= [];
  },
  releasePictures: () => {
    const held = heldPictures ?? [];
    heldPictures = null;
    for (const send of held) send();
  },
  // How many of each kind (src/panel/syntax/kinds.ts) the editor shows, or the element `selector` names.
  countKinds: (names: string[], selector?: string) => {
    const root = selector ? document.querySelector(selector) : view.contentDOM;
    if (!root) throw new Error(`Nothing on the page matches ${selector}`);
    return countKinds(root, names);
  },
};
