// The editor: one CodeMirror state and view over the document's LF text, with every feature.
// No history: undo and redo belong to VS Code's document, so neither the history extension nor
// any undo or redo key binding is present.

import { defaultKeymap } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { drawSelection, EditorView, keymap, scrollPastEnd, ViewPlugin } from '@codemirror/view';
import { RICH_VIEW_NAME, SETTING_DEFAULTS, type Mode, type PanelSettings } from '../core/protocol';
import { panelCommands } from './commands/registry';
import { panelContext, type PanelContext, type PanelContextHandle } from './context';
import { features, type Feature } from './features';
import { innerStates, type InnerStateOptions } from './innerStates';
import { markdownLanguage } from './markdown';
import { getMode, modeField, modes } from './modes';
import { reportFault } from './render/faults';
import { renderFramework, settingsChangedEffect } from './render/framework';
import { parserKey } from './syntax';
import { syntaxColors } from './theme/highlight';

const settingsCompartment = new Compartment();
/** The markdown language, which holds the parser extensions of the optional syntax that is on. */
const languageCompartment = new Compartment();

/** The editor's tab size and indent unit, from the settings. */
export function settingsExtensions(settings: PanelSettings): Extension {
  const tabSize = settings.tabSize > 0 ? settings.tabSize : SETTING_DEFAULTS.tabSize;
  return [EditorState.tabSize.of(tabSize), indentUnit.of(settings.insertSpaces ? ' '.repeat(tabSize) : '\t')];
}

/** Writes the settings that the stylesheet reads onto the root element. */
function applySettingsStyle(settings: PanelSettings, root: HTMLElement): void {
  const style = root.style;
  style.setProperty('--tm-content-width', settings.contentWidth > 0 ? `${settings.contentWidth}px` : 'none');
  style.setProperty('--tm-font-size', `${settings.fontSize > 0 ? settings.fontSize : SETTING_DEFAULTS.fontSize}px`);
  style.setProperty(
    '--tm-line-height',
    String(settings.lineHeight >= 1 ? settings.lineHeight : SETTING_DEFAULTS.lineHeight),
  );
  if (settings.fontFamily.trim()) style.setProperty('--tm-font-family', settings.fontFamily);
  else style.removeProperty('--tm-font-family');
}

/**
 * Keeps the view in step with `ctx`'s settings; stops when the view is destroyed. A change to
 * the optional syntax gives the editor a new parser, which parses the document again; the
 * document itself is not touched.
 */
function followSettings(ctx: PanelContext): Extension {
  return ViewPlugin.define((view) => {
    applySettingsStyle(ctx.settings, view.dom.ownerDocument.documentElement);
    let parsers = parserKey(ctx.settings);
    const stop = ctx.onSettingsChange(() => {
      applySettingsStyle(ctx.settings, view.dom.ownerDocument.documentElement);
      const effects: StateEffect<unknown>[] = [
        settingsCompartment.reconfigure(settingsExtensions(ctx.settings)),
        settingsChangedEffect.of(null),
      ];
      const nextParsers = parserKey(ctx.settings);
      if (nextParsers !== parsers) {
        parsers = nextParsers;
        effects.push(languageCompartment.reconfigure(markdownLanguage(ctx.settings)));
      }
      view.dispatch({ effects });
    });
    return { destroy: stop };
  });
}

/**
 * CodeMirror's default bindings that the panel leaves out. Mod-i ("select the parent syntax
 * node") is Italic's key, and CodeMirror would act in the page before VS Code's forwarded
 * command arrives. Ctrl-m (Shift-Alt-m on a Mac) toggles tab focus mode, which the host holds
 * for every panel and sets in each (`ui/tabFocus.ts`): a toggle in one page alone would leave
 * that page and VS Code's status bar item disagreeing. No other default binding uses a key that
 * `package.json` binds.
 */
const KEYS_VSCODE_OWNS = new Set(['Mod-i', 'Ctrl-m', 'Shift-Alt-m']);

/** CodeMirror's default keymap less the keys VS Code owns. */
const baseKeymap = defaultKeymap.filter(
  (binding) =>
    ![binding.key, binding.mac, binding.win, binding.linux].some(
      (key) => key !== undefined && KEYS_VSCODE_OWNS.has(key),
    ),
);

/** The content element's accessible name: the view and the file, as in "Rich editor, notes.md". */
function accessibleName(fileName: string): Extension {
  return EditorView.contentAttributes.compute([modeField], (state) => ({
    'aria-label': `${RICH_VIEW_NAME[getMode(state)]}, ${fileName}`,
  }));
}

/** The nonce for CodeMirror's style elements, from `<meta name="tm-csp-nonce">` when the page has one. */
function cspNonce(): Extension {
  if (typeof document === 'undefined') return [];
  const nonce = document.querySelector('meta[name="tm-csp-nonce"]')?.getAttribute('content');
  return nonce ? EditorView.cspNonce.of(nonce) : [];
}

/**
 * Every feature's extension and commands. A feature that throws while it is set up, or that
 * provides a command another feature already provides, is reported and left out.
 */
function featureExtensions(ctx: PanelContext, include: (feature: Feature) => boolean): Extension[] {
  const out: Extension[] = [];
  const commandIds = new Set<string>();
  for (const feature of features) {
    if (!include(feature)) continue;
    try {
      const ids = Object.keys(feature.commands ?? {});
      const taken = ids.find((id) => commandIds.has(id));
      if (taken !== undefined) throw new Error(`Another feature already provides the panel command "${taken}"`);
      out.push(feature.extension?.(ctx) ?? []);
      if (feature.commands) out.push(panelCommands.of(feature.commands));
      for (const id of ids) commandIds.add(id);
    } catch (error) {
      reportFault(ctx, feature.id, 'setup', error);
    }
  }
  return out;
}

/** Which features an editor has, and whether it is the page's own or one drawn inside it (an embedded note). */
interface Make {
  include: (feature: Feature) => boolean;
  inside: boolean;
}

function baseExtensions(ctx: PanelContext, mode: Mode, sync: Extension | undefined, make: Make): Extension[] {
  return [
    sync ?? [],
    modes(mode),
    accessibleName(ctx.doc.fileName),
    EditorView.lineWrapping,
    // The last lines can be scrolled to the top, so the outline can bring a late heading there.
    make.inside ? [] : scrollPastEnd(),
    drawSelection(),
    keymap.of(baseKeymap),
    languageCompartment.of(markdownLanguage(ctx.settings)),
    panelContext.of(ctx),
    cspNonce(),
    settingsCompartment.of(settingsExtensions(ctx.settings)),
    followSettings(ctx),
    renderFramework(),
    syntaxColors(),
    innerStates.of(innerEditorState),
    featureExtensions(ctx, make.include),
  ];
}

/** An editor state with every feature. */
export function createEditorState(options: {
  ctx: PanelContext;
  text: string;
  mode: Mode;
  sync?: Extension | undefined;
  selection?: { anchor: number; head: number };
}): EditorState {
  const { ctx, text, mode, sync, selection } = options;
  const length = text.length;
  const clamp = (n: number) => Math.max(0, Math.min(length, n));
  return EditorState.create({
    doc: text,
    ...(selection && { selection: { anchor: clamp(selection.anchor), head: clamp(selection.head) } }),
    extensions: baseExtensions(ctx, mode, sync, { include: () => true, inside: false }),
  });
}

/** A state for a drawing to draw from (`innerState`): the features `leaveOut` does not name. */
function innerEditorState({ ctx, text, mode, leaveOut }: InnerStateOptions): EditorState {
  const include = (feature: Feature) => !leaveOut?.has(feature.id);
  return EditorState.create({ doc: text, extensions: baseExtensions(ctx, mode, undefined, { include, inside: true }) });
}

export function createEditorView(options: {
  ctx: PanelContextHandle;
  text: string;
  mode: Mode;
  sync?: Extension;
  parent: HTMLElement;
}): EditorView {
  const { ctx, text, mode, sync, parent } = options;
  const view = new EditorView({ state: createEditorState({ ctx, text, mode, sync }), parent });
  // The context learns its view here, so ctx.view() works at once.
  ctx.setView(view);
  return view;
}
