/// <reference types="mocha" />
// One note open side by side: scroll sync between its tabs and opening a view to the side, in a
// real VS Code. A text editor leads when the test reveals a line in it, as a scroll of the user's
// does; a rich tab leads when it is sent to a heading by `tandemMarkdown.revealHeading`, the
// command the outline runs. Each test has notes of its own, since a note's link holds for the
// window. Where the promise is that nothing moves, the test waits for STILL_MS and says so.
//
// A rich tab's place is read from the view state it reports to the host VIEW_STATE_DEBOUNCE_MS
// (src/panel/reports.ts) after it last scrolled, so it lags the place it tells another tab to
// follow: before a check that nothing moves, the test waits until the host has heard where the
// rich tab is.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  api,
  closeEverything,
  note,
  openRich,
  openText,
  pause,
  tabsFor,
  VIEW_TYPE,
  waitFor,
  writeFile,
} from './helpers';

/** Long enough for a follow to have reached the other tab, had one been sent. */
const STILL_MS = 1500;
const LINES = 600;
const HEADING_EVERY = 100;

/** A note of short lines, so no line wraps, with a heading every HEADING_EVERY lines from line HEADING_EVERY. */
const SAMPLE = Array.from({ length: LINES }, (_, i) =>
  i > 0 && i % HEADING_EVERY === 0 ? `## Section ${i / HEADING_EVERY}` : `Line ${i} of the note.`,
).join('\n');

/** The LF offset of the start of a zero-based line of the sample. */
function lineStart(line: number): number {
  return SAMPLE.split('\n')
    .slice(0, line)
    .reduce((sum, l) => sum + l.length + 1, 0);
}

const key = (uri: vscode.Uri) => uri.toString().toLowerCase();

async function syncState() {
  return (await api()).scrollSync();
}

async function linked(uri: vscode.Uri): Promise<boolean | null> {
  const s = await syncState();
  if (s.on.some((u) => u.toLowerCase() === key(uri))) return true;
  if (s.off.some((u) => u.toLowerCase() === key(uri))) return false;
  return null;
}

/** The line at the top of the note's tab in `column`, as the host last heard it. */
async function topLine(uri: vscode.Uri, column: vscode.ViewColumn, kind: 'text' | 'rich'): Promise<number | null> {
  const pane = (await syncState()).panes.find(
    (p) => p.uri.toLowerCase() === key(uri) && p.column === column && p.kind === kind,
  );
  return pane?.topLine ?? null;
}

function textEditorIn(uri: vscode.Uri, column: vscode.ViewColumn): vscode.TextEditor {
  const editor = vscode.window.visibleTextEditors.find(
    (e) => key(e.document.uri) === key(uri) && e.viewColumn === column,
  );
  assert.ok(editor, `a text editor of ${uri.path} in column ${column}`);
  return editor;
}

const firstVisible = (editor: vscode.TextEditor) => editor.visibleRanges[0]!.start.line;

/** The most rows VS Code leaves above a line it reveals at the top: sticky scroll's, or the cursor's surrounding lines. */
function revealPadding(document: vscode.TextDocument): number {
  const editor = vscode.workspace.getConfiguration('editor', document);
  const sticky =
    editor.get<boolean>('stickyScroll.enabled') === true ? editor.get<number>('stickyScroll.maxLineCount', 5) : 0;
  return Math.max(editor.get<number>('cursorSurroundingLines', 0), sticky);
}

/** Scrolls a text editor as the user would: the host did not ask for it, so it leads. */
async function scrollText(editor: vscode.TextEditor, line: number): Promise<number> {
  const before = firstVisible(editor);
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
  await waitFor(() => firstVisible(editor) !== before, `the text editor to scroll toward line ${line}`);
  return firstVisible(editor);
}

/** Sends the active rich tab to a heading, as the outline does: the rich tab leads. */
async function scrollRichToHeading(uri: vscode.Uri, line: number): Promise<void> {
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && key(input.uri) === key(uri);
  }, 'the rich tab to be the active one');
  await vscode.commands.executeCommand('tandemMarkdown.revealHeading', { from: lineStart(line) });
}

/** Waits until the host has heard where the note's rich tab in `column` is, and returns its top line. */
async function heardRich(uri: vscode.Uri, column: vscode.ViewColumn, line?: number): Promise<number> {
  let top: number | null = null;
  await waitFor(
    async () => {
      top = await topLine(uri, column, 'rich');
      return top !== null && (line === undefined || showsAtTop(top, line));
    },
    line === undefined ? 'the rich tab to report where it is' : `the rich tab to report line ${line} at its top`,
  );
  return top!;
}

/** The tab shows `line` at its top: the line itself or, scrolled a pixel short of it, the line before. */
const showsAtTop = (top: number | null, line: number) => top === line || top === line - 1;

/** A text editor shows `line` where VS Code reveals a line: at most `padding` rows below its top. */
function showsLine(editor: vscode.TextEditor, line: number): boolean {
  const top = firstVisible(editor);
  return top <= line && line - top <= revealPadding(editor.document) + 1;
}

async function stillFor(what: () => Promise<unknown> | unknown, label: string): Promise<void> {
  const before = JSON.stringify(await what());
  await pause(STILL_MS);
  assert.equal(JSON.stringify(await what()), before, `${label} stays where it is`);
}

suite('Side by side', () => {
  teardown(async () => {
    await closeEverything();
  });

  test('a rich tab follows a text editor, and the text editor follows the rich tab', async () => {
    const uri = writeFile('side/follow.md', SAMPLE);
    await openText(uri, vscode.ViewColumn.One);
    await openRich(uri, vscode.ViewColumn.Two);
    await waitFor(async () => (await linked(uri)) === true, 'the note, with a rich tab, to start linked');
    const source = textEditorIn(uri, vscode.ViewColumn.One);

    const top = await scrollText(source, 250);
    await waitFor(
      async () => showsAtTop(await topLine(uri, vscode.ViewColumn.Two, 'rich'), top),
      `the rich tab to show line ${top}, the text editor's top`,
    );
    note(`Source at ${top}; rich at ${await topLine(uri, vscode.ViewColumn.Two, 'rich')}`);
    await stillFor(
      async () => [firstVisible(source), await topLine(uri, vscode.ViewColumn.Two, 'rich')],
      'each tab, once followed,',
    );

    await scrollRichToHeading(uri, 400);
    await waitFor(() => showsLine(source, 399), 'the text editor to show the heading near its top');
    await heardRich(uri, vscode.ViewColumn.Two, 400);
    note(`rich sent to line 400; Source's top is ${firstVisible(source)}`);
    await stillFor(
      async () => [firstVisible(source), await topLine(uri, vscode.ViewColumn.Two, 'rich')],
      'each tab, once followed,',
    );
  });

  test('two rich tabs of one note follow each other', async () => {
    const uri = writeFile('side/two-rich.md', SAMPLE);
    await openRich(uri, vscode.ViewColumn.One);
    await openRich(uri, vscode.ViewColumn.Two);
    const hook = await api();
    await waitFor(() => {
      const panels = hook.coordinatorState(uri)?.panels ?? [];
      return panels.length === 2 && panels.every((p) => p.hostLive === true);
    }, 'both rich tabs to have started');
    await waitFor(async () => (await linked(uri)) === true, 'the note to be linked');
    await scrollRichToHeading(uri, 300);
    await waitFor(async () => {
      const [a, b] = [
        await topLine(uri, vscode.ViewColumn.One, 'rich'),
        await topLine(uri, vscode.ViewColumn.Two, 'rich'),
      ];
      return showsAtTop(b, 300) && a !== null && Math.abs(a - b!) <= 1;
    }, 'the other rich tab to show the heading too');
  });

  test('the toggle stops following both ways, and turning it on moves nothing until the next scroll', async () => {
    const uri = writeFile('side/toggle.md', SAMPLE);
    await openText(uri, vscode.ViewColumn.One);
    await openRich(uri, vscode.ViewColumn.Two);
    await waitFor(async () => (await linked(uri)) === true, 'the note to start linked');
    const source = textEditorIn(uri, vscode.ViewColumn.One);
    const rich = () => topLine(uri, vscode.ViewColumn.Two, 'rich');

    await vscode.commands.executeCommand('tandemMarkdown.toggleScrollSync');
    await waitFor(async () => (await linked(uri)) === false, 'the note to be unlinked');

    await heardRich(uri, vscode.ViewColumn.Two);
    await scrollText(source, 200);
    await stillFor(rich, 'the rich tab, unlinked, while the text editor scrolls,');
    const sourceTop = firstVisible(source);
    await scrollRichToHeading(uri, 500);
    await waitFor(async () => showsAtTop(await rich(), 500), 'the rich tab to go to the heading');
    await stillFor(() => firstVisible(source), 'the text editor, unlinked, while the rich tab scrolls,');
    assert.equal(firstVisible(source), sourceTop);

    await vscode.commands.executeCommand('tandemMarkdown.toggleScrollSync');
    await waitFor(async () => (await linked(uri)) === true, 'the note to be linked again');
    await stillFor(async () => [firstVisible(source), await rich()], 'each tab, when linked again,');

    const top = await scrollText(source, 100);
    await waitFor(async () => showsAtTop(await rich(), top), 'the rich tab to follow at the next scroll');
  });

  test('two text editors of one note start unlinked, the button links them, and the state shows on both', async () => {
    const uri = writeFile('side/source-twice.md', SAMPLE);
    await openText(uri, vscode.ViewColumn.One);
    await openText(uri, vscode.ViewColumn.Two);
    await waitFor(async () => (await linked(uri)) === false, 'the note, in Source tabs alone, to start unlinked');
    const s = await syncState();
    assert.equal(
      s.panes.filter((p) => p.uri.toLowerCase() === key(uri) && p.kind === 'text').length,
      2,
      'both text editors are the note’s visible tabs, so both show the button',
    );
    const one = textEditorIn(uri, vscode.ViewColumn.One);
    const two = textEditorIn(uri, vscode.ViewColumn.Two);
    await scrollText(one, 200);
    await stillFor(() => firstVisible(two), 'the other text editor, unlinked,');

    // The title bar's button passes the tab's uri.
    await vscode.commands.executeCommand('tandemMarkdown.turnOnScrollSync', uri);
    await waitFor(async () => (await linked(uri)) === true, 'the note to be linked, for both tabs');
    const top = await scrollText(one, 400);
    await waitFor(() => showsLine(two, top), `the other text editor to show line ${top} near its top`);
    note(`one at ${firstVisible(one)}, two at ${firstVisible(two)}`);
    await stillFor(() => [firstVisible(one), firstVisible(two)], 'each text editor, once followed,');
  });

  test('toggling one note leaves another alone', async () => {
    const a = writeFile('side/note-a.md', SAMPLE);
    const b = writeFile('side/note-b.md', SAMPLE);
    await openText(a, vscode.ViewColumn.One);
    await openRich(a, vscode.ViewColumn.Two);
    await openText(b, vscode.ViewColumn.Three);
    await openRich(b, vscode.ViewColumn.Four);
    await waitFor(
      async () => (await linked(a)) === true && (await linked(b)) === true,
      'both notes, each with a rich tab, to start linked',
    );
    await vscode.commands.executeCommand('tandemMarkdown.turnOffScrollSync', a);
    await waitFor(async () => (await linked(a)) === false, 'the first note to be unlinked');
    assert.equal(await linked(b), true, 'the second note is still linked');

    const top = await scrollText(textEditorIn(b, vscode.ViewColumn.Three), 300);
    await waitFor(
      async () => showsAtTop(await topLine(b, vscode.ViewColumn.Four, 'rich'), top),
      'the second note to follow',
    );
    await heardRich(a, vscode.ViewColumn.Two);
    await scrollText(textEditorIn(a, vscode.ViewColumn.One), 300);
    await stillFor(() => topLine(a, vscode.ViewColumn.Two, 'rich'), 'the first note’s rich tab');
  });

  test('Open Rich View to the Side opens beside, keeps focus, starts at the place, and opens no second tab', async () => {
    const hook = await api();
    const uri = writeFile('side/open-rich.md', SAMPLE);
    const source = await openText(uri, vscode.ViewColumn.One);
    const top = await scrollText(source, 300);

    await vscode.commands.executeCommand('tandemMarkdown.openRichViewToSide');
    await hook.whenPanelLive(uri);
    assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One, 'the group keeps focus');
    assert.equal(key(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse('none:')), key(uri));
    assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One, 'Source keeps focus');
    const richTabs = () => tabsFor(uri).filter((t) => t.input instanceof vscode.TabInputCustom);
    assert.deepEqual(
      richTabs().map((t) => t.group.viewColumn),
      [vscode.ViewColumn.Two],
      'one rich tab, in the group beside',
    );
    assert.equal((await hook.panelState(uri, vscode.ViewColumn.Two)).mode, 'view');
    await waitFor(
      async () => showsAtTop(await topLine(uri, vscode.ViewColumn.Two, 'rich'), top),
      `the rich tab to start at line ${top}, where Source is`,
    );

    // Again, from Source: the tab beside is gone to, not opened twice, and takes the view asked for.
    await vscode.commands.executeCommand('tandemMarkdown.openRichEditorToSide');
    await waitFor(
      async () => (await hook.panelState(uri, vscode.ViewColumn.Two)).mode === 'edit',
      'the tab to show the Rich editor',
    );
    assert.equal(richTabs().length, 1, 'still one rich tab');
    assert.equal(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One, 'Source keeps focus');
  });

  test('Open Source to the Side opens a text editor beside a rich tab, keeps focus and starts at the place', async () => {
    const uri = writeFile('side/open-source.md', SAMPLE);
    await openRich(uri, vscode.ViewColumn.One);
    await scrollRichToHeading(uri, 200);
    await waitFor(async () => {
      const hook = await api();
      const vs = hook.coordinatorState(uri)?.panels[0]?.viewState;
      return !!vs && showsAtTop(vs.topLine, 200);
    }, 'the rich tab to report the heading at its top');

    await vscode.commands.executeCommand('tandemMarkdown.openSourceToSide');
    await waitFor(
      () =>
        tabsFor(uri).some(
          (t) => t.input instanceof vscode.TabInputText && t.group.viewColumn === vscode.ViewColumn.Two,
        ),
      'a Source tab in the group beside',
    );
    const active = vscode.window.tabGroups.activeTabGroup;
    assert.equal(active.viewColumn, vscode.ViewColumn.One, 'the group keeps focus');
    assert.ok(active.activeTab?.input instanceof vscode.TabInputCustom, 'the rich tab keeps focus');
    const source = textEditorIn(uri, vscode.ViewColumn.Two);
    await waitFor(() => showsLine(source, 199), 'Source to start near the heading');
    note(`Source opened with ${firstVisible(source)} at its top`);
  });
});
