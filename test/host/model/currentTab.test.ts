// The tab the user is in, over stand-ins for the window's tabs and VS Code's active text editor.
import { describe, expect, it } from 'vitest';
import { currentTabOf, type TabFacts } from '../../../src/host/model/currentTab';

const A = 'file:///w/a.md';
const B = 'file:///w/b.md';
const rich = (uri: string, column: number): TabFacts => ({ kind: 'rich', uri, column });
const text = (uri: string, column: number): TabFacts => ({ kind: 'text', uri, column });
const richA = rich(A, 1);

describe('the tab the user is in', () => {
  it('is the text editor that kept the keyboard while VS Code marked the rich tab’s group active', () => {
    const tabs = [rich(A, 1), text(B, 2)];
    expect(
      currentTabOf({ active: tabs[0], richHasKeyboard: false, textEditor: { uri: B, column: 2 }, groupTabs: tabs }),
    ).toBe(tabs[1]);
  });

  it('is the rich tab when its page has the keyboard, whatever VS Code still names the active text editor', () => {
    const tabs = [rich(A, 1), text(B, 2)];
    expect(
      currentTabOf({ active: tabs[0], richHasKeyboard: true, textEditor: { uri: B, column: 2 }, groupTabs: tabs }),
    ).toBe(tabs[0]);
  });

  it('is the active tab when no text editor is active, as with the keyboard in a panel or a view', () => {
    const tabs = [rich(A, 1), text(B, 2)];
    expect(currentTabOf({ active: tabs[0], richHasKeyboard: false, textEditor: undefined, groupTabs: tabs })).toBe(
      tabs[0],
    );
  });

  it('is the active tab when the active text editor is a notebook cell, one side of a diff, or Output', () => {
    const notebook: TabFacts = { kind: 'other', uri: undefined, column: 2 };
    const tabs = [rich(A, 1), notebook];
    const cell = { uri: 'vscode-notebook-cell:/w/n.ipynb#c1', column: 2 };
    expect(currentTabOf({ active: tabs[0], richHasKeyboard: false, textEditor: cell, groupTabs: tabs })).toBe(tabs[0]);
    const diff: TabFacts = { kind: 'other', uri: undefined, column: 2 };
    const modified = { uri: B, column: 2 };
    expect(
      currentTabOf({ active: tabs[0], richHasKeyboard: false, textEditor: modified, groupTabs: [richA, diff] }),
    ).toBe(tabs[0]);
    const output = { uri: 'output:extension-output-1', column: undefined };
    expect(currentTabOf({ active: tabs[0], richHasKeyboard: false, textEditor: output, groupTabs: tabs })).toBe(
      tabs[0],
    );
  });

  it('is the active tab when it is not a rich tab', () => {
    const tabs = [text(A, 1), text(B, 2)];
    expect(
      currentTabOf({ active: tabs[0], richHasKeyboard: false, textEditor: { uri: B, column: 2 }, groupTabs: tabs }),
    ).toBe(tabs[0]);
    const other: TabFacts = { kind: 'other', uri: A, column: 1 };
    expect(
      currentTabOf({
        active: other,
        richHasKeyboard: false,
        textEditor: { uri: B, column: 2 },
        groupTabs: [other, text(B, 2)],
      }),
    ).toBe(other);
  });

  it('is nothing when no group has a tab', () => {
    expect(
      currentTabOf({ active: undefined, richHasKeyboard: false, textEditor: undefined, groupTabs: [] }),
    ).toBeUndefined();
  });
});
