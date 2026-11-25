import type { SyntaxNode } from '@lezer/common';
import { describe, expect, it } from 'vitest';
import {
  headingDown,
  headingUp,
  insertCodeBlock,
  insertImageText,
  insertRule,
  setHeading,
  toggleQuote,
} from '../../../src/panel/commands/blocks';
import { placeBlock } from '../../../src/panel/commands/placeBlock';
import { markdownParser } from '../../../src/panel/markdown';
import { parseMarked } from '../helpers';
import { expectCase, marked, run, stateWith } from './helpers';

type Case = [name: string, before: string, after: string | null];

/** The quotes and list items holding `pos` in `doc`, each named by where it starts. */
function holders(doc: string, pos: number): string[] {
  const out: string[] = [];
  for (let n: SyntaxNode | null = markdownParser.parse(doc).resolveInner(pos, 1); n; n = n.parent)
    if (n.name === 'Blockquote' || n.name === 'ListItem') out.unshift(`${n.name} at ${n.from}`);
  return out;
}

describe('setHeading', () => {
  const cases: [string, number, string, string | null][] = [
    ['a paragraph becomes a heading', 2, 'Te‸xt', '## Te‸xt'],
    ['a heading changes level', 3, '# Ti‸tle', '### Ti‸tle'],
    ['the same level changes nothing', 1, '# Ti‸tle', null],
    ['a closing run follows the level', 3, '## Ti‸tle ##', '### Ti‸tle ###'],
    ['level 0 makes a paragraph', 0, '# Ti‸tle', 'Ti‸tle'],
    ['level 0 drops a closing run', 0, '## Ti‸tle ##', 'Ti‸tle'],
    ['a new paragraph stays apart from the text around it', 0, 'Before\n# Ti‸tle\nAfter', 'Before\n\nTi‸tle\n\nAfter'],
    ['a Setext heading is rewritten in # form', 2, 'Ti‸tle\n===', '## Ti‸tle'],
    ['a two-line Setext heading joins into one line', 3, 'One‸\ntwo\n---', '### One‸ two'],
    ['a Setext heading becomes a paragraph', 0, 'Ti‸tle\n===', 'Ti‸tle'],
    ['a Setext heading over text keeps a blank line', 0, 'Ti‸tle\n===\nNext', 'Ti‸tle\n\nNext'],
    ['in a list item, after the marker', 2, '- It‸em', '- ## It‸em'],
    ['in a quote, after the mark', 1, '> Te‸xt', '> # Te‸xt'],
    [
      'a new paragraph beside a quote in a list item stays in both',
      0,
      '- > # Ti‸tle\n  > After',
      '- > Ti‸tle\n  >\n  > After',
    ],
    [
      'a Setext heading in a quote in a list item becomes a paragraph in both',
      0,
      '- > Before\n  > Ti‸tle\n  > ===\n  > After',
      '- > Before\n  > Ti‸tle\n  >\n  > After',
    ],
    ['every touched line, skipping blank ones', 1, '«One\n\nTwo»', '# «One\n\n# Two»'],
    ['a code block line is left alone', 1, '```\nco‸de\n```', null],
    ['text and part of a code block are left alone', 1, '«Text\n```\nco»de\n```', null],
    ['a rule is left alone', 1, '‸---', null],
  ];
  for (const [name, level, before, expected] of cases)
    it(name, () => expectCase(setHeading, before, expected, { level }));

  it('refuses a level outside 0 to 6', () => {
    expect(run(setHeading, 'Te‸xt', { level: 7 })).toBeNull();
    expect(run(setHeading, 'Te‸xt', {})).toBeNull();
  });

  it('a heading that becomes a paragraph parses as its own paragraph', () => {
    const out = run(setHeading, 'Before\n# Ti‸tle\nAfter', { level: 0 })!;
    const doc = parseMarked(out).doc;
    const tree = markdownParser.parse(doc);
    const paragraphs: string[] = [];
    tree.iterate({ enter: (n) => void (n.name === 'Paragraph' && paragraphs.push(doc.slice(n.from, n.to))) });
    expect(paragraphs).toEqual(['Before', 'Title', 'After']);
  });
});

describe('headingUp and headingDown', () => {
  const cases: [string, typeof headingUp, string, string | null][] = [
    ['up: a paragraph becomes Heading 1', headingUp, 'Te‸xt', '# Te‸xt'],
    ['up: Heading 2 becomes Heading 3', headingUp, '## Te‸xt', '### Te‸xt'],
    ['up: Heading 6 stays', headingUp, '###### Te‸xt', null],
    ['up: a Setext heading is rewritten', headingUp, 'Te‸xt\n---', '### Te‸xt'],
    ['down: Heading 3 becomes Heading 2', headingDown, '### Te‸xt', '## Te‸xt'],
    ['down: Heading 1 becomes a paragraph', headingDown, '# Te‸xt', 'Te‸xt'],
    ['down: a paragraph stays', headingDown, 'Te‸xt', null],
  ];
  for (const [name, command, before, expected] of cases) it(name, () => expectCase(command, before, expected));
});

describe('toggleQuote', () => {
  const cases: Case[] = [
    ['quotes a line', 'Te‸xt', '> Te‸xt'],
    ['quotes paragraphs as one quote', '«One\n\nTwo»', '> «One\n>\n> Two»'],
    ['unquotes', '> «One\n>\n> Two»', '«One\n\nTwo»'],
    ['takes one level off a nested quote', '> > Te‸xt', '> Te‸xt'],
    ['starts a quote on an empty line', 'Above\n\n‸\n\nBelow', 'Above\n\n> ‸\n\nBelow'],
    ['quotes a list item with its marker', '- It‸em', '> - It‸em'],
    ['a lazy line is already in the quote, so it unquotes', '«> One\nTwo»', '«One\nTwo»'],
    ['quotes the unquoted lines of a mixed selection', '«> One\n\nTwo»', '«> One\n>\n> Two»'],
    // A mark at the start of a line inside a code block becomes code.
    ['a line inside a fenced code block is left alone', '```\nco‸de\n```', null],
    ['a code line in a quoted code block keeps its mark', '> ```\n> co‸de\n> ```', null],
    ['text and part of a code block are left alone', '«Text\n```\nco»de\n```', null],
    ['a line of an indented code block is left alone', 'Para\n\n    co‸de\n    more', null],
    ['a line inside an HTML block is left alone', '<div>\nte‸xt\n</div>', null],
    ['a whole code block is quoted with its fences', '«```\ncode\n```»', '> «```\n> code\n> ```»'],
  ];
  for (const [name, before, expected] of cases) it(name, () => expectCase(toggleQuote, before, expected));
});

describe('insertCodeBlock', () => {
  const cases: Case[] = [
    ['wraps the selected lines', '«one\ntwo»', '```\n«one\ntwo»\n```'],
    ['uses a longer fence than the backticks inside', '«a ``` b»', '````\n«a ``` b»\n````'],
    ['adds blank lines where its neighbors have text', 'Above\n«code»\nBelow', 'Above\n\n```\n«code»\n```\n\nBelow'],
    ['inserts an empty block on an empty line', '‸', '```\n‸\n```'],
    ['inserts an empty block below a line of text', 'Te‸xt', 'Text\n\n```\n‸\n```'],
    ['inside a list item, at the item indent', '- It‸em', '- Item\n  ```\n  ‸\n  ```'],
    ['in a tight list, with no blank line around it', '- a‸\n- b', '- a\n  ```\n  ‸\n  ```\n- b'],
    [
      'wraps a line of a list item with no blank line around it',
      '- a\n  «more»\n- b',
      '- a\n  ```\n«  more»\n  ```\n- b',
    ],
    ['inside a quote, quoted', '> Te‸xt', '> Text\n>\n> ```\n> ‸\n> ```'],
    ['inside a quote in a list item, in both', '- > Te‸xt', '- > Text\n  >\n  > ```\n  > ‸\n  > ```'],
    ['on an empty list item, after its marker', '- ‸', '- ```\n  ‸\n  ```'],
    ['wraps a list item holding a quote, marker and all', '- > «Text»', '```\n«- > Text»\n```'],
    [
      'wraps a nested list item inside the item holding it',
      '- outer\n  - «inner»',
      '- outer\n  ```\n«  - inner»\n  ```',
    ],
    ['inside a code block does nothing', '```\nco‸de\n```', null],
  ];
  for (const [name, before, expected] of cases) it(name, () => expectCase(insertCodeBlock, before, expected));

  it('wraps a whole list item when its marker line is wrapped', () => {
    expect(run(insertCodeBlock, '«- a»\n  more\n- b')).toBe('```\n«- a\n  more»\n```\n\n- b');
    expect(run(insertCodeBlock, '«10. > quote»\n    > more')).toBe('```\n«10. > quote\n    > more»\n```');
    expect(run(insertCodeBlock, '> «- a»\n>   more')).toBe('> ```\n«> - a\n>   more»\n> ```');
  });

  it('wraps a lazy line in what it runs on in, giving it the marks it lacks', () => {
    expect(run(insertCodeBlock, '- a\n«lazy»')).toBe('- a\n  ```\n«  lazy»\n  ```');
    expect(run(insertCodeBlock, '> a\n«lazy»')).toBe('> a\n>\n> ```\n«> lazy»\n> ```');
  });

  it('keeps a wrapped lazy line in the quotes and list items it was in', () => {
    for (const text of [
      '- a\nlazy',
      '- a\nlazy\n- b',
      '- a\n  more\nlazy',
      '> - a\nlazy',
      '> - a\n> lazy',
      '- > a\nlazy',
    ]) {
      const lazy = text.lastIndexOf('lazy');
      const from = text.lastIndexOf('\n', lazy) + 1;
      const end = text.indexOf('\n', lazy) < 0 ? text.length : text.indexOf('\n', lazy);
      const doc = parseMarked(
        run(insertCodeBlock, `${text.slice(0, from)}«${text.slice(from, end)}»${text.slice(end)}`)!,
      ).doc;
      let fence = -1;
      const code: string[] = [];
      markdownParser.parse(doc).iterate({
        enter: (n) => {
          if (n.name === 'FencedCode') fence = n.from;
          if (n.name === 'CodeText') code.push(doc.slice(n.from, n.to));
        },
      });
      expect(holders(doc, fence), text).toEqual(holders(text, lazy));
      expect(code.join('\n'), text).toContain('lazy');
    }
  });

  it('leaves no line of a wrapped list item outside the code', () => {
    // [text, the first and last line selected, the lines that must end up in the code]
    const cases: [string, number, number, string[]][] = [
      ['10. > quote\n    > more', 1, 1, ['10. > quote', '    > more']],
      ['- a\n  more\n- b', 1, 1, ['- a', '  more']],
      ['- a\n  more\n- b\n  bmore', 2, 3, ['  more', '- b', '  bmore']],
      ['- a\n- b\n  bmore\n- c', 1, 2, ['- a', '- b', '  bmore']],
      ['- outer\n  - inner\n    inner more', 2, 2, ['- inner', '  inner more']],
      ['> - a\n>   more', 1, 1, ['- a', '  more']],
    ];
    for (const [text, a, b, inCode] of cases) {
      const lines = text.split('\n');
      const from = lines.slice(0, a - 1).join('\n').length + (a > 1 ? 1 : 0);
      const to = lines.slice(0, b).join('\n').length;
      const doc = parseMarked(
        run(insertCodeBlock, `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`)!,
      ).doc;
      const code: string[] = [];
      let indented = false;
      markdownParser.parse(doc).iterate({
        enter: (n) => {
          if (n.name === 'CodeText') code.push(...doc.slice(n.from, n.to).split('\n'));
          if (n.name === 'CodeBlock') indented = true;
        },
      });
      for (const line of inCode)
        expect(
          code.map((c) => c.trimEnd()),
          `${line} of ${JSON.stringify(text)}`,
        ).toContain(line);
      expect(indented, text).toBe(false);
    }
  });

  it('leaves a tight list tight: no blank line in any list but inside the code', () => {
    // A blank line between a list's items, or between the blocks of one item, makes it loose.
    const blankOutsideCode = (doc: string) => {
      const tree = markdownParser.parse(doc);
      const code: [number, number][] = [];
      const lists: [number, number][] = [];
      tree.iterate({
        enter: (n) => {
          if (n.name === 'FencedCode') code.push([n.from, n.to]);
          if (n.name === 'BulletList' || n.name === 'OrderedList') lists.push([n.from, n.to]);
        },
      });
      let from = 0;
      for (const line of doc.split('\n')) {
        const inList = lists.some(([a, b]) => from > a && from < b);
        const inCode = code.some(([a, b]) => from > a && from < b);
        if (inList && !inCode && /^[>\s]*$/.test(line)) return true;
        from += line.length + 1;
      }
      return false;
    };
    for (const text of [
      '- a‸\n- b',
      '- a\n  b‸\n- c',
      '1. a‸\n2. b',
      '> - a‸\n> - b',
      '- a\n  - b‸\n- c',
      '- a\n- ‸\n- c',
    ]) {
      expect(blankOutsideCode(parseMarked(run(insertCodeBlock, text)!).doc), text).toBe(false);
    }
    expect(blankOutsideCode(parseMarked(run(insertCodeBlock, '- a\n  «b»\n- c')!).doc)).toBe(false);
  });

  it('beside a quote in a list item, the block stays in both and starts no new item', () => {
    for (const command of [insertCodeBlock, insertRule]) {
      const doc = parseMarked(run(command, '- > Te‸xt')!).doc;
      const tree = markdownParser.parse(doc);
      const items: number[] = [];
      let parents: string[] = [];
      tree.iterate({
        enter: (n) => {
          if (n.name === 'ListItem') items.push(n.from);
          if (n.name === 'FencedCode' || n.name === 'HorizontalRule') {
            parents = [];
            for (let p = n.node.parent; p; p = p.parent) parents.push(p.name);
          }
        },
      });
      expect(items).toHaveLength(1);
      expect(parents).toEqual(expect.arrayContaining(['Blockquote', 'ListItem']));
    }
  });

  it('the block it makes parses as a fenced code block holding the lines', () => {
    const doc = parseMarked(run(insertCodeBlock, 'Above\n«a ``` b\nc»\nBelow')!).doc;
    const tree = markdownParser.parse(doc);
    const code: string[] = [];
    tree.iterate({ enter: (n) => void (n.name === 'CodeText' && code.push(doc.slice(n.from, n.to))) });
    expect(code).toEqual(['a ``` b\nc']);
  });
});

describe('insertRule', () => {
  // At the end of a document the rule adds a line for the cursor; with a paragraph below, the
  // line after the rule is the blank one already there. So the first three run on their own.
  const cases: [string, string, string | null, boolean][] = [
    ['below a line of text, after a blank line', 'Te‸xt', 'Text\n\n---\n‸', true],
    ['on an empty line after text, keeping that line blank', 'Text\n‸', 'Text\n\n---\n‸', true],
    ['on an empty line after a blank one, there', 'Text\n\n‸', 'Text\n\n---\n‸', true],
    ['before more text, the cursor between', 'Te‸xt\nNext', 'Text\n\n---\n‸\nNext', false],
    ['onto a following blank line', 'Te‸xt\n\nNext', 'Text\n\n---\n‸\nNext', false],
    ['on an empty line between paragraphs', 'Text\n\n‸\n\nNext', 'Text\n\n---\n‸\nNext', false],
    ['beside a quote in a list item, in both', '- > Te‸xt', '- > Text\n  >\n  > ---\n  > ‸', true],
    ['on an empty list item, straight below its marker', '- ‸', '- \n  ---\n  ‸', true],
    ['after a list item text, *** straight below and the cursor in the item', '- Te‸xt', '- Text\n  ***\n  ‸', true],
    ['in a tight list, *** with no blank line', '- a‸\n- b', '- a\n  ***\n  ‸\n- b', false],
    ['in a numbered list, *** with no blank line', '1. a‸\n2. b', '1. a\n   ***\n   ‸\n2. b', false],
    [
      'in a list item, a blank line below takes the item indent',
      '- Te‸xt\n\n  more',
      '- Text\n  ***\n  ‸\n  more',
      false,
    ],
    ['in a list in a quote, *** straight below and the cursor in both', '> - Te‸xt', '> - Text\n>   ***\n>   ‸', true],
    ['inside a code block does nothing', '```\nco‸de\n```', null, false],
  ];
  for (const [name, before, expected, alone] of cases)
    it(name, () => expectCase(insertRule, before, expected, undefined, { alone }));

  it('after a list item text, a rule in the item and a tight list once a word is typed below it', () => {
    for (const text of ['- a‸\n- b', '1. a‸\n2. b', '> - a‸\n> - b', '- a\n  - b‸\n- c']) {
      const marked = parseMarked(run(insertRule, text)!);
      const head = marked.ranges[0]!.head;
      const typed = marked.doc.slice(0, head) + 'x' + marked.doc.slice(head);
      const lists: [number, number][] = [];
      let ruleInItem = false;
      let setext = false;
      markdownParser.parse(typed).iterate({
        enter: (n) => {
          if (n.name === 'BulletList' || n.name === 'OrderedList') lists.push([n.from, n.to]);
          if (n.name === 'HorizontalRule') ruleInItem = n.node.parent?.name === 'ListItem';
          if (n.name.startsWith('SetextHeading')) setext = true;
        },
      });
      let from = 0;
      let blankInList = false;
      for (const line of typed.split('\n')) {
        if (lists.some(([a, b]) => from > a && from < b) && /^[>\s]*$/.test(line)) blankInList = true;
        from += line.length + 1;
      }
      expect({ ruleInItem, setext, blankInList }, text).toEqual({
        ruleInItem: true,
        setext: false,
        blankInList: false,
      });
    }
  });

  it('what is typed after it stays in the quotes and list items that hold the line', () => {
    for (const text of ['- a', '- a\n\n  b', '- a\n- b', '> - a', '- > a', '1. a\n   - b']) {
      const end = text.indexOf('\n') < 0 ? text.length : text.indexOf('\n');
      const marked = parseMarked(run(insertRule, text.slice(0, end) + '‸' + text.slice(end))!);
      const head = marked.ranges[0]!.head;
      const typed = marked.doc.slice(0, head) + 'TYPED' + marked.doc.slice(head);
      expect(holders(typed, typed.indexOf('TYPED')), text).toEqual(holders(text, end - 1));
    }
  });

  it('never makes a Setext heading of the text above', () => {
    for (const before of ['Te‸xt', 'Text\n‸', 'Te‸xt\nNext']) {
      const doc = parseMarked(run(insertRule, before)!).doc;
      const tree = markdownParser.parse(doc);
      const names: string[] = [];
      tree.iterate({ enter: (n) => void names.push(n.name) });
      expect(names).toContain('HorizontalRule');
      expect(names.some((n) => n.startsWith('SetextHeading'))).toBe(false);
    }
  });
});

describe('insertImageText', () => {
  it('inserts the image with the cursor in the alt text', () => {
    expect(marked(insertImageText(stateWith('a ‸ b'), 'img/x.png')!.state)).toBe('a ![‸](img/x.png) b');
  });
  it('selected text becomes the alt text', () => {
    expect(marked(insertImageText(stateWith('a «chart» b'), 'chart.png')!.state)).toBe('a ![chart‸](chart.png) b');
  });
  it('a path with a space goes in angle brackets', () => {
    expect(marked(insertImageText(stateWith('‸'), 'my pics/a b.png')!.state)).toBe('![‸](<my pics/a b.png>)');
  });
  it('does nothing in Rich view', () => {
    expect(insertImageText(stateWith('‸', { mode: 'view' }), 'x.png')).toBeNull();
  });
});

describe('a block from paste or a block command, beside a line in quotes and list items', () => {
  const TEXTS = [
    '- a\n\n  b',
    '- > quote\n  > more',
    '> - a\n>\n>   b',
    '- a\nlazy',
    '> a\nlazy',
    '- outer\n  - inner\n    inner more\n  lazy in inner',
    '>- tight',
    '- a\n- \n- c',
    '1. > a\n   > b',
    '> > - deep\n> >   more',
    '- a\n    deeper',
  ];

  it('sits in the quotes and list items that hold the line', () => {
    for (const text of TEXTS) {
      let from = 0;
      for (const line of text.split('\n')) {
        const end = from + line.length;
        const own = line.trimEnd().length;
        const want = holders(text, own ? from + own - 1 : from);
        const marked = text.slice(0, end) + '‸' + text.slice(end);
        const state = stateWith(marked);
        const placed = placeBlock(state, '```\nPLACED\n```', { from: end, to: end });
        const pasted = state.update({ changes: placed }).state.doc.toString();
        expect(
          holders(pasted, pasted.indexOf('PLACED')),
          `paste after ${JSON.stringify(line)} in ${JSON.stringify(text)}`,
        ).toEqual(want);
        const commanded = parseMarked(run(insertCodeBlock, marked)!).doc;
        let fence = -1;
        markdownParser.parse(commanded).iterate({ enter: (n) => void (n.name === 'FencedCode' && (fence = n.from)) });
        expect(
          holders(commanded, fence),
          `code block after ${JSON.stringify(line)} in ${JSON.stringify(text)}`,
        ).toEqual(want);
        from = end + 1;
      }
    }
  });
});
