/// <reference types="mocha" />
// Links, wikilinks and images in a real VS Code with the real panel. Nothing here types into a
// document: files are written from outside, opened in the rich editor, the panel is asked what
// it drew, and links are opened through the panel's `openLink` command (the path a click takes).

import * as assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import * as vscode from 'vscode';
import { activeTabIsRich, api, closeEverything, note, openRich, openText, pause, waitFor, writeFile } from './helpers';

/** A 1 by 1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const filler = Array.from(
  { length: 60 },
  (_, i) => `Filler paragraph ${i + 1}, so the heading below starts well down the page.\n`,
).join('\n');

// Text after the heading too, so the page can scroll it to the top.
const OTHER = ['# Other', '', filler, '## Second part', '', filler, 'The end.', ''].join('\n');
/** The line of "The end." in OTHER, counted from 1 as a link to a line counts. */
const END_LINE = OTHER.split('\n').indexOf('The end.') + 1;

const START = [
  '# Start',
  '',
  'A [plain link](Other.md#second-part), [[Other#Second part|a wikilink]], [[Nowhere]], [a picture link](img/pic.png) and [refused](command:tandemMarkdown.showSource).',
  '',
  `And [a line link](Other.md#L${END_LINE}).`,
  '',
  '![pic](img/pic.png)',
  '',
  '![[pic.png]]',
  '',
  '![gone](img/gone.png)',
  '',
  '![outside](../../outside.png)',
  '',
  filler,
  '## Down here',
  '',
  '[back to the top](#start)',
  '',
].join('\n');

const at = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `the text holds ${needle}`);
  return i;
};
const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1;

/** How long a link that must not be followed is given to open something; nothing may open. */
const WRONG_OPEN_MS = 1500;

suite('Links, wikilinks and images', () => {
  let start: vscode.Uri;
  let other: vscode.Uri;

  suiteSetup(() => {
    start = writeFile('links/Start.md', START);
    other = writeFile('links/Other.md', OTHER);
    writeFile('links/img/pic.png', PNG);
  });

  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('images inside the workspace load; a missing one and one outside the workspace say why', async () => {
    const hook = await api();
    await openRich(start);
    let widgets: string[] = [];
    await waitFor(async () => {
      widgets = (await hook.panelState(start)).widgets.filter((w) => w.includes('tm-image'));
      return (
        widgets.filter((w) => w.includes('tm-image-loaded')).length === 2 &&
        widgets.filter((w) => w.includes('tm-image-failed')).length === 2
      );
    }, 'two images to load and two to fail');
    note(`image widgets: ${JSON.stringify(widgets)}`);
    const state = await hook.panelState(start);
    assert.deepEqual(state.cspViolations, [], 'no content-policy violation');
  });

  test('a link to a markdown file opens it in the same view, at its heading', async () => {
    const hook = await api();
    await openRich(start);
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'plain link') } }]);
    await waitFor(() => activeTabIsRich(other), 'Other.md to open in the rich editor');
    await hook.whenPanelLive(other);
    const heading = at(OTHER, 'Second part');
    await waitFor(
      async () => (await hook.panelState(other)).selection.anchor === heading,
      'the cursor to go to "Second part"',
    );
    assert.equal(
      hook.coordinatorState(other)!.panels[0]!.mode,
      'edit',
      'it opened in Rich editor, as the link was clicked in',
    );
  });

  test('a link to a line of a markdown file opens it with the cursor on that line', async () => {
    const hook = await api();
    await openRich(start);
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'a line link') } }]);
    await waitFor(() => activeTabIsRich(other), 'Other.md to open in the rich editor');
    await hook.whenPanelLive(other);
    await waitFor(
      async () => (await hook.panelState(other)).selection.anchor === at(OTHER, 'The end.'),
      `the cursor to go to line ${END_LINE}`,
    );
  });

  test('a wikilink opens its file at its heading; Rich view opens Rich view', async () => {
    const hook = await api();
    await openRich(start);
    await hook.runInPanel(start, [{ type: 'setMode', mode: 'view' }]);
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'a wikilink') } }]);
    await waitFor(() => activeTabIsRich(other), 'Other.md to open');
    await hook.whenPanelLive(other);
    const record = () => hook.coordinatorState(other)?.panels[0];
    await waitFor(() => record()?.mode === 'view', 'Other.md to be in Rich view');
    const line = lineOf(OTHER, at(OTHER, '## Second part'));
    try {
      await waitFor(() => {
        const top = record()?.viewState?.topLine;
        return top === line || top === line - 1;
      }, `the panel to scroll to line ${line}`);
    } catch (error) {
      const logs = hook
        .logLines()
        .map((l) => JSON.stringify(l))
        .slice(-15);
      const layout = (await hook.panelState(other).catch(() => null))?.layout;
      throw new Error(
        `${(error as Error).message}; view state ${JSON.stringify(record()?.viewState)}; layout ${JSON.stringify(layout)}; log ${logs.join(' | ')}`,
      );
    }
  });

  test('a #heading link scrolls its own panel; a missing wikilink and a refused address open nothing', async () => {
    const hook = await api();
    await openRich(start);
    await hook.runInPanel(start, [
      { type: 'select', anchor: at(START, 'back to the top'), head: at(START, 'back to the top') },
    ]);
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'back to the top') } }]);
    await waitFor(
      async () => (await hook.panelState(start)).selection.anchor === at(START, 'Start'),
      'the cursor to go to the first heading',
    );

    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    const before = tabs();
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'Nowhere') } }]);
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'refused') } }]);
    await pause(WRONG_OPEN_MS);
    assert.equal(tabs(), before, 'nothing opened');
    assert.ok(activeTabIsRich(start), 'the command: link did not run (it would have switched to Source)');
  });

  test('a link to another kind of file opens it in VS Code', async () => {
    const hook = await api();
    await openRich(start);
    await hook.runInPanel(start, [{ type: 'command', id: 'openLink', args: { at: at(START, 'a picture link') } }]);
    await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
      return !!input?.uri && input.uri.path.endsWith('/links/img/pic.png');
    }, 'pic.png to open');
  });
});

const PLAN = [
  '# Plan',
  '',
  filler,
  '## Second part',
  '',
  'What the second part says.',
  '',
  '## Third part',
  '',
  filler,
].join('\n');

const BEAR = [
  '# Bear',
  '',
  'Read [[Plan/Second part]] and [[/Down here]].',
  '',
  filler,
  '## Down here',
  '',
  'The end.',
  '',
].join('\n');

suite("Bear's links to a heading, and contents lists", () => {
  let bear: vscode.Uri;
  let plan: vscode.Uri;

  suiteSetup(async () => {
    bear = writeFile('bear/Bear.md', BEAR);
    plan = writeFile('bear/Plan.md', PLAN);
    const hook = await api();
    // The link index may have been built by an earlier test file; new files reach it a moment later.
    await waitFor(
      async () => (await hook.previewNote(bear, 'wikilink', 'Plan')) !== null,
      'the link index to hold the files just written',
    );
  });

  teardown(async () => {
    await closeEverything();
  });

  /** Follows the link at `offset` in Bear.md and waits for Plan.md's cursor to reach `heading`. */
  const followToPlan = async (offset: number, heading: number) => {
    const hook = await api();
    await openRich(bear);
    await hook.runInPanel(bear, [{ type: 'command', id: 'openLink', args: { at: offset } }]);
    await waitFor(() => activeTabIsRich(plan), 'Plan.md to open in the rich editor');
    await hook.whenPanelLive(plan);
    await waitFor(
      async () => (await hook.panelState(plan)).selection.anchor === heading,
      'the cursor to go to "Second part"',
    );
  };

  test('[[Note/Heading]] opens the note at the heading, the note saved', async () => {
    await followToPlan(at(BEAR, 'Plan/Second part'), at(PLAN, 'Second part'));
  });

  test('[[Note/Heading]] opens the note at the heading, the note open and unsaved', async () => {
    const editor = await openText(plan);
    const added = '# Plan\n\nA new first paragraph, not saved.\n';
    await editor.edit((edit) => edit.replace(new vscode.Range(0, 0, 1, 0), added));
    assert.ok(editor.document.isDirty, 'Plan.md has unsaved text');
    const unsaved = editor.document.getText().replace(/\r\n/g, '\n');
    await followToPlan(at(BEAR, 'Plan/Second part'), at(unsaved, 'Second part'));
  });

  test('[[/Heading]] goes to the heading in the same note', async () => {
    const hook = await api();
    await openRich(bear);
    await hook.runInPanel(bear, [{ type: 'command', id: 'openLink', args: { at: at(BEAR, '/Down here') + 1 } }]);
    await waitFor(
      async () => (await hook.panelState(bear)).selection.anchor === at(BEAR, '## Down here') + 3,
      'the cursor to go to "Down here"',
    );
    assert.ok(activeTabIsRich(bear), 'no other note opened');
  });

  test('the hover card and an embed of [[Note/Heading]] show the note and its section, saved or not', async () => {
    const hook = await api();
    const card = await hook.previewNote(bear, 'wikilink', 'Plan/Second part');
    assert.equal(card?.path, 'bear/Plan.md');
    assert.deepEqual(card, await hook.previewNote(bear, 'wikilink', 'Plan#Second part'), 'as for Plan#Second part');
    assert.deepEqual(await hook.embedNote(bear, 'Plan/Second part'), {
      path: 'bear/Plan.md',
      title: 'Plan',
      text: '## Second part\n\nWhat the second part says.',
    });

    const editor = await openText(plan);
    const said = editor.document.getText().split(/\r?\n/).indexOf('What the second part says.');
    await editor.edit((edit) => {
      edit.insert(new vscode.Position(0, 0), '# Plan, renamed\n\n');
      edit.replace(editor.document.lineAt(said).range, 'Said, not saved.');
    });
    const unsavedCard = await hook.previewNote(bear, 'wikilink', 'Plan/Second part');
    assert.equal(unsavedCard?.title, 'Plan, renamed', 'the card reads the unsaved note');
    const unsavedEmbed = await hook.embedNote(bear, 'Plan/Second part');
    assert.ok('text' in unsavedEmbed && unsavedEmbed.text.endsWith('Said, not saved.'), JSON.stringify(unsavedEmbed));
  });

  test('[[toc]] alone on a line is a contents list, and a link once a note named toc exists', async () => {
    const hook = await api();
    const doc = writeFile('toc/Doc.md', '# Doc\n\n[[toc]]\n\n## One\n\n## Two\n');
    const contents = async () => (await hook.panelState(doc)).widgets.some((w) => w.includes('tm-drawn-contents'));
    await openRich(doc);
    await waitFor(contents, 'the contents list to be drawn');
    const tocNote = writeFile('toc/toc.md', '# toc\n');
    try {
      await waitFor(async () => !(await contents()), 'the marker to become a link to toc.md');
      const link = await hook.request(doc, { type: 'resolveLinks', targets: ['toc'] });
      note(`resolveLinks(toc): ${JSON.stringify(link)}`);
      assert.equal((link as Record<string, { path?: string }>).toc?.path, 'toc/toc.md');
    } finally {
      rmSync(tocNote.fsPath, { force: true });
    }
    await waitFor(contents, 'the contents list to be drawn again once toc.md is gone');
  });
});
