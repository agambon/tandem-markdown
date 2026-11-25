// Hard line breaks are read by our own parser (src/panel/markdown/hardBreak.ts), which must give
// exactly the tree lezer's own parser gives, without looking along a run of spaces again from
// each of its spaces.
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import type { Tree } from '@lezer/common';
import { GFM, type MarkdownParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { markdownParser } from '../../../src/panel/markdown';
import { Footnote } from '../../../src/panel/markdown/footnote';
import { Frontmatter } from '../../../src/panel/markdown/frontmatter';
import { Highlight } from '../../../src/panel/markdown/highlight';
import { Wikilink } from '../../../src/panel/markdown/wikilink';
import { drawn, stateOf } from '../helpers';

/** The same syntax with lezer's own hard break parser. */
const lezerParser: MarkdownParser = (commonmarkLanguage.parser as MarkdownParser)
  .configure(Frontmatter)
  .configure([GFM, Wikilink, Highlight, Footnote]);

function nodes(tree: Tree): string {
  const out: string[] = [];
  tree.iterate({ enter: (n) => void out.push(`${n.name}:${n.from}-${n.to}`) });
  return out.join(' ');
}

const same = (text: string) =>
  expect(nodes(markdownParser.parse(text)), JSON.stringify(text)).toBe(nodes(lezerParser.parse(text)));

describe('hard line breaks', () => {
  const cases = [
    'a  \nb',
    'a \nb',
    'a   x  \nb',
    'a\\\nb',
    'a  ',
    'a  \n',
    '`code  `  \nb',
    '**b**  \nc',
    '> q  \n> r',
    '- i  \n  j',
    '| a  | b |\n| --- | --- |\n| c  | d  |',
    'a \t \nb',
    '# Title  \nnext',
    'a&amp;  \nb',
    '[link](x)  \nb',
    '==mark==  \nb',
    '[[Note]]  \nb',
    'one  two   three    \nfour',
  ];
  for (const text of cases) it(`give lezer's tree: ${JSON.stringify(text)}`, () => same(text));

  it("give lezer's tree over random text made of what a break is made of", () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const pieces = [' ', ' ', ' ', '\n', 'a', '\\', '*', '`', '> ', '- ', '|', '\t', '='];
    for (let run = 0; run < 3000; run++) {
      let text = '';
      for (let i = 0, n = 1 + Math.floor(next() * 30); i < n; i++) text += pieces[Math.floor(next() * pieces.length)];
      same(text);
    }
  });

  it('a line of 100,000 spaces parses (each run of spaces is looked along once)', () => {
    const text = `Some text\nx${' '.repeat(100_000)}y\n`;
    expect(markdownParser.parse(text).length).toBe(text.length);
  });

  it('a line of 100,000 spaces before an image draws (the image is not looked at as alone on its line)', () => {
    const text = `Some text\n${' '.repeat(100_000)}x ![](pic.png)\n`;
    expect(drawn(stateOf(text)).some((d) => d.feature === 'images')).toBe(true);
  });
});
