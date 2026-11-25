import { syntaxTree } from '@codemirror/language';
import { Transaction, type EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { toggleBold } from '../../../src/panel/commands/inline';
import { backspace, enter, tab, wrapSelection } from '../../../src/panel/commands/typing';
import { parseMarked } from '../helpers';
import { after, expectCase, marked, moveCursor, run, runAll, stateWith, type StateOptions } from './helpers';

type Case = [name: string, before: string, after: string | null];
type Rule = (state: EditorState) => Transaction | null;

function cases(rule: Rule, list: Case[], options: StateOptions = {}): void {
  for (const [name, before, expected] of list) it(name, () => expectCase(rule, before, expected, undefined, options));
}

describe('Enter', () => {
  cases(enter, [
    ['continues a bullet list', '- one‸', '- one\n- ‸'],
    ['continues a task with an open box', '- [x] done‸', '- [x] done\n- [ ] ‸'],
    ['continues a numbered list and renumbers after it', '1. one‸\n2. two', '1. one\n2. ‸\n3. two'],
    [
      'on a later line of a numbered item, continues it and leaves the numbers after it',
      '1. one\n   more‸\n2. two',
      '1. one\n   more\n   ‸\n2. two',
    ],
    [
      'on a later line of a numbered item in a quote, the same',
      '> 1. one\n>    more‸\n> 2. two',
      '> 1. one\n>    more\n>    ‸\n> 2. two',
    ],
    ['continues a quote', '> quote‸', '> quote\n> ‸'],
    ['continues a list inside a quote', '> - one‸', '> - one\n> - ‸'],
    ['splits an item at the cursor', '- one‸two', '- one\n- ‸two'],
    ['ends a list on an empty item', '- one\n- ‸', '- one\n‸'],
    ['ends a two-item list on its empty third item (not a loose list)', '- one\n- two\n- ‸', '- one\n- two\n‸'],
    ['ends a list on an empty second item', '- one\n- ‸\n\nNext', '- one\n‸\n\nNext'],
    ['an empty nested item moves out a level', '- one\n  - ‸', '- one\n- ‸'],
    ['an empty task ends the list', '- [ ] one\n- [ ] ‸', '- [ ] one\n‸'],
    ['an empty quote line ends the quote', '> one\n> ‸', '> one\n‸'],
    ['an empty nested quote line ends one level', '> > one\n> > ‸', '> > one\n> ‸'],
    ['does nothing in a code block', '- a\n\n  ```\n  co‸de\n  ```', null],
    ['does nothing in a code span', '- a `b‸c`', null],
    ['does nothing in a paragraph', 'Te‸xt', null],
    ['does nothing with text selected', '- «one»', null],
  ]);

  it('does nothing in front matter', () => {
    expect(run(enter, '---\n- ti‸tle\n---\n')).toBeNull();
  });

  it('does nothing in Rich view', () => {
    expect(run(enter, '- one‸', undefined, { mode: 'view' })).toBeNull();
  });

  it('on a later line of a numbered item, starts no item and changes no number', () => {
    const numbers = (doc: string) => [...doc.matchAll(/^[>\s]*(\d+)[.)]/gm)].map((m) => m[1]);
    for (const text of [
      '1. one\n   more‸\n2. two\n3. three',
      '1. one\n   ***‸\n2. two',
      '1. one\n\n   more‸\n\n2. two',
      '> 1. one\n>    more‸\n> 2. two',
      '1. one\n   - x\n   more‸\n2. two',
    ]) {
      const out = parseMarked(run(enter, text)!).doc;
      expect(numbers(out), text).toEqual(numbers(text.replace('‸', '')));
    }
  });
});

describe('Enter, Backspace and the tidying after an edit, past where the stored parse ends', () => {
  // A new state's own parse covers about the first 3,000 characters (CodeMirror 6's first
  // viewport), so what comes after this filler is past it.
  const FILLER = 'A paragraph of filler text.\n\n'.repeat(200);
  const short = (text: string) => {
    const state = stateWith(FILLER + text, { fullTree: false });
    expect(syntaxTree(state).length, text).toBeLessThan(FILLER.length);
    return state;
  };

  it('act as they do on a whole parse', () => {
    const cases: [Rule, string][] = [
      [enter, '- first\n- second\n- ‸'],
      [enter, '- first\n- second‸'],
      [backspace, '- first\n- second\n- ‸third'],
    ];
    for (const [rule, text] of cases) {
      const whole = rule(stateWith(FILLER + text));
      expect(whole, text).not.toBeNull();
      const state = short(text);
      expect(marked(rule(state)?.state ?? state), text).toBe(marked(whole!.state));
    }
  });

  it('tidy as they do on a whole parse', () => {
    const edits: [string, string, string][] = [
      ['1. a\n2. b\n3. c', '2. b\n', 'delete.line'],
      ['Some **bold** here.', 'bold', 'delete.backward'],
    ];
    for (const [text, deleted, userEvent] of edits) {
      const from = FILLER.length + text.indexOf(deleted);
      const edit = (s: EditorState) => s.update({ changes: { from, to: from + deleted.length }, userEvent });
      expect(edit(short(text)).state.doc.toString(), text).toBe(edit(stateWith(FILLER + text)).state.doc.toString());
    }
  });

  describe('a numbered list that runs on past where the parse stops', () => {
    const items = Array.from({ length: 500 }, (_, i) => `${i + 1}. item ${i + 1}`);
    const deleteSecond = (text: string) => {
      const state = stateWith(text, { fullTree: false });
      expect(syntaxTree(state).length).toBeLessThan(text.length);
      return state
        .update({ changes: { from: state.doc.line(1).to, to: state.doc.line(2).to }, userEvent: 'delete.backward' })
        .state.doc.toString();
    };

    it('is renumbered to its end when an item near the top goes', () => {
      const left = items.filter((_, i) => i !== 1);
      expect(deleteSecond(items.join('\n'))).toBe(left.map((l, i) => l.replace(/^\d+/, String(i + 1))).join('\n'));
    });

    it('is left as written when it is out of sequence past there', () => {
      const text = [...items, '1000. last'].join('\n');
      expect(deleteSecond(text)).toBe([...items.filter((_, i) => i !== 1), '1000. last'].join('\n'));
    });
  });
});

describe('Backspace at the start of a block', () => {
  cases(backspace, [
    ['removes a heading mark', '# ‸Title', '‸Title'],
    ['keeps the new paragraph apart from the text around it', 'Before\n## ‸Title\nAfter', 'Before\n\n‸Title\n\nAfter'],
    ['removes a Setext underline', '‸Title\n===', '‸Title'],
    ['removes a task box first, keeping the item', '- [ ] ‸Task', '- ‸Task'],
    ['removes a bullet', '- ‸Item', '‸Item'],
    ["turns a later item into its item's text (lang-markdown)", '- one\n- ‸two', '- one\n  ‸two'],
    ['removes a number', '1. ‸One', '‸One'],
    ['removes a quote mark', '> ‸Quote', '‸Quote'],
    ['removes one level of a nested quote', '> > ‸Quote', '> ‸Quote'],
    ['does nothing in the middle of text', '# Ti‸tle', null],
    ['does nothing in a code block', '```\n‸code\n```', null],
  ]);
});

describe('Tab and Shift+Tab', () => {
  const tabIn: Rule = (s) => tab(s, 1);
  const tabOut: Rule = (s) => tab(s, -1);
  describe('in a list', () => {
    cases(tabIn, [
      ['Tab indents the item', '- one\n- tw‸o', '- one\n  - tw‸o'],
      ['Tab on a numbered item renumbers both lists', '1. one\n2. tw‸o\n3. three', '1. one\n   1. tw‸o\n2. three'],
    ]);
    cases(tabOut, [['Shift+Tab outdents the item', '- one\n  - tw‸o', '- one\n- tw‸o']]);
  });
  describe('in a code block', () => {
    cases(tabIn, [
      ['Tab inserts spaces to the next tab stop', '```\nco‸de\n```', '```\nco  ‸de\n```'],
      ['Tab indents several selected lines', '```\n«a\nb»\n```', '```\n    «a\n    b»\n```'],
    ]);
    cases(tabOut, [
      ['Shift+Tab outdents the lines', '```\n    «a»\n```', '```\n«a»\n```'],
      ['Shift+Tab keeps code inside its list item', '- x\n\n  ```\n  co‸de\n  ```', null],
    ]);
    it('follows the tab setting', () => {
      expect(run(tabIn, '```\nco‸de\n```', undefined, { settings: { insertSpaces: false } })).toBe('```\nco\t‸de\n```');
      expect(run(tabIn, '```\n«a\nb»\n```', undefined, { settings: { tabSize: 2 } })).toBe('```\n  «a\n  b»\n```');
    });
  });
  describe('elsewhere', () => {
    cases(tabIn, [
      ['Tab inserts the indent at the cursor', 'a‸b', 'a   ‸b'],
      ['Tab replaces selected text on one line with the indent', 'a«b»c', 'a   ‸c'],
      ['Tab indents several selected lines', '«a\nb»', '    «a\n    b»'],
    ]);
    cases(tabOut, [
      ['Shift+Tab outdents the line', '  a‸', 'a‸'],
      ['Shift+Tab never takes an indented code block below its four spaces', '    a‸', null],
    ]);
  });
});

describe('typing a mark with text selected', () => {
  const wrapWith =
    (char: string): Rule =>
    (s) =>
      wrapSelection(s, char);
  const cases2: [string, string, string, string | null][] = [
    ['* wraps the selection, keeping it selected', '*', 'a «word» b', 'a *«word»* b'],
    ['_ wraps', '_', '«word»', '_«word»_'],
    ['` wraps', '`', '«word»', '`«word»`'],
    ['~ wraps', '~', '«word»', '~«word»~'],
    ['= wraps', '=', '«word»', '=«word»='],
    ['[ gives [text]', '[', '«word»', '[«word»]'],
    ['( gives (text)', '(', '«word»', '(«word»)'],
    ['" gives "text"', '"', '«word»', '"«word»"'],
    ['another character is plain typing', 'x', '«word»', null],
    ['with no selection it is plain typing', '*', 'wo‸rd', null],
    ['inside a code span it is plain typing', '*', '`«code»`', null],
  ];
  for (const [name, char, before, expected] of cases2) it(name, () => expectCase(wrapWith(char), before, expected));

  it('typing * twice makes bold', () => {
    expect(runAll([wrapWith('*'), wrapWith('*')], 'a «word» b')).toBe('a **«word»** b');
  });
});

describe('after an edit', () => {
  const del =
    (from: number, to: number, userEvent = 'delete.backward'): Rule =>
    (s) =>
      s.update({ changes: { from, to }, userEvent });
  const replace =
    (from: number, to: number, insert: string): Rule =>
    (s) =>
      s.update({ changes: { from, to, insert }, userEvent: 'input.type' });

  describe('numbered lists', () => {
    it('a list numbered in sequence is renumbered when an item goes', () => {
      expect(runAll([del(5, 10)], '1. a\n2. b\n3. c‸')).toBe('1. a\n2. c‸');
    });
    it('a list not in sequence is left as written', () => {
      expect(runAll([del(5, 10)], '1. a\n1. b\n1. c‸')).toBe('1. a\n1. c‸');
    });
    it('two lists that an edit joins into one keep their numbers', () => {
      const text = '1. a\n2. b\n\nSome paragraph.\n\n1. c\n2. d‸';
      const from = text.indexOf('Some');
      expect(runAll([del(from, from + 'Some paragraph.\n\n'.length, 'delete.selection')], text)).toBe(
        '1. a\n2. b\n\n1. c\n2. d‸',
      );
    });
    it('an out-of-sequence list keeps its numbers when an item is added', () => {
      expect(runAll([moveCursor(4), enter], '1. a\n5. b')).toBe('1. a\n2. ‸\n5. b');
    });
    it('a number the user types is kept, and the items after it count on from it', () => {
      expect(runAll([replace(5, 6, '5')], '1. a\n2. b\n3. c‸')).toBe('1. a\n5. b\n6. c‸');
    });
    it("a wider number moves its item's children", () => {
      const text = '8. a\n9. b\n10. c\n11. d‸';
      expect(runAll([del(0, 5)], text)).toBe('9. b\n10. c\n11. d‸');
      const nested = '1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n   - child\n10. j‸';
      expect(runAll([replace(0, 1, '2')], nested)).toBe(
        '2. a\n3. b\n4. c\n5. d\n6. e\n7. f\n8. g\n9. h\n10. i\n    - child\n11. j‸',
      );
    });
    it('changes that arrive from the host are never renumbered', () => {
      const state = stateWith('1. a\n2. b\n3. c');
      const tr = state.update({
        changes: { from: 5, to: 10 },
        userEvent: 'delete.backward',
        annotations: Transaction.remote.of(true),
      });
      expect(after(tr).doc.toString()).toBe('1. a\n3. c');
    });
  });

  describe('deleting all the text of a phrase', () => {
    it('removes its marks', () => {
      expect(runAll([del(4, 8)], 'a **bold** b‸')).toBe('a  b‸');
    });
    it('removes them when the last letter goes', () => {
      expect(runAll([del(2, 3)], '**b**‸')).toBe('‸');
    });
    it('removes the marks of a code span', () => {
      expect(runAll([del(1, 2)], '`x`‸')).toBe('‸');
    });
    it('leaves the marks when only part of the text goes', () => {
      expect(runAll([del(2, 3)], '**bo**‸')).toBe('**o**‸');
    });
    it('leaves the marks when text is typed over it', () => {
      expect(runAll([replace(2, 6, 'x')], '**bold**‸')).toBe('**x**‸');
    });
  });

  describe('empty pairs', () => {
    it('Backspace in an empty pair removes the pair', () => {
      expect(runAll([toggleBold, backspace], 'a ‸ b')).toBe('a ‸ b');
    });
    it('leaving the pair removes it', () => {
      expect(runAll([toggleBold, moveCursor(0)], 'a ‸ b')).toBe('‸a  b');
    });
  });

  it('nothing here changes an edit inside code', () => {
    expect(runAll([del(4, 5)], '```\n1. a\n2. b\n3. c\n```‸')).toBe('```\n. a\n2. b\n3. c\n```‸');
  });
});

describe('the rules hold with a front matter block above', () => {
  const front = '---\ntitle: x\n---\n';
  it('Enter continues a list', () => {
    expect(run(enter, `${front}- one‸`)).toBe(`${front}- one\n- ‸`);
  });
  it('Backspace removes a heading mark', () => {
    expect(run(backspace, `${front}# ‸T`)).toBe(`${front}‸T`);
  });
});

it('marked text round-trips through the helpers', () => {
  const text = 'a «b» ‸c »d«';
  const { doc, ranges } = parseMarked(text);
  expect(doc).toBe('a b c d');
  expect(ranges.length).toBe(3);
  expect(marked(stateWith(text))).toBe(text);
});
