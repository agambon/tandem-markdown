// Every feature's decorations for a state, without a view: what the panel's unit tests and the
// parser sweep (scripts/parser-sweep.mjs) read of a drawing.

import { RangeSet, type EditorState } from '@codemirror/state';
import type { Decoration, DecorationSet } from '@codemirror/view';
import { blockSources, drawRange, inlineSources } from '../../src/panel/render/framework';

export interface DrawnFeature {
  feature: string;
  channel: 'inline' | 'block';
  decorations: DecorationSet;
  atomic: RangeSet<Decoration>;
}

const allCache = new WeakMap<object, DecorationSet>();

/** A block feature's three sets as one, the same object for as long as the drawing is. */
function allOf(drawn: {
  decorations: DecorationSet;
  lineClasses: DecorationSet;
  inline: DecorationSet;
}): DecorationSet {
  let all = allCache.get(drawn);
  if (!all) allCache.set(drawn, (all = RangeSet.join([drawn.decorations, drawn.lineClasses, drawn.inline])));
  return all;
}

/**
 * Every feature's decorations for `state`. Inline features are drawn over the whole document.
 * The state's syntax tree is used as it is; parse it fully first when that matters
 * (`withFullTree`).
 */
export function drawHeadless(state: EditorState): DrawnFeature[] {
  const out: DrawnFeature[] = [];
  for (const source of state.facet(blockSources)) {
    const drawn = state.field(source.field);
    out.push({ feature: source.feature, channel: 'block', decorations: allOf(drawn), atomic: drawn.atomic });
  }
  for (const source of state.facet(inlineSources)) {
    const build = source.build as Parameters<typeof drawRange>[1];
    const drawn = drawRange(source.feature, build, state, 0, state.doc.length, 'inline');
    out.push({ feature: source.feature, channel: 'inline', decorations: drawn.decorations, atomic: drawn.atomic });
  }
  return out;
}
