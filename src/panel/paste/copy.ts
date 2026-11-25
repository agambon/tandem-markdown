// Copy and cut: CodeMirror puts the selected markdown on the clipboard as text; this adds that
// markdown rendered as HTML (raw HTML in it escaped), and OWN_TYPE.
//
// A clipboard event must be answered before it returns, so the renderer cannot load during a
// copy. It loads as soon as text is selected or Ctrl or Cmd is pressed, which comes before
// almost every copy. A copy made before it has loaded carries the text and OWN_TYPE only.

import type { SelectionRange } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { panelContext } from '../context';
import { onDemand } from '../onDemand';
import { OWN_TYPE } from './choose';

const renderer = onDemand(() => import('./markdownToHtml'));
let requested: Promise<unknown> | undefined;

const hasSelectedText = (ranges: readonly SelectionRange[]) => ranges.some((range) => !range.empty);

/** Starts loading the renderer, once; a failure is logged once. */
function requestRenderer(view: EditorView): void {
  requested ??= renderer
    .load()
    .catch((error: unknown) => view.state.facet(panelContext)?.log('warn', 'The copy renderer did not load', error));
}

/**
 * Runs after CodeMirror's own copy and cut handler (it listens on the content element; this
 * listens on the editor around it), so CodeMirror has already chosen the text and, for a cut,
 * deleted it. This adds the HTML and the mark that the text came from here.
 */
export const copyAsHtml = ViewPlugin.fromClass(
  class {
    private readonly onCopy = (event: Event) => this.copied(event as ClipboardEvent);
    private readonly onKey = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') requestRenderer(this.view);
    };

    constructor(readonly view: EditorView) {
      view.dom.addEventListener('copy', this.onCopy);
      view.dom.addEventListener('cut', this.onCopy);
      view.dom.addEventListener('keydown', this.onKey);
      if (hasSelectedText(view.state.selection.ranges)) requestRenderer(view);
    }

    update(update: ViewUpdate): void {
      if (update.selectionSet && hasSelectedText(update.state.selection.ranges)) requestRenderer(this.view);
    }

    copied(event: ClipboardEvent): void {
      const data = event.clipboardData;
      if (!event.defaultPrevented || !data) return;
      if (!(event.target instanceof Node) || !this.view.contentDOM.contains(event.target)) return;
      const text = data.getData('text/plain');
      if (!text) return;
      data.setData(OWN_TYPE, '1');
      const loaded = renderer.loaded();
      if (!loaded) {
        requestRenderer(this.view);
        return;
      }
      try {
        data.setData('text/html', loaded.markdownToHtml(text));
      } catch (error) {
        this.view.state.facet(panelContext)?.log('warn', 'Copy could not add the HTML form', error);
      }
    }

    destroy(): void {
      this.view.dom.removeEventListener('copy', this.onCopy);
      this.view.dom.removeEventListener('cut', this.onCopy);
      this.view.dom.removeEventListener('keydown', this.onKey);
    }
  },
);
