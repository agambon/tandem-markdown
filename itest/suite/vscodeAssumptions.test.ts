/// <reference types="mocha" />
// What the document core assumes about VS Code, each seen in a real VS Code
// (docs/ARCHITECTURE.md, "What VS Code is assumed to do"). Each test prints what it saw (lines
// starting "note:") and asserts it, so a VS Code that behaves differently fails here.
//
// 1. A content change event carries the dirty flag from before the change, and a separate
//    dirty-only event follows, so the first edit to a clean document and a reload look alike.
// 2. The change event of an applied WorkspaceEdit reaches the extension host before
//    `workspace.applyEdit` resolves.
// 3. "Save without Formatting" runs no will-save, and such saves alone bring no warning: only
//    VS Code's own count of the save step running too long does (saveCheckOff).
// 4. An edit sent to a closed document's uri is applied by VS Code to a fresh copy of the
//    file, with no version check. The core therefore stops at the close.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  api,
  closeEverything,
  documentFor,
  lf,
  note,
  openRich,
  openText,
  pause,
  setSetting,
  waitFor,
  writeFile,
} from './helpers';

/** One change event as an extension sees it, and the dirty flag a moment later. */
interface Seen {
  changes: number;
  dirty: boolean;
  reason?: 'undo' | 'redo';
  /** `document.isDirty` read in a microtask queued by the listener. */
  dirtyAfterMicrotask?: boolean;
  /** `document.isDirty` read in the next task (setTimeout 0). */
  dirtyAfterTask?: boolean;
}

function record(uri: vscode.Uri): { events: Seen[]; dispose(): void } {
  const events: Seen[] = [];
  const sub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.toString() !== uri.toString()) return;
    const seen: Seen = { changes: e.contentChanges.length, dirty: e.document.isDirty };
    if (e.reason === vscode.TextDocumentChangeReason.Undo) seen.reason = 'undo';
    if (e.reason === vscode.TextDocumentChangeReason.Redo) seen.reason = 'redo';
    events.push(seen);
    if (seen.changes > 0) {
      queueMicrotask(() => (seen.dirtyAfterMicrotask = e.document.isDirty));
      setTimeout(() => (seen.dirtyAfterTask = e.document.isDirty), 0);
    }
  });
  return { events, dispose: () => sub.dispose() };
}

/**
 * What VS Code 1.146 was seen to do, by kind of change:
 * - firstEdit: the first edit to a clean document (any kind) arrives clean, and a separate
 *   dirty-only event turns it dirty afterward.
 * - saveClean: Ctrl+S on a clean file whose save participants edit it: the same for their first edit.
 * - saveDirty: Ctrl+S on a dirty file: the participants' edits arrive dirty.
 * - reload: VS Code reloads a clean document: clean changes with no reason, and nothing turns it dirty.
 * - revert: Revert File: clean changes with no reason, then a clean dirty-only event.
 * - undoToSaved: undo back to the saved text: the change arrives dirty with reason undo, then a clean dirty-only event.
 */
type Kind = 'firstEdit' | 'saveClean' | 'saveDirty' | 'reload' | 'revert' | 'undoToSaved';

function problems(kind: Kind, events: Seen[]): string[] {
  const content = events.filter((e) => e.changes > 0);
  const flags = events.filter((e) => e.changes === 0);
  if (content.length === 0) return ['no content change was seen'];
  const first = content[0]!;
  const after = events.slice(events.indexOf(first) + 1);
  const flagAfter = (dirty: boolean) => after.some((e) => e.changes === 0 && e.dirty === dirty);
  const out: string[] = [];
  switch (kind) {
    case 'firstEdit':
    case 'saveClean':
      if (first.dirty) out.push('the first change arrived dirty');
      if (!flagAfter(true)) out.push('no dirty-only event turned the document dirty after it');
      break;
    case 'saveDirty':
      if (content.some((e) => !e.dirty)) out.push('an edit to a dirty document arrived clean');
      break;
    case 'reload':
      if (content.some((e) => e.dirty || e.reason !== undefined)) out.push('a change arrived dirty or with a reason');
      if (flags.some((e) => e.dirty)) out.push('a dirty-only event said dirty');
      break;
    case 'revert':
      if (content.some((e) => e.dirty || e.reason !== undefined)) out.push('a change arrived dirty or with a reason');
      if (!flagAfter(false)) out.push('no clean dirty-only event followed');
      if (flags.some((e) => e.dirty)) out.push('a dirty-only event said dirty');
      break;
    case 'undoToSaved':
      if (!first.dirty || first.reason !== 'undo') out.push('the undo did not arrive dirty with reason undo');
      if (!flagAfter(false)) out.push('no clean dirty-only event followed');
      break;
  }
  return out;
}

function describe(events: Seen[]): string {
  const flag = (d: boolean | undefined) => (d === undefined ? '?' : d ? 'dirty' : 'clean');
  const one = (e: Seen) =>
    e.changes === 0
      ? `dirty flag only (${flag(e.dirty)})`
      : `${e.changes} change${e.changes === 1 ? '' : 's'} ${flag(e.dirty)}${e.reason ? ` (${e.reason})` : ''}, ` +
        `after a microtask ${flag(e.dirtyAfterMicrotask)}, next task ${flag(e.dirtyAfterTask)}`;
  return events.map(one).join('; ') || 'no events';
}

/** How long after an action's first change event its later ones are given to arrive. */
const LATER_EVENTS_MS = 300;
/** How long a save's steps after the command (will-save edits, the write, the extension's checks) are given to finish. */
const SAVE_STEPS_MS = 500;

suite('What VS Code is assumed to do', () => {
  setup(async () => {
    (await api()).clearRecords();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('a change carries the dirty flag from before it, and a dirty-only event follows', async () => {
    const hook = await api();
    const results: { label: string; events: Seen[]; kind: Kind }[] = [];
    /** Runs `action` with a recorder on, lets its events settle, and keeps what was seen. */
    const observe = async (label: string, uri: vscode.Uri, kind: Kind, action: () => PromiseLike<unknown>) => {
      const rec = record(uri);
      try {
        await action();
        const end = Date.now() + 3000;
        while (rec.events.every((e) => e.changes === 0) && Date.now() < end) await pause(25);
        await pause(LATER_EVENTS_MS);
      } finally {
        rec.dispose();
      }
      results.push({ label, events: rec.events, kind });
    };

    {
      const uri = writeFile('assumptions/dirty-flag-typing.md', 'typing\n');
      await openText(uri);
      await observe('typing in a text editor, starting clean', uri, 'firstEdit', () =>
        vscode.commands.executeCommand('type', { text: 'x' }),
      );
    }
    {
      const uri = writeFile('assumptions/dirty-flag-editor-edit.md', 'edit\n');
      const editor = await openText(uri);
      await observe('TextEditor.edit, starting clean', uri, 'firstEdit', () =>
        editor.edit((b) => b.insert(new vscode.Position(0, 0), 'x')),
      );
    }
    for (const shown of [true, false]) {
      const uri = writeFile(`assumptions/dirty-flag-edit-${shown ? 'shown' : 'hidden'}.md`, 'edit\n');
      if (shown) await openText(uri);
      else await vscode.workspace.openTextDocument(uri);
      await observe(
        `a WorkspaceEdit, starting clean, ${shown ? 'in a text editor' : 'not shown'}`,
        uri,
        'firstEdit',
        async () => {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(uri, new vscode.Position(0, 0), 'x');
          assert.equal(await vscode.workspace.applyEdit(edit), true);
        },
      );
    }
    {
      const uri = writeFile('assumptions/dirty-flag-panel.md', 'panel\n');
      await openRich(uri);
      await observe('typing in the rich editor (a panel push), starting clean', uri, 'firstEdit', () =>
        hook.runInPanel(uri, [{ type: 'insert', at: 0, text: 'word ' }, { type: 'flush' }]),
      );
    }
    {
      const uri = writeFile('assumptions/dirty-flag-after-save.md', 'after save\n');
      const editor = await openText(uri);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'one '));
      await editor.document.save();
      await observe('the first edit after a save', uri, 'firstEdit', () =>
        editor.edit((b) => b.insert(new vscode.Position(0, 0), 'two ')),
      );
    }

    // Save participants: trim trailing whitespace, insert a final newline, format on save.
    const restore: (() => Promise<void>)[] = [];
    const formatter = vscode.languages.registerDocumentFormattingEditProvider(
      { language: 'markdown', pattern: '**/assumptions/dirty-flag-save-*.md' },
      {
        provideDocumentFormattingEdits: (doc) => {
          const first = doc.lineAt(0);
          return first.text.startsWith('formatted ') ? [] : [vscode.TextEdit.insert(first.range.start, 'formatted ')];
        },
      },
    );
    try {
      restore.push(await setSetting('files', 'trimTrailingWhitespace', true));
      restore.push(await setSetting('files', 'insertFinalNewline', true));
      restore.push(await setSetting('editor', 'formatOnSave', true, 'markdown'));
      for (const start of ['dirty', 'clean'] as const) {
        const uri = writeFile(`assumptions/dirty-flag-save-${start}.md`, 'trailing   \nno final newline');
        const editor = await openText(uri);
        if (start === 'dirty') await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'edited '));
        // VS Code's own save command (Ctrl+S), which also saves a clean file when asked.
        await observe(
          `Ctrl+S on a ${start} file with trim, final newline and format on save`,
          uri,
          start === 'dirty' ? 'saveDirty' : 'saveClean',
          async () => {
            await vscode.commands.executeCommand('workbench.action.files.save');
            await pause(SAVE_STEPS_MS);
          },
        );
        note(
          `  after Ctrl+S on the ${start} file: ${JSON.stringify(editor.document.getText())}, dirty ${editor.document.isDirty}`,
        );
      }
    } finally {
      formatter.dispose();
      for (const r of restore.reverse()) await r();
    }

    {
      const uri = writeFile('assumptions/dirty-flag-reload.md', 'reload me\n');
      const editor = await openText(uri);
      await observe('VS Code reloading a clean document after an outside write', uri, 'reload', async () => {
        writeFile('assumptions/dirty-flag-reload.md', 'reloaded\n');
        await waitFor(() => editor.document.getText() === 'reloaded\n', 'the reload');
      });
    }
    {
      const uri = writeFile('assumptions/dirty-flag-revert.md', 'revert me\n');
      const editor = await openText(uri);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'dirty '));
      await observe('Revert File', uri, 'revert', () =>
        vscode.commands.executeCommand('workbench.action.files.revert'),
      );
    }
    {
      const uri = writeFile('assumptions/dirty-flag-undo.md', 'undo me\n');
      const editor = await openText(uri);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'typed '));
      await observe('undo back to the saved version', uri, 'undoToSaved', () => vscode.commands.executeCommand('undo'));
    }

    for (const r of results) note(`${r.label}: ${describe(r.events)}`);
    const wrong = results.flatMap((r) => problems(r.kind, r.events).map((p) => `${r.label}: ${p}`));
    assert.deepEqual(wrong, [], 'cases where VS Code did not report the dirty flag as recorded above');
    // The reason the core infers nothing from the flag: an edit and a reload arrive alike.
    const cleanUnexplained = (events: Seen[]) =>
      events.some((e) => e.changes > 0 && !e.dirty && e.reason === undefined);
    assert.ok(
      results.some((r) => r.kind === 'firstEdit' && cleanUnexplained(r.events)) &&
        results.some((r) => r.kind === 'reload' && cleanUnexplained(r.events)),
      'an edit and a reload did not look alike',
    );
  });

  test('the change event of an applied WorkspaceEdit arrives before applyEdit resolves', async () => {
    const results: string[] = [];
    for (const where of ['not shown', 'in a text editor', 'in the rich editor'] as const) {
      const uri = writeFile(`assumptions/apply-edit-${where.replace(/ /g, '-')}.md`, 'start\n');
      let doc: vscode.TextDocument;
      if (where === 'not shown') doc = await vscode.workspace.openTextDocument(uri);
      else if (where === 'in a text editor') doc = (await openText(uri)).document;
      else doc = await openRich(uri);
      let late = 0;
      let applied = 0;
      for (let i = 0; i < 25; i++) {
        let seen = false;
        const sub = vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document === doc && e.contentChanges.length > 0) seen = true;
        });
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, `${i} `);
        const ok = await vscode.workspace.applyEdit(edit);
        const seenAtResolve = seen;
        sub.dispose();
        if (ok) applied++;
        if (ok && !seenAtResolve) late++;
      }
      results.push(`${where}: ${applied} applied, ${late} resolved before their event`);
      assert.equal(applied, 25, `every edit applied (${where})`);
      assert.equal(late, 0, `no applyEdit resolved before its change event (${where})`);
    }
    for (const r of results) note(r);
  });

  test('"Save without Formatting" runs no will-save, and two in a row bring no warning', async () => {
    const hook = await api();
    const uri = writeFile('assumptions/save-without-formatting.md', 'save without formatting\n');
    const editor = await openText(uri);
    let willSave = 0;
    const sub = vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document === editor.document) willSave++;
    });
    const warned = () => hook.notices().filter((n) => n.notice.kind === 'saveCheckOff').length;
    const editAndSave = async (word: string) => {
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), word));
      await vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
      await waitFor(() => !editor.document.isDirty, 'the save');
      await pause(SAVE_STEPS_MS);
    };
    try {
      await editAndSave('one ');
      const afterOne = warned();
      note(
        `one Save without Formatting: will-save ran ${willSave} time(s); the "save check is not running" warning ${afterOne ? 'was raised' : 'was not raised'}`,
      );
      // Such a save says nothing about the save check: only VS Code's count of the step running
      // past its limit does, and a step that ends in time is never counted.
      assert.equal(afterOne, 0, 'the "save check is not running" warning was raised after one Save without Formatting');
      await editAndSave('two ');
      const afterTwo = warned();
      note(`two in a row: will-save ran ${willSave} time(s); the warning was raised ${afterTwo} time(s)`);
      assert.equal(willSave, 0, 'Save without Formatting ran will-save');
      assert.equal(afterTwo, 0, 'two saves in a row with no will-save raised the warning');
    } finally {
      sub.dispose();
    }
  });

  test("an edit to a closed document's uri lands on a fresh copy of the file, with no version check", async () => {
    const uri = writeFile('assumptions/closed-document.md', 'first line\n');
    // Opened by the workbench, not by this extension, so nothing else holds the document open.
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor(() => !!documentFor(uri), 'the document to open');
    const doc = documentFor(uri)!;
    const closedAt = new Promise<number>((resolve) => {
      const sub = vscode.workspace.onDidCloseTextDocument((d) => {
        if (d !== doc) return;
        sub.dispose();
        resolve(Date.now());
      });
    });
    const asked = Date.now();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(() => doc.isClosed, 'the document to close with its editor', 20_000);
    note(`the document closed ${(await closedAt) - asked} ms after its editor was asked to close`);

    // Another program adds a line; an edit worked out against the closed document's text adds the same line.
    writeFile('assumptions/closed-document.md', 'first line\nsecond line from another program\n');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(1, 0), 'second line from another program\n');
    const ok = await vscode.workspace.applyEdit(edit);
    const copy = documentFor(uri);
    note(
      `applyEdit on the closed document's uri resolved ${ok}; VS Code now holds ${copy ? `a new document, ${copy.isDirty ? 'dirty' : 'clean'}: ${JSON.stringify(lf(copy.getText()))}` : 'no document'}`,
    );
    assert.equal(ok, true, 'VS Code applied the edit');
    assert.ok(copy && copy !== doc, 'to a new document for the same file');
    assert.equal(
      lf(copy.getText()),
      'first line\nsecond line from another program\nsecond line from another program\n',
      'loaded from the file as it is now, with the edit applied on top: the line twice',
    );
    assert.equal(copy.isDirty, true, 'the copy is unsaved, and nothing shows it');
  });
});
