// The links feature's block part (link definitions, removed in Rich view and faded in Rich
// editor) draws only what changed after an edit. What it keeps must be what drawing the whole
// document again gives (the render guide's block-feature rule).

import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createEditorState } from '../../../src/panel/editor';
import { withFullTree } from '../../../src/panel/render/framework';
import { Rng } from '../../sync/world';
import { drawHeadless } from '../headless';
import { expectSameAsFresh, fakeContext, freshState, randomEdit } from '../helpers';

const start = `# Title

See [the guide][g] and [x].

[g]: guide.md "Guide"
[x]: <other note.md>

> [q]: /quoted.md

- [l]: /in-list.md

Text ![pic](a.png) and [[Note|alias]].

[late]:
  https://late.example
  "Title on its own line"

End.
`;

const snippets = ['\n', '\n\n', '[y]: z.md\n', '[g]: ', '> ', '- ', 'text ', '[', ']', ':', '  ', '"t"\n'];

function linkBlocks(state: EditorState): string[] {
  const out: string[] = [];
  for (const f of drawHeadless(state)) {
    if (f.feature !== 'links' || f.channel !== 'block') continue;
    f.decorations.between(0, state.doc.length, (from, to, deco) => {
      out.push(`${from}-${to} ${(deco.spec.class as string | undefined) ?? (deco.spec.block ? 'hidden' : '')}`);
    });
  }
  return out.sort();
}

describe('link definitions after an edit', () => {
  for (const mode of ['edit', 'view'] as const) {
    it(`draw as a full redraw does, over random edits and cursor moves (${mode})`, () => {
      const { ctx } = fakeContext();
      const rng = new Rng(mode === 'edit' ? 3 : 5);
      const opened = withFullTree(createEditorState({ ctx, text: start, mode, selection: { anchor: 0, head: 0 } }));
      expect(linkBlocks(opened).length).toBeGreaterThan(0);
      expectSameAsFresh({
        start: opened,
        steps: 200,
        edit: (state) => randomEdit(state, rng, snippets),
        fresh: (state) => freshState(state, ctx, mode),
        read: linkBlocks,
      });
    });
  }
});
