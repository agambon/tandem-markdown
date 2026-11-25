// Boxes and what document tools write: fenced blocks and admonitions, attributes and styled
// spans, front matter in TOML and JSON, definition lists, grid tables, abbreviations, code
// fence labels, math in LaTeX's delimiters, tracked changes, content tabs and fenced quotes.

import { Abbreviations } from '../markdown/abbreviations';
import { Boxes, ContentTabs, FencedQuotes } from '../markdown/boxes';
import { CriticMarkup } from '../markdown/criticMarkup';
import { DefinitionLists } from '../markdown/definitions';
import { JsonFrontmatter, TomlFrontmatter } from '../markdown/frontmatter';
import { GridTables } from '../markdown/gridTables';
import { HeadingAttributes } from '../markdown/headingAttributes';
import { DoubledLatexMath, LatexMath } from '../markdown/latexMath';
import { Spans } from '../markdown/spans';
import type { Syntax } from './types';

export const BOXES = [
  {
    id: 'boxes',
    default: true,
    description:
      "Draw `:::` blocks (Pandoc, Quarto, VitePress, Docusaurus) and `!!!` admonitions (MkDocs) as boxes; a name such as `note` or `warning` gives a callout's look, and `??? note` folds.",
    parse: [Boxes],
    draw: ['boxes'],
  },
  {
    id: 'headingAttributes',
    default: true,
    description:
      "Hide attributes in braces after a heading, `## Title {#intro}` (Pandoc, kramdown, Hugo), and take the `#id` as the heading's link address.",
    parse: [HeadingAttributes],
    draw: ['headingAttributes'],
  },
  {
    id: 'spans',
    default: true,
    description:
      "Draw Pandoc's styled spans, `[text]{.underline}`, `{.smallcaps}` and `{.mark}`, and hide the bookmarks Word leaves, `[]{#_Toc12 .anchor}`, which links still jump to.",
    parse: [Spans],
    draw: ['spans'],
  },
  {
    id: 'tomlFrontmatter',
    default: true,
    description:
      'Draw TOML front matter, between `+++` lines at the top of a file (Hugo), as a table, as YAML front matter is drawn.',
    parse: [TomlFrontmatter],
    draw: [],
  },
  {
    id: 'jsonFrontmatter',
    default: false,
    description:
      'Draw JSON front matter at the top of a file, between `;;;` lines (GitLab) or as a bare `{…}` object (Hugo), as a table.',
    parse: [JsonFrontmatter],
    draw: [],
  },
  {
    id: 'definitionLists',
    default: true,
    description:
      'Draw definition lists, a term on its own line and then `: Its definition` (Pandoc, PHP Markdown Extra, kramdown), with the term in bold.',
    parse: [DefinitionLists],
    draw: ['definitions'],
  },
  {
    id: 'gridTables',
    default: true,
    description:
      "Draw Pandoc's grid tables, ruled with lines such as `+------+------+`, as tables. Their cells can hold paragraphs and lists, and are edited in the source.",
    parse: [GridTables],
    draw: ['gridTables'],
  },
  {
    id: 'abbreviations',
    default: true,
    description:
      'Read abbreviation definitions, `*[HTML]: Hyper Text Markup Language` (PHP Markdown Extra, Python-Markdown, kramdown): the abbreviation shows what it stands for as a tooltip wherever it appears, and the definition is left out of Rich view.',
    parse: [Abbreviations],
    draw: ['abbreviations'],
  },
  {
    id: 'codeFenceLabels',
    default: true,
    description:
      'Read a code block\'s language from braces or words after its fence (`{.python}`, `{r}`, `js{1,4}`), as Pandoc, Quarto and VitePress write it, and show a `title="…"` it gives in its header.',
    parse: [],
    draw: [],
    codeLanguage: true,
  },
  {
    id: 'latexMath',
    default: true,
    description:
      "Draw math in LaTeX's delimiters: `\\(…\\)` in a line and `\\[…\\]` as a paragraph of its own, as chat assistants write them, and environments such as `\\begin{align}` (Jupyter). Drawn while `math` is on.",
    parse: [LatexMath],
    draw: [],
  },
  {
    id: 'doubledLatexMath',
    default: false,
    description:
      'Draw math written with doubled backslashes, `\\\\(…\\\\)` and `\\\\[…\\\\]`, as MultiMarkdown and Jupyter write it. Drawn while `math` is on.',
    parse: [DoubledLatexMath],
    draw: [],
  },
  {
    id: 'criticMarkup',
    default: false,
    description:
      'Draw tracked-change marks (CriticMarkup, as MultiMarkdown writes them): `{++added++}`, `{--deleted--}`, `{~~old~>new~~}`, `{==marked==}` and `{>>comments<<}`.',
    parse: [CriticMarkup],
    draw: ['criticMarkup'],
  },
  {
    id: 'contentTabs',
    default: false,
    description:
      'Draw MkDocs content tabs, `=== "Tab"` over an indented body, each as a box under its title. Drawn while `boxes` is on.',
    parse: [ContentTabs],
    draw: [],
  },
  {
    id: 'fencedQuotes',
    default: false,
    description: "Draw GitLab's quote between `>>>` lines as a quote. Drawn while `boxes` is on.",
    parse: [FencedQuotes],
    draw: [],
  },
] as const satisfies readonly Syntax[];
