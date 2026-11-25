import { describe, expect, it } from 'vitest';
import type { StateCommand } from '../../../src/panel/commands/base';
import {
  indentListItems,
  toggleBulletList,
  toggleNumberedList,
  toggleTask,
  toggleTaskList,
} from '../../../src/panel/commands/lists';
import { markdownParser } from '../../../src/panel/markdown';
import { parseMarked } from '../helpers';
import { expectCase, run } from './helpers';

type Case = [name: string, before: string, after: string | null];

function cases(command: StateCommand, list: Case[]): void {
  for (const [name, before, expected] of list) it(name, () => expectCase(command, before, expected));
}

describe('toggleBulletList', () => {
  cases(toggleBulletList, [
    ['makes a line a bullet', 'Te‸xt', '- Te‸xt'],
    ['uses the marker of the nearest list in the file', '* a\n\nTe‸xt', '* a\n\n* Te‸xt'],
    ['makes each touched line an item', '«One\nTwo»', '- «One\n- Two»'],
    ['skips blank lines inside the selection', '«One\n\nTwo»', '- «One\n\n- Two»'],
    ['removes the markers when every line is a bullet', '- «One\n- Two»', '«One\nTwo»'],
    ['a line inside an item acts on its item', '- one\n  co‸nt', 'one\n  co‸nt'],
    ['switches numbers to bullets, keeping the indent', '«1. One\n2. Two»', '«- One\n- Two»'],
    ['switches a task to a plain bullet', '- [ ] Ta‸sk', '- Ta‸sk'],
    ['a heading line keeps its heading inside the item', '# Ti‸tle', '- # Ti‸tle'],
    ['in a quote, after the quote mark', '> Te‸xt', '> - Te‸xt'],
    ['a code block line is left alone', '```\nco‸de\n```', null],
    // A line inside a code block does not reach the item around it.
    ['a code line inside an item leaves the item alone', '- a\n\n  ```\n  co‸de\n  ```', null],
    ['text and part of a code block are left alone', '«Text\n```\nco»de\n```', null],
  ]);
});

describe('toggleNumberedList', () => {
  cases(toggleNumberedList, [
    ['counts from 1', '«One\nTwo\nThree»', '1. «One\n2. Two\n3. Three»'],
    ['a nested list keeps its nesting, and each level counts on its own', '- «a\n  - b\n- c»', '1. «a\n   1. b\n2. c»'],
    ["an item's body moves with its wider marker", '- o‸ne\n  more\n  - child', '1. o‸ne\n   more\n   - child'],
    ['a lazy line belongs to the item above, so it acts on that item', '1. a\nb‸', 'a\nb‸'],
    ['continues the list above across a blank line', '1. a\n2. b\n\nc‸', '1. a\n2. b\n\n3. c‸'],
    ['removes the numbers when every line is numbered', '«1. One\n2. Two»', '«One\nTwo»'],
    ['switches bullets to numbers', '«- One\n- Two»', '«1. One\n2. Two»'],
  ]);

  it('a nested list stays nested once numbered', () => {
    const doc = parseMarked(run(toggleNumberedList, '- «a\n  - b\n- c»')!).doc;
    const tree = markdownParser.parse(doc);
    const lists: string[] = [];
    tree.iterate({
      enter: (n) => void (n.name.endsWith('List') && lists.push(`${n.name}:${doc.slice(n.from, n.to)}`)),
    });
    expect(lists).toEqual(['OrderedList:1. a\n   1. b\n2. c', 'OrderedList:1. b']);
  });
});

describe('toggleTaskList', () => {
  cases(toggleTaskList, [
    ['makes a line a task', 'Te‸xt', '- [ ] Te‸xt'],
    ['makes a bullet a task, keeping its marker', '* It‸em', '* [ ] It‸em'],
    ['makes a numbered item a task bullet', '1. It‸em', '- [ ] It‸em'],
    ['removes the task when every line is a task', '- [ ] Ta‸sk', 'Ta‸sk'],
    ['a checked task too', '- [x] Do‸ne', 'Do‸ne'],
  ]);
});

describe('toggleTask', () => {
  cases(toggleTask, [
    ['checks an open task', '- [ ] Ta‸sk', '- [x] Ta‸sk'],
    ['unchecks a checked task', '- [x] Ta‸sk', '- [ ] Ta‸sk'],
    ['gives a plain bullet a box', '- It‸em', '- [ ] It‸em'],
    ['flips each touched task on its own', '- [ ] «a\n- [x] b»', '- [x] «a\n- [ ] b»'],
    ['a line inside a task acts on its task', '- [ ] a\n  mo‸re', '- [x] a\n  mo‸re'],
    ['a paragraph is left alone', 'Te‸xt', null],
    ['a code line inside a task leaves the task alone', '- [ ] a\n\n  ```\n  co‸de\n  ```', null],
  ]);
});

describe('indentListItems (Tab and Shift+Tab in a list)', () => {
  const tab = (state: Parameters<StateCommand>[0]) => indentListItems(state, 1);
  const shiftTab = (state: Parameters<StateCommand>[0]) => indentListItems(state, -1);
  describe('Tab', () => {
    cases(tab, [
      ['makes an item a child of the one before', '- one\n- tw‸o', '- one\n  - tw‸o'],
      ['takes its children along', '- a\n- b‸\n  - c', '- a\n  - b‸\n    - c'],
      ['joins the children the item before already has', '- a\n    - x\n- b‸', '- a\n    - x\n    - b‸'],
      ["uses the list's own nesting width", '- a\n    - x\n- b\n- c‸', '- a\n    - x\n- b\n    - c‸'],
      [
        'a numbered child sits past its parent marker and starts at 1',
        '1. one\n2. tw‸o\n3. three',
        '1. one\n   1. tw‸o\n2. three',
      ],
      ['continues a numbered child list it joins', '1. a\n   1. x\n2. b‸', '1. a\n   1. x\n   2. b‸'],
      ['in a quote, after the quote mark', '> - one\n> - tw‸o', '> - one\n>   - tw‸o'],
      ['the first item cannot move', '- on‸e\n- two', null],
      ['moves every touched item', '- a\n- «b\n- c»', '- a\n  - «b\n  - c»'],
    ]);
  });
  describe('Shift+Tab', () => {
    cases(shiftTab, [
      ["moves a child out to its parent's level", '- one\n  - tw‸o', '- one\n- tw‸o'],
      ['takes its children along', '- a\n  - b‸\n    - c', '- a\n- b‸\n  - c'],
      ['a numbered item counts on from its new parent', '1. a\n   1. b‸\n2. c', '1. a\n2. b‸\n3. c'],
      ['a top-level item cannot move', '- on‸e', null],
    ]);
  });
});
