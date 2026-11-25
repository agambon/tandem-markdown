// Wikilinks, highlight, footnotes, tags, emoji codes, callouts and math.

import { Emoji } from '../markdown/emoji';
import { Footnote } from '../markdown/footnote';
import { Highlight } from '../markdown/highlight';
import { DollarMath } from '../markdown/math';
import { Tag } from '../markdown/tag';
import { Wikilink, WikilinkTextFirst } from '../markdown/wikilink';
import { OFF, type Syntax } from './types';

export const FOUNDATION = [
  {
    id: 'wikilinks',
    default: 'noteFirst',
    description:
      'Draw `[[wikilinks]]` as links, and pictures embedded with `![[picture.png]]`: `noteFirst` reads the note before the bar, as Obsidian, Foam and Bear write them; `textFirst` reads the shown text first, as Dendron and GitLab wikis do; `off` shows them as typed.',
    choices: [
      {
        value: 'noteFirst',
        description: '`[[note|shown text]]`, as Obsidian, Foam and Bear write them.',
        parse: [Wikilink],
        draw: ['wikilinks'],
      },
      {
        value: 'textFirst',
        description: '`[[shown text|note]]`, as Dendron and GitLab wikis write them.',
        parse: [WikilinkTextFirst],
        draw: ['wikilinks'],
      },
      { value: OFF, description: 'As typed.', parse: [], draw: [] },
    ],
  },
  {
    id: 'highlight',
    default: true,
    description: 'Draw `==text==` as highlighted text.',
    parse: [Highlight],
    draw: [],
  },
  {
    id: 'footnotes',
    default: true,
    description:
      "Draw footnotes: a reference, `[^1]`, as its note's number, the note numbered where it stands, and notes written in place, `^[text]`.",
    parse: [Footnote],
    draw: ['footnotes'],
  },
  {
    id: 'tags',
    default: true,
    description:
      "Draw `#tags` as labels, by Obsidian's rule (a color code such as `#ff0000` is a tag; `#123` is not). Ctrl+click (Cmd+click on a Mac) searches the workspace for the tag.",
    parse: [Tag],
    draw: ['tags'],
  },
  {
    id: 'emoji',
    default: true,
    description: "Draw emoji codes on GitHub's list, such as `:smile:`, as the emoji.",
    parse: [Emoji],
    draw: ['emoji'],
  },
  {
    id: 'callouts',
    default: true,
    description: "Draw GitHub's alerts and Obsidian's callouts, `> [!NOTE]`, as boxes. Off shows them as quotes.",
    parse: [],
    draw: ['callouts'],
  },
  {
    id: 'math',
    default: true,
    description:
      'Draw math: `$…$` in a line (prices such as `$5 and $10` stay text), `$$…$$` blocks and `math` code blocks.',
    parse: [DollarMath],
    draw: ['math'],
    fences: ['math'],
  },
] as const satisfies readonly Syntax[];
