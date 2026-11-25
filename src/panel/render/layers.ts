// What the features that draw in a CodeMirror layer beside the text share (changeMarks.ts,
// outsideMark.ts).

import type { EditorView } from '@codemirror/view';

/** The point a layer's markers are placed from, in screen pixels, as CodeMirror's own selection layer finds it. */
export function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}
