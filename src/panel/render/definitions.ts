// Definition lists (markdown/definitions.ts), drawn as GitHub's stylesheet draws `<dl>`: the
// term in bold italics, and each definition beneath it, indented (through `--tm-fn`, the
// stylesheet's indent for a block's further lines). The `:` and the indentation of a
// definition's further lines are hidden; the `:` shows, faded, while the cursor is on its line.

import { EditorView } from '@codemirror/view';
import { isSpaceOrTab } from '../../core/markdownText';
import type { Feature } from '../features';
import { blockFeature, type BlockDraw } from './framework';
import { columnInQuotes, containerBase, hideContainerIndent, listLinesIn } from './layout';
import type { BlockEntry } from './lines';

function drawDefinition(d: BlockDraw, block: BlockEntry, top: boolean, items: readonly BlockEntry[]): void {
  const mark = block.node.firstChild;
  if (!mark || mark.name !== 'DefinitionMark') return;
  const line = d.lines.get(block.firstLine);
  let textAt = mark.to;
  while (textAt < line.to && isSpaceOrTab(line.text.charCodeAt(textAt - line.from))) textAt++;
  for (let n = block.firstLine; n <= block.lastLine; n++) d.line(d.lines.start(n), 'tm-dd');
  if (d.lineRevealed(mark.from)) d.mark(mark.from, mark.to, 'tm-mark');
  // At the top level the marker's own indentation goes too; inside a container, that container's.
  else d.hide(top ? line.from : mark.from, textAt);
  const base = containerBase(d, block, mark.from, top);
  hideContainerIndent(d, block, base, columnInQuotes(d, block, textAt) - base, listLinesIn(block, items));
}

export const definitions: Feature = {
  id: 'definitions',
  extension: () => [
    blockFeature('definitions', (d) => {
      const definitions: { block: BlockEntry; top: boolean }[] = [];
      const items: BlockEntry[] = [];
      let list: BlockEntry | null = null;
      d.blocks((block) => {
        if (block.name === 'DefinitionList') {
          list = block;
        } else if (block.name === 'Definition') {
          const holder: BlockEntry | null = list;
          definitions.push({ block, top: holder !== null && holder.top && block.node.parent?.from === holder.from });
        } else if (block.name === 'ListItem') {
          items.push(block);
        } else if (block.name === 'Paragraph' && block.node.parent?.name === 'DefinitionList') {
          // The term: the paragraph that opens the list.
          if (!block.node.prevSibling) d.line(block.from, 'tm-dt');
        }
      });
      for (const { block, top } of definitions) drawDefinition(d, block, top, items);
    }),
    EditorView.baseTheme({
      '& .cm-content .tm-dt': { fontWeight: '600', fontStyle: 'italic' },
      '& .cm-content .tm-dd': { '--tm-fn': '16px' },
    }),
  ],
};
