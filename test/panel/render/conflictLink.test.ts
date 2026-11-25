// The link under a conflict git left in a note: "Resolve in Merge Editor" while the host says git
// lists the note as in conflict, "Resolve in Source" otherwise. The link drawn and pressed in a
// real VS Code window is not checked here.

import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { gitConflictEffects, gitConflictedIn, resolveLink } from '../../../src/panel/render/conflicts';
import { drawHeadless } from '../headless';
import { stateOf } from '../helpers';

const NOTE = 'Above.\n\n<<<<<<< HEAD\nBudget: 4,200.\n=======\nBudget: 4,500.\n>>>>>>> north-wall\n\nBelow.‸';

/** The first line of the text the conflict's drawing was made from: the view and the link. */
function drawnFor(state: EditorState): string[] {
  const out: string[] = [];
  for (const f of drawHeadless(state)) {
    if (f.feature !== 'conflicts') continue;
    f.decorations.between(0, state.doc.length, (_from, _to, deco) => {
      const text = (deco.spec.widget as { text?: unknown } | undefined)?.text;
      if (typeof text === 'string') out.push(text.slice(0, text.indexOf('\n')));
    });
  }
  return out;
}

describe('the link under a conflict', () => {
  it('says Resolve in Merge Editor while git lists the note as in conflict', () => {
    expect(resolveLink(true)).toEqual({ label: 'Resolve in Merge Editor', tooltip: null });
  });

  it('says Resolve in Source, with its tooltip, otherwise', () => {
    expect(resolveLink(false)).toEqual({
      label: 'Resolve in Source',
      tooltip: "Open the note in Source, VS Code's text editor, at this conflict",
    });
  });

  it('goes to Source until the host says git lists the note, and to the merge editor after', () => {
    const before = stateOf(NOTE);
    expect(gitConflictedIn(before)).toBe(false);
    expect(drawnFor(before)).toEqual(['edit source']);
    const after = before.update({ effects: gitConflictEffects(true) }).state;
    expect(gitConflictedIn(after)).toBe(true);
    expect(drawnFor(after)).toEqual(['edit merge']);
    expect(drawnFor(stateOf(NOTE, { mode: 'view' }))).toEqual(['view source']);
  });
});
