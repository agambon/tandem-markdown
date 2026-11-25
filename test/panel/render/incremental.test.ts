// A block feature draws only what changed after an edit and keeps the rest. Whatever it
// keeps must be exactly what drawing the whole document again would give.

import type { EditorState } from '@codemirror/state';
import { describe, it } from 'vitest';
import { createEditorState } from '../../../src/panel/editor';
import { headingsField, setHeadings } from '../../../src/panel/render/contents';
import { redrawFeatureEffect, withFullTree } from '../../../src/panel/render/framework';
import { Rng } from '../../sync/world';
import { drawnLines, expectSameAsFresh, fakeContext, freshState, randomEdit } from '../helpers';

const start = `---
title: x
---

# Title

Para with **bold** text.
Second line.

- one
- two
  - nested
- [ ] task

> quote
>
> > nested

> [!tip]- Folded
> body
>
> > [!note]
> > inner

:::: warning Outer
words

::: tip
inner
:::
::::

!!! note "Title"
    body

    - item

??? question
    folded

Term
: Its definition
  continued

+-------------+---+
| - [ ] buy   | b |
| - [?] ask   |   |
+=============+===+
| c           | d |
+-------------+---+

*[HTML]: Hyper Text

$$
x^2
$$

\`\`\`math
\\sqrt{2}
\`\`\`

\`\`\`js
let x = 1;
\`\`\`

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

<<<<<<< HEAD
Budget: 4,200.
=======
Budget: 4,500.
>>>>>>> north-wall

[TOC]

[[toc]]

![[Other note#Part two]]

A quoted line. ^quote-1

    indented code

***

<!-- comment -->

<div>
html
</div>

<details>
<summary>More</summary>

Inside **it**.

<div align="center">

Centered.

</div>

</details>

<details>

<summary>After blank line</summary>

Hidden body.

</details>

<p align="right">

Right.

Setext
------

- [?] asked
- [-] dropped

%%
hidden

still hidden
%%

Para %%hid%% and ^[inline note] and ==🔴red==.

Last [^1].

[^1]: note
    more of the note

    a second paragraph of it
`;

const snippets = [
  '\n',
  '\n\n',
  '# ',
  '## ',
  '- ',
  '  - ',
  '> ',
  '```',
  '```\n',
  '---\n',
  '***',
  'text ',
  '**b** ',
  '[ ] ',
  '<!-- c -->\n',
  '    ',
  '=====\n',
  '1. ',
  '~~~\n',
  '> [!warning] ',
  '$$\n',
  '%%\n',
  '- [?] ',
  '^[n] ',
  '[^1]',
  '</p>\n',
  '</details>\n',
  '<details open>\n',
  '\n<div align="center">\n\n',
  '\n</div>\n\n',
  '::: note\n',
  ':::\n',
  '!!! tip\n',
  ': ',
  '+---+\n',
  '*[A]: b\n',
];

/** Block-feature decorations as comparable strings. */
function blockDrawing(state: EditorState): string[] {
  return drawnLines(
    state,
    (d) => d.feature !== 'emphasis' && !(d.feature === 'html' && (d.kind === 'mark' || d.kind === 'hide')),
  );
}

describe('a partial redraw', () => {
  for (const mode of ['edit', 'view'] as const) {
    it(`gives what a full redraw gives, over random edits and cursor moves (${mode})`, () => {
      const { ctx } = fakeContext();
      const rng = new Rng(mode === 'edit' ? 7 : 11);
      expectSameAsFresh({
        start: withFullTree(createEditorState({ ctx, text: start, mode, selection: { anchor: 0, head: 0 } })),
        steps: 150,
        edit: (state) => randomEdit(state, rng, snippets, true),
        fresh: (state) => {
          const fresh = freshState(state, ctx, mode);
          // A contents list draws the headings as last read, which a view reads again after a
          // pause and a headless state never does: the fresh state is given the same ones.
          const headings = state.field(headingsField, false);
          return headings
            ? fresh.update({ effects: [setHeadings.of(headings), redrawFeatureEffect.of('contents')] }).state
            : fresh;
        },
        read: blockDrawing,
      });
    });
  }
});
