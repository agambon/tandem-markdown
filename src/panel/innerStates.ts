// The editor states a drawing makes to draw from with the panel's features: a grid table's cell,
// an embedded note. Only editor.ts can build one, since it holds the list of features, and those
// drawings are on the list; so every state editor.ts builds carries its maker (`innerStates`), and
// a drawing asks the state it is drawn in (`innerState`) rather than import the editor.

import { Facet, type EditorState } from '@codemirror/state';
import type { Mode } from '../core/protocol';
import type { PanelContext } from './context';

/** An inner state's context, text and mode, and the ids of the features it leaves out. */
export interface InnerStateOptions {
  ctx: PanelContext;
  text: string;
  mode: Mode;
  leaveOut?: ReadonlySet<string>;
}

type InnerStateMaker = (options: InnerStateOptions) => EditorState;

/** How a state editor.ts built makes inner ones; null in a state built some other way. */
export const innerStates = Facet.define<InnerStateMaker, InnerStateMaker | null>({
  combine: (makers) => makers[0] ?? null,
});

/** An editor state for a drawing in `outer` to draw from, with no room to scroll past its end. */
export function innerState(outer: EditorState, options: InnerStateOptions): EditorState {
  const make = outer.facet(innerStates);
  if (!make) throw new Error('Only a state createEditorState made can make an inner state');
  return make(options);
}
