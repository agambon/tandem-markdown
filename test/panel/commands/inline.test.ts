import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { describe, expect, it } from 'vitest';
import {
  insertLink,
  toggleBold,
  toggleCode,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
} from '../../../src/panel/commands/inline';
import { markdownParser } from '../../../src/panel/markdown';
import { parseMarked } from '../helpers';
import { expectCase, moveCursor, run, runAll, stateWith, typeText } from './helpers';

type Case = [name: string, before: string, after: string | null];

describe('toggleBold', () => {
  const cases: Case[] = [
    ['wraps a selection', 'a «word» b', 'a **«word»** b'],
    ['puts the marks inside trailing spaces', 'a «word »b', 'a **«word»** b'],
    ['puts the marks inside leading spaces', 'a« word» b', 'a **«word»** b'],
    ['keeps a backward selection backward', 'a »word« b', 'a **»word«** b'],
    ['unwraps when the selection is exactly the inside', 'a **«word»** b', 'a «word» b'],
    ['unwraps when the selection is the whole node', 'a «**word**» b', 'a «word» b'],
    ['takes part of the inside out of the bold', '**one «two» three**', '**one** «two» **three**'],
    ['takes the start of the inside out', '**«one» two**', '«one» **two**'],
    ['takes the end of the inside out', '**one «two»**', '**one** «two»'],
    ['partial overlap with bold widens to the bold', 'te«xt **bo»ld**', 'te**«xt bold»**'],
    ['partial overlap from inside the bold', '**bo«ld** te»xt', '**«bold te»**xt'],
    ['merges bold inside the selection', '«a **b** c»', '**«a b c»**'],
    ['wraps each of two paragraphs', '«one\n\ntwo»', '**«one**\n\n**two»**'],
    ['wraps each of two list items after their markers', '- «one\n- two»', '- **«one**\n- **two»**'],
    [
      'wraps each table cell on its own',
      '| «a | b» |\n|---|---|\n| c | d |',
      '| **«a** | **b»** |\n|---|---|\n| c | d |',
    ],
    ['wraps a heading after its mark', '«# Title»', '# **«Title»**'],
    ['wraps the text of a Setext heading', '«Title»\n===', '**«Title»**\n==='],
    ['cuts into a code span: takes the span whole', 'a «b `c»d` e', 'a **«b `cd`»** e'],
    ['inside a link text stays in the text', '[«link»](https://x.y)', '[**«link»**](https://x.y)'],
    ['touching a link address takes the whole link', '[a](«https://x.y»)', '**«[a](https://x.y)»**'],
    ['cursor in a word applies to the word', 'a wo‸rd b', 'a **wo‸rd** b'],
    ['cursor at the end of a word applies to the word', 'a word‸ b', 'a **word‸** b'],
    ['cursor in empty space inserts the pair', 'a ‸ b', 'a **‸** b'],
    ['cursor inside bold unwraps it', 'a **bo‸ld** b', 'a bo‸ld b'],
    ['inside a code span does nothing', 'a `co«de»` b', null],
    ['cursor inside a code span does nothing', 'a `co‸de` b', null],
    ['inside a code block does nothing', '```\nco«de»\n```', null],
    ['in front matter does nothing', '---\nti«tle»: x\n---\n', null],
    // A phrase that spans a line break is one node, unwrapped once.
    [
      'unwraps a phrase that spans a line break',
      '**«this is a long\nbold sentence»** after',
      '«this is a long\nbold sentence» after',
    ],
    [
      'unwraps a two-line phrase selected whole',
      '«**this is a long\nbold sentence**» after',
      '«this is a long\nbold sentence» after',
    ],
    ['takes the middle of a two-line phrase out', '**a «b\nc» d**', '**a** «b\nc» **d**'],
  ];
  for (const [name, before, expected] of cases) {
    it(name, () => expectCase(toggleBold, before, expected, undefined, { alone: before.startsWith('---') }));
  }

  it('gives text that parses as bold at the selection, wherever it wraps', () => {
    for (const [, before, expected] of cases) {
      if (!expected || !expected.includes('**«')) continue;
      const { doc, ranges } = parseMarked(expected);
      const tree = markdownParser.parse(doc);
      let bold = false;
      for (let n: SyntaxNode | null = tree.resolveInner(ranges[0]!.from, 1); n; n = n.parent)
        if (n.name === 'StrongEmphasis') bold = true;
      expect(bold, `${before} gave ${expected}, which is not bold at the selection`).toBe(true);
    }
  });

  it('does nothing in Rich view or on a read-only document', () => {
    expect(run(toggleBold, 'a «word» b', undefined, { mode: 'view' })).toBeNull();
    expect(run(toggleBold, 'a «word» b', undefined, { readOnly: true })).toBeNull();
  });

  it('wraps every selection range', () => {
    expect(run(toggleBold, '«a» and «b»')).toBe('**«a»** and **«b»**');
  });

  it('carries a user event that is not typing, so it is sent at once', () => {
    const tr = toggleBold(stateWith('a «b» c'))!;
    expect(tr.isUserEvent('input.format')).toBe(true);
    expect(tr.isUserEvent('input.type')).toBe(false);
  });
});

describe('the other inline toggles', () => {
  const cases: [string, typeof toggleBold, string, string | null][] = [
    ['italic wraps', toggleItalic, 'a «word» b', 'a *«word»* b'],
    ['italic unwraps', toggleItalic, 'a *«word»* b', 'a «word» b'],
    ['italic inside bold gives both', toggleItalic, '**«word»**', '***«word»***'],
    ['italic splits italic', toggleItalic, '*one «two» three*', '*one* «two» *three*'],
    ['italic cursor in a word', toggleItalic, 'wo‸rd', '*wo‸rd*'],
    ['strikethrough wraps', toggleStrikethrough, 'a «word» b', 'a ~~«word»~~ b'],
    ['strikethrough unwraps', toggleStrikethrough, 'a ~~«word»~~ b', 'a «word» b'],
    ['highlight wraps', toggleHighlight, 'a «word» b', 'a ==«word»== b'],
    ['highlight unwraps with the cursor inside', toggleHighlight, 'a ==wo‸rd== b', 'a wo‸rd b'],
    ['code wraps', toggleCode, 'a «word» b', 'a `«word»` b'],
    ['code uses a longer mark around backticks', toggleCode, 'a «x`y» b', 'a ``«x`y»`` b'],
    ['code pads text that starts with a backtick', toggleCode, 'a «`y» b', 'a `` «`y» `` b'],
    ['code unwraps a code span with the cursor inside', toggleCode, 'a `co‸de` b', 'a co‸de b'],
    ['code unwraps exactly the inside', toggleCode, 'a `«code»` b', 'a «code» b'],
    ['code unwraps a padded span', toggleCode, 'a `` «`y» `` b', 'a «`y» b'],
    ['code in a code block does nothing', toggleCode, '```\n«x»\n```', null],
    ['italic unwraps a phrase across a line break', toggleItalic, 'x *«a\nb»* y', 'x «a\nb» y'],
    ['strikethrough unwraps a phrase across a line break', toggleStrikethrough, '~~«a\nb»~~ y', '«a\nb» y'],
    ['code unwraps a span across a line break', toggleCode, '`«a\nb»` y', '«a\nb» y'],
  ];
  for (const [name, command, before, expected] of cases) it(name, () => expectCase(command, before, expected));
});

describe('insertLink', () => {
  const cases: Case[] = [
    [
      'a selected web address goes in the address, the cursor in the text',
      'see «https://example.com/a?b=c» now',
      'see [‸](https://example.com/a?b=c) now',
    ],
    ['a www address gets https', '«www.example.com»', '[‸](https://www.example.com)'],
    ['other selected text goes in the text, the cursor in the address', 'see «the site» now', 'see [the site](‸) now'],
    ['selected text with spaces around keeps them outside', 'see« the site »now', 'see [the site](‸) now'],
    ['no selection inserts an empty link, the cursor in the text', 'a ‸ b', 'a [‸]() b'],
    ['inside a link selects its address', '[te‸xt](https://x.y)', '[text](«https://x.y»)'],
    ['inside an autolink selects its address', '<https://x‸.y>', '<«https://x.y»>'],
    ['inside a wikilink selects its target', '[[No‸te|alias]]', '[[«Note»|alias]]'],
    ['inside a link with no address puts the cursor there', '[te‸xt]()', '[text](‸)'],
    ['an address with a space is text, not an address', '«https://x.y/a b»', '[https://x.y/a b](‸)'],
    ['in a code span does nothing', '`a ‸ b`', null],
  ];
  for (const [name, before, expected] of cases) it(name, () => expectCase(insertLink, before, expected));

  it('a web address with unbalanced parentheses goes in angle brackets', () => {
    expect(run(insertLink, '«https://x.y/a(b»')).toBe('[‸](<https://x.y/a(b>)');
  });
});

describe('empty pairs a command leaves', () => {
  it('the same command again removes the pair', () => {
    expect(runAll([toggleBold, toggleBold], 'a ‸ b')).toBe('a ‸ b');
  });

  it('a second kind nests inside, and the first command then removes only its own', () => {
    expect(runAll([toggleBold, toggleItalic], 'a ‸ b')).toBe('a ***‸*** b');
    expect(runAll([toggleBold, toggleItalic, toggleBold], 'a ‸ b')).toBe('a *‸* b');
  });

  it('is removed when the cursor leaves without typing', () => {
    expect(runAll([toggleBold, moveCursor(0)], 'a ‸ b')).toBe('‸a  b');
    expect(runAll([toggleBold, toggleItalic, moveCursor(0)], 'a ‸ b')).toBe('‸a  b');
    expect(runAll([insertLink, moveCursor(0)], 'a ‸ b')).toBe('‸a  b');
  });

  it('stays once something is typed in it', () => {
    expect(runAll([toggleBold, typeText('x'), moveCursor(0)], 'a ‸ b')).toBe('‸a **x** b');
  });

  it('is left alone when an edit elsewhere moves it', () => {
    const insertAtStart = (s: EditorState) => s.update({ changes: { from: 0, insert: 'Z' }, userEvent: 'input.type' });
    expect(runAll([toggleBold, insertAtStart], 'a ‸ b')).toBe('Za **‸** b');
  });
});
