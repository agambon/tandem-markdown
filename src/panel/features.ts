// Everything the panel's editor does, as a list of features (docs/ARCHITECTURE.md, "Features
// and their order"). The order is precedence: where two features' decorations meet, the
// earlier one's are drawn inside the later one's, and an earlier replacement wins.
//
// Adding a feature: export a `Feature` from its own file, import it here and add it to the
// list. `editor.ts` builds every editor state from the list, commands included.

import type { Extension } from '@codemirror/state';
import { outsideAnnounce } from './announce';
import { blockCommands } from './commands/blocks';
import { inlineCommands } from './commands/inline';
import { listCommands } from './commands/lists';
import type { PanelCommand } from './commands/registry';
import { typing } from './commands/typing';
import { insertMenu } from './complete/insertMenu';
import { wikilinkCompletion } from './complete/wikilinks';
import type { PanelContext } from './context';
import { fieldCommands } from './focus';
import { paste } from './paste';
import { abbreviations } from './render/abbreviations';
import { blockIds } from './render/blockIds';
import { boxes } from './render/boxes';
import { callouts } from './render/callouts';
import { changeMarks } from './render/changeMarks';
import { code } from './render/code';
import { comments } from './render/comments';
import { conflicts } from './render/conflicts';
import { contents } from './render/contents';
import { criticMarkup } from './render/criticMarkup';
import { definitions } from './render/definitions';
import { diagnostics } from './render/diagnostics';
import { diagrams } from './render/diagrams';
import { embeds } from './render/embeds';
import { emoji } from './render/emoji';
import { emphasis } from './render/emphasis';
import { footnotes } from './render/footnotes';
import { frontmatter } from './render/frontmatter';
import { gridTables } from './render/gridTables';
import { headingAttributes } from './render/headingAttributes';
import { headingFolds } from './render/headingFolds';
import { headings } from './render/headings';
import { html } from './render/html';
import { htmlBlocks } from './render/htmlBlocks';
import { images } from './render/images';
import { links } from './render/links';
import { lists } from './render/lists';
import { math } from './render/math';
import { outsideMark } from './render/outsideMark';
import { quotes } from './render/quotes';
import { rules } from './render/rules';
import { spacing } from './render/spacing';
import { spans } from './render/spans';
import { tags } from './render/tags';
import { wikilinks } from './render/wikilinks';
import { tableCommands } from './tables/commands';
import { tables } from './tables/tables';
import { linkCard } from './ui/linkCard';
import { noteCard } from './ui/noteCard';
import { problemCard } from './ui/problemCard';
import { renameBox } from './ui/rename';
import { reveal } from './ui/reveal';
import { search } from './ui/search';
import { tabFocus } from './ui/tabFocus';
import { toolbar } from './ui/toolbar';
import { viewKeys } from './ui/viewKeys';

export interface Feature {
  id: string;
  /** What the feature adds to each editor state. */
  extension?(ctx: PanelContext): Extension;
  /** The panel commands it provides, by id (`commands/registry.ts`). */
  commands?: Readonly<Record<string, PanelCommand>>;
}

export const features: Feature[] = [
  frontmatter,
  // Heading folds before other blocks so a folded heading hides tables, drawn blocks and <details> inside it.
  headingFolds,
  // HTML blocks before the other blocks, so a folded <details> hides what they draw inside it.
  htmlBlocks,
  tables,
  gridTables,
  headings,
  headingAttributes,
  // Footnotes, whose numbers stand in for notes written in place, before what such a note holds.
  footnotes,
  // Formulas, tags and emoji, before emphasis and links so that their marks hold them.
  math,
  diagrams,
  conflicts,
  contents,
  embeds,
  blockIds,
  tags,
  emoji,
  emphasis,
  // Links and images, after emphasis so a link's mark holds the emphasis inside its text.
  images,
  links,
  wikilinks,
  // Styled spans, after links and emphasis so that their style holds what is inside.
  spans,
  criticMarkup,
  abbreviations,
  // The hover cards: the note card first, so the start of a note sits above the address and
  // Open in the one card; a problem's card below them.
  noteCard,
  linkCard,
  problemCard,
  // `[[` completion and the insert menu on `/`, and Rich view from the keyboard (Tab between
  // links and checkboxes).
  wikilinkCompletion,
  insertMenu,
  viewKeys,
  // Lists, quotes (callouts and boxes set the colors of the quotes they are drawn as), code
  // and the other blocks.
  lists,
  definitions,
  callouts,
  boxes,
  quotes,
  code,
  rules,
  html,
  comments,
  spacing,
  // Lines changed from outside, outlined until seen and told to a screen reader; what VS Code
  // knows of the document: its problems, underlined, and the lines changed since the last
  // commit, in the margin.
  outsideMark,
  outsideAnnounce,
  diagnostics,
  changeMarks,
  // Find and replace, the rename box, paste and copy, the typing rules and the toolbar.
  search,
  renameBox,
  paste,
  typing,
  toolbar,
  // Commands with nothing to add to the editor state.
  inlineCommands,
  blockCommands,
  listCommands,
  tableCommands,
  fieldCommands,
  reveal,
  tabFocus,
];
