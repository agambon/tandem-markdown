// Paste, drop, copy and cut in the panel. `choosePaste` decides (choose.ts) and the `*Change`
// functions write (changes.ts); a rule that answers plain text leaves the paste to CodeMirror,
// which also handles a line copied with nothing selected and one line per cursor.
// Ctrl+Shift+V pastes the text with no conversion: the host reads the clipboard through VS Code
// and sends `pastePlain` with its text, and where the page itself gets the key (the lab page,
// VS Code in a browser) the paste event that follows it.

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { PanelCommand } from '../commands/registry';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { focusedField } from '../focus';
import { onDemand } from '../onDemand';
import { blockChange, linkChange, markdownChange, plainChange } from './changes';
import { choosePaste, inPlainBlock, type ClipboardInput } from './choose';
import { copyAsHtml } from './copy';
import { dropHeldPaste, heldPastes, holdPaste, insertHeldPaste, type PasteTarget } from './held';
import { saveAndLinkImages } from './images';

const converter = onDemand(() => import('./htmlToMarkdown'));
let converterRequested: Promise<unknown> | undefined;

/** Starts loading the HTML converter, once; a failure is logged once. */
function requestConverter(view: EditorView): void {
  converterRequested ??= converter
    .load()
    .catch((error: unknown) => view.state.facet(panelContext)?.log('warn', 'The HTML converter did not load', error));
}

/**
 * Half of a UTF-16 surrogate pair alone: a high one with no low one after it, or a low one
 * with no high one before it.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Pasted text without unpaired surrogates. One is not a character: a file cannot hold it, and
 * the saved file would differ from the document (it holds U+FFFD in its place).
 */
function withoutLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '');
}

function readClipboard(data: DataTransfer): { clip: ClipboardInput; files: File[] } {
  const files = [...(data.files ?? [])].filter((file) => file.type.startsWith('image/'));
  return {
    clip: {
      text: withoutLoneSurrogates(data.getData('text/plain')),
      html: withoutLoneSurrogates(data.getData('text/html')),
      types: [...data.types],
      images: files.map((file) => ({ name: file.name, type: file.type })),
    },
    files,
  };
}

/** Views where Ctrl+Shift+V is down, so the paste event it causes is plain. */
const plainKeyDown = new WeakSet<EditorView>();

function parseInDetachedDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** The pasted HTML as markdown: '' when it gives none, or when it cannot be converted (logged). */
function convert(
  view: EditorView,
  toMarkdown: (html: string, parse: (html: string) => Document) => string,
  html: string,
): string {
  try {
    return toMarkdown(html, parseInDetachedDocument);
  } catch (error) {
    view.state.facet(panelContext)?.log('warn', 'The pasted HTML could not be converted; pasting its text', error);
    return '';
  }
}

/**
 * Rich HTML, converted to markdown and inserted. False when the conversion gives nothing:
 * CodeMirror then pastes the plain text. A paste made before the converter has loaded is
 * held where it was made and inserted once it has (its plain text if the converter fails).
 */
function pasteHtml(view: EditorView, clip: ClipboardInput): boolean {
  const loaded = converter.loaded();
  if (loaded) {
    const markdown = convert(view, loaded.htmlToMarkdown, clip.html);
    if (!markdown) return false;
    view.dispatch(markdownChange(view.state, markdown));
    return true;
  }
  const id = holdPaste(view, view.state.selection);
  const insert = (markdown: string) => {
    if (!markdown && !clip.text) {
      dropHeldPaste(view, id);
      return;
    }
    const inserted = insertHeldPaste(view, id, (state) =>
      markdown ? markdownChange(state, markdown) : plainChange(state, clip.text),
    );
    if (!inserted) view.state.facet(panelContext)?.log('warn', 'The view reloaded before the pasted HTML went in');
  };
  converter
    .load()
    .then(
      (module) => insert(convert(view, module.htmlToMarkdown, clip.html)),
      (error: unknown) => {
        view.state.facet(panelContext)?.log('warn', 'The HTML converter did not load; pasting the text', error);
        insert('');
      },
    )
    .catch((error: unknown) => view.state.facet(panelContext)?.log('error', 'Pasting HTML failed', error));
  return true;
}

function handlePaste(event: ClipboardEvent, view: EditorView): boolean {
  const data = event.clipboardData;
  if (!data || view.state.readOnly) return false; // CodeMirror's own handler refuses or copes
  if (plainKeyDown.has(view)) {
    plainKeyDown.delete(view);
    const text = withoutLoneSurrogates(data.getData('text/plain'));
    if (text) view.dispatch(plainChange(view.state, text));
    return true;
  }
  const { clip, files } = readClipboard(data);
  const choice = choosePaste(view.state, clip);
  switch (choice.rule) {
    case 'plain':
      return false;
    case 'link':
      view.dispatch(linkChange(view.state, choice.address));
      return true;
    case 'table':
      view.dispatch(blockChange(view.state, choice.table));
      return true;
    case 'image': {
      const ctx = view.state.facet(panelContext);
      if (!ctx) return false;
      const { from, to } = view.state.selection.main;
      void saveAndLinkImages(view, ctx, files, from, to, 'input.paste').catch((error) =>
        ctx.log('error', 'Pasting an image failed', error),
      );
      return true;
    }
    case 'html':
      return pasteHtml(view, clip);
  }
}

function handleDrop(event: DragEvent, view: EditorView): boolean {
  const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  const ctx = view.state.facet(panelContext);
  if (!files.length || view.state.readOnly || !ctx) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
  if (inPlainBlock(view.state, pos)) return false;
  event.preventDefault();
  void saveAndLinkImages(view, ctx, files, pos, pos, 'input.drop').catch((error) =>
    ctx.log('error', 'Dropping an image failed', error),
  );
  return true;
}

// ---------------------------------------------------------------------------
// pastePlain (the host's Ctrl+Shift+V)

/** The clipboard's text, or null (logged) when it could not be read. */
async function clipboardText(ctx: PanelContext, readText: (() => Promise<string>) | undefined): Promise<string | null> {
  try {
    if (!readText) throw new Error('No clipboard access');
    return withoutLoneSurrogates(await readText());
  } catch (error) {
    ctx.log('warn', 'Paste as Plain Text could not read the clipboard', error);
    return null;
  }
}

/** Reads the clipboard's text and inserts it into the document with no conversion. */
export async function pastePlainFrom(
  target: PasteTarget,
  ctx: PanelContext,
  readText: (() => Promise<string>) | undefined,
): Promise<boolean> {
  if (target.state.readOnly) return false;
  const text = await clipboardText(ctx, readText);
  if (!text || target.state.readOnly) return false;
  target.dispatch(plainChange(target.state, text));
  return true;
}

/**
 * Pastes the clipboard's text with no conversion, into the field that has focus or the editor.
 * The text is the one the host read through VS Code (`args.text`); with none given (a page with
 * no host), the page reads its own clipboard.
 */
const pastePlain: PanelCommand = (view, args) => {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return false;
  const given = (args as { text?: unknown } | undefined)?.text;
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const readText =
    typeof given === 'string'
      ? () => Promise.resolve(given)
      : clipboard?.readText
        ? () => clipboard.readText()
        : undefined;
  // The host sends Ctrl+Shift+V here even while a text field in the panel has focus (the find
  // box, a table cell), and the text then belongs in that field.
  const field = focusedField(view.dom.ownerDocument, view.contentDOM);
  if (field) {
    void clipboardText(ctx, readText).then((text) => {
      // The browser's own insert, so the field's Ctrl+Z takes it back.
      if (text && field.ownerDocument.activeElement === field)
        field.ownerDocument.execCommand('insertText', false, text);
    });
    return true;
  }
  if (view.state.readOnly) return false;
  void pastePlainFrom(view, ctx, readText).catch((error) => ctx.log('error', 'Paste as plain text failed', error));
  return true;
};

// ---------------------------------------------------------------------------
// The feature

export const paste: Feature = {
  id: 'paste',
  extension: (): Extension => [
    heldPastes,
    copyAsHtml,
    // CodeMirror's own paste and its drop of text.
    EditorView.clipboardInputFilter.of(withoutLoneSurrogates),
    EditorView.domEventHandlers({
      paste: (event, view) => handlePaste(event, view),
      drop: (event, view) => handleDrop(event, view),
    }),
    EditorView.domEventObservers({
      keydown(event, view) {
        if (event.key === 'Control' || event.key === 'Meta') requestConverter(view);
        const plain =
          (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v';
        if (plain) plainKeyDown.add(view);
        else plainKeyDown.delete(view);
      },
      keyup(_event, view) {
        plainKeyDown.delete(view);
      },
    }),
  ],
  commands: { pastePlain },
};
