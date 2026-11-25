// The outline's headings.
import { GFM, parser as baseParser } from '@lezer/markdown';
import fc from 'fast-check';
import { nameToEmoji } from 'gemoji';
import { describe, expect, it } from 'vitest';
import { buildOutline, sameHeadings } from '../../src/core/outline';
import { outlineHas, slugOf } from '../../src/host/model/headingAnchors';
import { seeded } from '../random';

const gfm = baseParser.configure(GFM);

const texts = (md: string) => buildOutline(md).map((h) => [h.level, h.text]);

describe('buildOutline', () => {
  it('finds ATX headings at every level, with their line and offset', () => {
    const md = '# One\ntext\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n####### not seven\n';
    const items = buildOutline(md);
    expect(items.map((h) => [h.level, h.text])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
      [4, 'Four'],
      [5, 'Five'],
      [6, 'Six'],
    ]);
    expect(items[1]).toEqual({ level: 2, text: 'Two', line: 2, from: md.indexOf('## Two') });
  });

  it('strips closing hashes, but not hashes that belong to the text', () => {
    expect(texts('# Title ##\n## Title #   \n# C# #\n# foo#\n# foo \\#\n### ###\n')).toEqual([
      [1, 'Title'],
      [2, 'Title'],
      [1, 'C#'],
      [1, 'foo#'],
      [1, 'foo #'],
      [3, ''],
    ]);
  });

  it('leaves out attributes in braces after an ATX heading, and keeps their id', () => {
    const items = buildOutline(
      '# Intro {#intro .big}\n## Preface {-}\n## Kept {}\n## Title ## {: #t}\n## A [span]{.mark}\n',
    );
    expect(items.map((h) => [h.text, h.id])).toEqual([
      ['Intro', 'intro'],
      ['Preface', undefined],
      ['Kept {}', undefined],
      ['Title', 't'],
      ['A span', undefined],
    ]);
  });

  it('requires a space after the hashes and at most three spaces of indent', () => {
    expect(texts('#hashtag\n   # three spaces\n    # four spaces is code\n\t# tab is code\n')).toEqual([
      [1, 'three spaces'],
    ]);
  });

  it('finds Setext headings, from the first line of their paragraph', () => {
    const md = 'Intro\n\nTitle one\n===\n\nTitle\ntwo\n---\n';
    const items = buildOutline(md);
    expect(items.map((h) => [h.level, h.text, h.line])).toEqual([
      [1, 'Title one', 2],
      [2, 'Title two', 5],
    ]);
    expect(items[1]!.from).toBe(md.indexOf('Title\ntwo'));
  });

  it('does not take a rule, a list or a table for a Setext heading', () => {
    expect(texts('\n---\n')).toEqual([]);
    expect(texts('- item\n---\n')).toEqual([]);
    expect(texts('> quote\n---\n')).toEqual([]);
    expect(texts('| a | b |\n---\n')).toEqual([[2, '| a | b |']]); // no delimiter row: a paragraph, so a heading
    expect(texts('Para\n2. not a list\n---\n')).toEqual([[2, 'Para 2. not a list']]);
    expect(texts('Para\n- a list\n---\n')).toEqual([]);
  });

  it('skips fenced code, backtick or tilde, until a fence at least as long', () => {
    const md = [
      '# Before',
      '```',
      '# in code',
      '```',
      '~~~~',
      '# in tilde',
      '~~~',
      '# still in tilde',
      '~~~~',
      '# After',
      '````md',
      '```',
      '# inner',
      '````',
      '# Last',
    ].join('\n');
    expect(texts(md)).toEqual([
      [1, 'Before'],
      [1, 'After'],
      [1, 'Last'],
    ]);
  });

  it('runs an unclosed fence to the end', () => {
    expect(texts('# A\n```\n# B\n')).toEqual([[1, 'A']]);
  });

  it('skips front matter on the first line, closed by --- or ...', () => {
    expect(texts('---\ntitle: x\n# comment\n---\n# Real\n')).toEqual([[1, 'Real']]);
    expect(texts('---\ntitle: x\n# comment\n...\n# Real\n')).toEqual([[1, 'Real']]);
    expect(texts('\n---\ntitle: x\n# not frontmatter\n---\n')).toEqual([[1, 'not frontmatter']]);
    expect(texts('---\n# no closing fence\n')).toEqual([[1, 'no closing fence']]);
  });

  it('skips TOML front matter between +++ lines, whose comments start with #', () => {
    expect(texts('+++\ntitle = "x"\n# a comment\n+++\n# Real\n')).toEqual([[1, 'Real']]);
  });

  it('skips HTML comments and HTML blocks', () => {
    expect(texts('<!--\n# hidden\n-->\n# Shown\n')).toEqual([[1, 'Shown']]);
    expect(texts('<details>\n# inside html\n\n# After\n')).toEqual([[1, 'After']]);
  });

  it('reduces inline markdown to what a reader sees', () => {
    expect(
      texts(
        [
          '# **Bold** and *italic* and _under_ and __strong__',
          '# `code *not italic*` here',
          '# A [link](https://x.y "t") and ![alt text](i.png)',
          '# Ref [text][r] and <https://example.com>',
          '# [[Page]] and [[Page|Alias]] and [[Page#Part]]',
          '# snake_case_name stays',
          '# ~~gone~~ ==marked== \\*literal\\*',
          '# ***both***',
        ].join('\n'),
      ),
    ).toEqual([
      [1, 'Bold and italic and under and strong'],
      [1, 'code *not italic* here'],
      [1, 'A link and alt text'],
      [1, 'Ref text and https://example.com'],
      [1, 'Page and Alias and Page > Part'],
      [1, 'snake_case_name stays'],
      [1, 'gone marked *literal*'],
      [1, 'both'],
    ]);
  });

  it('reads entities, HTML and comments as the page shows them, keeping the text anchors are made from', () => {
    const [heading] = buildOutline('## Tom &amp; <kbd>Jerry</kbd> %%draft%% <!-- x -->\n');
    expect(heading!.text).toBe('Tom & Jerry');
    expect(heading!.anchorText).toBe('Tom &amp; <kbd>Jerry</kbd> %%draft%% <!-- x -->');
    expect(buildOutline('# Plain **bold**\n')[0]!.anchorText).toBeUndefined();
  });

  it('shows emoji codes as their emoji with the emoji list, keeping the anchor the typed text makes', () => {
    const md = '## Launch :rocket:\n\nLaunch :rocket:\n---\n## Run `:rocket:`\n';
    const plain = buildOutline(md);
    const drawn = buildOutline(md, { names: nameToEmoji });
    expect(plain.map((h) => h.text)).toEqual(['Launch :rocket:', 'Launch :rocket:', 'Run :rocket:']);
    expect(drawn.map((h) => [h.text, h.anchorText])).toEqual([
      ['Launch 🚀', 'Launch :rocket:'],
      ['Launch 🚀', 'Launch :rocket:'],
      ['Run :rocket:', undefined],
    ]);
    // GitHub's anchor of `## Launch :rocket:` is `launch-rocket`, with the list or without it.
    for (const outline of [plain, drawn]) {
      expect(slugOf(outline[0]!.anchorText ?? outline[0]!.text)).toBe('launch-rocket');
      expect(outlineHas(outline, 'launch-rocket')).toBe(true);
    }
  });

  it('keeps a formula exactly as typed, its anchor made from the text read without math', () => {
    const [heading] = buildOutline('## The $a*b*c$ case\n');
    expect(heading!.text).toBe('The $a*b*c$ case');
    expect(heading!.anchorText).toBe('The $abc$ case');
    expect(slugOf(heading!.anchorText!)).toBe('the-abc-case');
  });

  it('returns nothing for text without headings', () => {
    expect(buildOutline('')).toEqual([]);
    expect(buildOutline('just text\nand more\n')).toEqual([]);
  });

  it('lists headings inside block quotes and list items, as the panel draws them', () => {
    expect(
      buildOutline('> # Quoted\n- ## In item\n- item\n\n    ### Continued\n\n1. x\n   Setext in item\n   ---\n').map(
        (h) => [h.level, h.text, h.line],
      ),
    ).toEqual([
      [1, 'Quoted', 0],
      [2, 'In item', 1],
      [3, 'Continued', 4],
      [2, 'x Setext in item', 6],
    ]);
    expect(buildOutline('> Two line\n> setext\n> ===\n')[0]).toEqual({
      level: 1,
      text: 'Two line setext',
      line: 0,
      from: 0,
    });
  });

  it('finds the headings the panel parser finds (@lezer/markdown with GFM), each at its line start', () => {
    const line = fc.constantFrom(
      '# H1',
      '## H2 ##',
      '#nohash',
      '   # three',
      '    # code',
      '\t# tab',
      '```',
      '````',
      '~~~',
      '``` js',
      '`` `x',
      'para',
      'more text',
      '===',
      '---',
      '- - -',
      '***',
      '',
      '',
      '- item',
      '1. item',
      '2) item',
      '> quote',
      '<!-- c -->',
      '<!--',
      '-->',
      '<div>',
      '</div>',
      '<span>',
      '| a | b |',
      '| --- | --- |',
      'a | b',
      '  ---',
    );
    const doc = fc.array(line, { maxLength: 30 }).map((ls) => ['start', ...ls].join('\n'));
    fc.assert(
      fc.property(doc, (md) => {
        const starts = [0];
        for (let i = 0; i < md.length; i++) if (md[i] === '\n') starts.push(i + 1);
        const lineOf = (pos: number) => {
          let l = 0;
          while (l + 1 < starts.length && starts[l + 1]! <= pos) l++;
          return l;
        };
        const expected: [number, number][] = [];
        gfm.parse(md).iterate({
          enter(node) {
            const m = /^(?:ATXHeading(\d)|SetextHeading(\d))$/.exec(node.name);
            if (m) expected.push([Number(m[1] ?? m[2]), lineOf(node.from)]);
          },
        });
        const items = buildOutline(md);
        expect(items.map((h) => [h.level, h.line])).toEqual(expected);
        for (const h of items) expect(h.from).toBe(starts[h.line]);
      }),
      seeded({ numRuns: 3000 }),
    );
  });
});

describe('sameHeadings', () => {
  const at = (level: number, line: number, text: string) => ({ level, text, line, from: line * 10 });

  it('compares levels and texts, not where they are', () => {
    expect(sameHeadings([at(1, 0, 'A'), at(2, 3, 'B')], [at(1, 1, 'A'), at(2, 9, 'B')])).toBe(true);
    expect(sameHeadings([at(1, 0, 'A')], [at(2, 0, 'A')])).toBe(false);
    expect(sameHeadings([at(1, 0, 'A')], [at(1, 0, 'B')])).toBe(false);
    expect(sameHeadings([at(1, 0, 'A')], [])).toBe(false);
  });
});
