# Known issues

This file lists the faults in Tandem Markdown that are known and not yet fixed. Each entry says what you see, when you would meet it, how to reproduce it where a way is known, its status, and where it lives in the code. If you met something odd, look for it here first. If you want to help, start with the issues marked as a good first contribution.

## How each issue is filed

Every issue has one of four statuses:

- **fix in progress**: a fix is being built now, so it is not one to pick up.
- **open**: a fix is planned and not started. A pull request is welcome.
- **known quirk**: minor, and accepted for now. A fix is welcome.
- **upstream**: the cause is in another project, named here with its version. A report to that project is to be filed.

**Good first contribution** marks an issue whose fix is small, sits in one place, and can be tested without the simulation. Before a change of any size, read the first three sections of `docs/ARCHITECTURE.md`, as `CONTRIBUTING.md` asks.

## What is not listed here

Known behavior that the published documents state for users is not repeated here. It sits in three places:

- **Limits**, in [Using Tandem Markdown, "Limits"](GUIDE.md#limits) and [When an agent or another program changes your note, "Limits"](WORKING_WITH_AGENTS.md#limits): what the extension cannot do or cannot promise. Some limits come from VS Code itself or from timing, such as a half-written file read as finished, or a change another program makes in the instant VS Code saves. Others do not: it needs the desktop app, untitled files lack some features, only UTF-8 and UTF-16 files are merged, and each rich tab takes memory. What it needs, and how far it has been tested, is on the README's first screen. `docs/ARCHITECTURE.md`, "Outside changes", "Limits", gives the limits of outside changes with their mechanisms.
- **Drawing**, in the syntax reference's [Shown as typed](SYNTAX.md#shown-as-typed) and [Drawn wrongly](SYNTAX.md#drawn-wrongly): the markdown the rich views show as typed, and what they draw wrongly, such as `plan~was~` drawn as subscript.

If what you met is described there, it is known.

## Replaying a seed of the simulation

The calibrated invariant suite lives in `test/sync/simulation.test.ts` (and 20 explicit scenarios in `test/sync/scenarios.test.ts`). To run a specific seed with a full event trace:

```sh
SIM_FIRST=2254 SIM_RUNS=1 SIM_TRACE=1 npx vitest run test/sync/simulation.test.ts
```

In PowerShell, set `$env:SIM_FIRST`, `$env:SIM_RUNS`, and `$env:SIM_TRACE='1'` first. Every actor writes numbered markers such as `⟦12⟧`, so a failure names the exact text involved.

## The issues

| # | Issue | Status | How often a user meets it | Good first contribution |
|---|---|---|---|---|
| [1](#1-the-repeat-check-can-refuse-a-merge-that-repeats-nothing) | The repeat check can refuse a merge that repeats nothing | known quirk | Rare |  |
| [2](#2-a-change-both-sides-made-can-be-taken-as-a-clash-when-one-side-also-changes-the-lines-around-it) | A change both sides made can be taken as a clash when one side also changes the lines around it | known quirk | Uncommon |  |
| [9](#9-a-backup-written-during-a-rename-keeps-the-old-name) | A backup written during a rename keeps the old name | known quirk | Extremely rare |  |
| [10](#10-see-diff-for-a-version-held-in-memory-opens-the-old-path-after-a-rename) | See Diff for a version held in memory opens the old path after a rename | known quirk | Extremely rare |  |
| [11](#11-a-conflict-file-can-name-a-backups-old-path-after-a-rename) | A conflict file can name a backup's old path after a rename | known quirk | Extremely rare |  |
| [12](#12-a-note-moved-by-another-program-loses-its-backups-and-its-place-if-also-edited) | A note moved by another program loses its backups (and its place if also edited) | known quirk | Common with git or a file manager |  |
| [15](#15-after-a-failed-resolve-in-source-a-command-gets-the-conflicts-place) | After a failed Resolve in Source, a command gets the conflict's place | known quirk | Extremely rare |  |
| [16](#16-two-list-shapes-are-drawn-differently-from-commonmark) | Two list shapes are drawn differently from CommonMark | upstream | Rare |  |

### Merging and the save step

#### 1. The repeat check can refuse a merge that repeats nothing

**Status:** known quirk. **How often:** rare.

**What you see.** You and another program change a note in a way that could have merged, while you have unsaved changes, and Tandem Markdown falls back to a safe handoff instead. Nothing is lost, and a short message tells you. Your note stays as it was, the other program's version goes to a backup and the conflict file, "See Diff" compares the two, and "Replace My View" on the diff's title bar replaces your view if you prefer the disk version.

**When you meet it.** In four shapes. The first three happen only while Tandem Markdown is not sure what text your note and the file both started from. It is sure once a read of the file has found your note holding the same text, as long as you have not undone, redone, or reloaded since; while it is sure, what you both added counts as two additions, and these merge.

- **A line or a phrase that holds an uncommon word, added by both of you at different places,** such as "Call the plumber." under two headings. A word counts as uncommon when each of the two texts holds it at most twice, so in a short note most words do.
- **A table row,** added by both of you at different places in a table.
- **A short run of marks around a word or part of one,** such as a footnote mark `[^n]` or `(sic)`, added by both of you in different lines.
- **A line of markup alone that the note holds several times, such as `* * *`,** where the other program added it at one place and took it out at another, and you had changed the place where it took it out. The merge keeps your lines at that clash, so it holds the line once more than either side, and the check refuses the whole change. This one can happen whether or not Tandem Markdown is sure of the starting text.

**Why it still hands off.** When the text both sides started from is older than both, a three-way merge can write one person's addition twice, and the result looks exactly like two people adding the same words at two places. The texts alone cannot tell the two apart. So in these shapes Tandem Markdown hands off safely, which loses nothing and tells you, rather than risk doubling text in your note.

**Reproduce.** Against the merge's check alone, with a scratch test under `test/core/` (do not commit it). It fails today, showing one conflict over the whole text and your side kept; it passes once such merges go through:

```ts
// test/core/scratch.test.ts
import { expect, it } from 'vitest';
import { safeMerge } from '../../src/core/safeMerge';

it('merges a line both sides added at different places', () => {
  const base = 'Plans.\nBudget.\n';
  const ours = 'Plans.\nCall the plumber.\nBudget.\n';
  const theirs = 'Plans.\nBudget.\nCall the plumber.\n';
  expect(safeMerge(base, ours, theirs, 'ours')).toEqual({
    text: 'Plans.\nCall the plumber.\nBudget.\nCall the plumber.\n',
    conflicts: [],
  });
});
```

```sh
npx vitest run test/core/scratch.test.ts
```

`merge3` alone gives that text with no conflicts; `safeMerge` refuses it. With `{ exactBase: true }` as its sixth argument, `safeMerge` merges it.

**Where.** `repeatsText` in `src/core/safeMerge.ts` (`docs/ARCHITECTURE.md`, "Merging", "The repeat check"). The first three shapes are its run test: a run of three tokens within one line, one of them rare (`RARE_TOKEN`), that both sides' changes brought in and the merge holds more often than each side. The fourth is its first line count: a line the merge holds more often than each side and than both sides' changes give it together, which does not allow for a clash keeping one side's lines. A fix needs another sign that a change was applied twice, since the texts give none.

#### 2. A change both sides made can be taken as a clash when one side also changes the lines around it

**Status:** known quirk. **How often:** uncommon.

**What you see.** You and another program make the same change in a note, such as deleting the same word, and one of you also changes the lines around it: adds a list item after that line, breaks the line in two, or edits the next line. Tandem Markdown reports that you both changed the same place, where the two changes could have merged. Under the default setting your text is kept as you left it there, the other program's change goes to a backup and to the conflict file, and "See Diff" opens the comparison with "Use Change from Disk" in its title bar.

**When you meet it.** You and an agent fix the same word in a list item, and the agent also adds an item after it. Where the agent adds the item and leaves the word alone, the two merge.

**Reproduce.** Against the merge alone, with a scratch test under `test/core/` (do not commit it). It fails today, showing one conflict and the text `'- [ ] buy milk\n- [ ] call\n'`; it passes once the two changes merge cleanly:

```ts
// test/core/scratch.test.ts
import { expect, it } from 'vitest';
import { merge3 } from '../../src/core/merge3';

it('merges a word both sides deleted, beside an item the other side added', () => {
  const r = merge3('- [ ] buy old milk\n- [ ] call\n', '- [ ] buy milk\n- [ ] call\n', '- [ ] buy milk\n- [ ] bread\n- [ ] call\n');
  expect(r).toEqual({ text: '- [ ] buy milk\n- [ ] bread\n- [ ] call\n', conflicts: [] });
});
```

```sh
npx vitest run test/core/scratch.test.ts
```

Each of these gives one conflict too:

- `merge3('alpha beta gamma one two three epsilon\n', 'alpha gamma one two three epsilon\n', 'alpha gamma one two three\nepsilon\n')`: both delete `beta`, and the other side also breaks the line.
- `merge3('one\ntwo\n', 'one\nshared\ntwo!\n', 'one\nshared\ntwo\n')`: both add the line `shared`, and your side also edits the next line.
- `merge3('- [ ] buy old milk\n- [ ] call mom\n', '- [ ] buy milk\n- [ ] call mom today\n', '- [ ] buy milk\n- [ ] call mom\n')`: both delete `old`, and your side also edits the next item.

**Where.** `merge3` in `src/core/merge3.ts`. In each example, the change both sides made is read as one stretch with the changes around it. Where a side's change inserts or deletes a line break, its new lines pair with the old ones only by reading, and those lines are in doubt (`LineRun.doubt`). Where the two sides' runs of changed lines meet and wrote the same line, they may hold one line written twice (`joinRunsSharingLines`). `GroupJoins` merges a stretch joined in either way only where both sides made the same change in all of it. `docs/ARCHITECTURE.md`, "Merging", "Every reading", gives the rules.

### The extension host: messages, backups, renames and the default editor

#### 9. A backup written during a rename keeps the old name

**Status:** known quirk. **How often:** extremely rare.

**What you see.** After you rename a note in VS Code, one of its backups is not listed for it in "Compare with Backup". The backup stays in the backup folder under the note's old name.

**When you meet it.** Only when a backup of the note starts to be written as the note closes, during the rename.

**Reproduce.** Not reproduced yet.

**Where.** `renameBackups` in `src/host/backups.ts` waits for the backups already being written, then renames those it finds; a backup started after that wait keeps the old name and the old note's tag.

#### 10. See Diff for a version held in memory opens the old path after a rename

**Status:** known quirk. **How often:** extremely rare.

**What you see.** When no backup can be written (a full disk, say), the other program's version is kept in memory and opened in an unsaved tab. If you rename the note and then press "See Diff" on the message from before the rename, the comparison opens against the note's old path.

**When you meet it.** A backup that could not be written, then a rename before you compare.

**Reproduce.** Not reproduced yet.

**Where.** `BackupViews.compareVersion` in `src/host/backupViews.ts` compares against the document the message holds. Backups on disk follow a rename through `movedTo`; versions held in memory do not.

#### 11. A conflict file can name a backup's old path after a rename

**Status:** known quirk. **How often:** extremely rare.

**What you see.** The conflict file beside a renamed note names a backup by its old path, which no longer exists.

**When you meet it.** Only when a part is added to the conflict file at the instant the rename lands.

**Reproduce.** Not reproduced yet.

**Where.** `ConflictFiles.backupsMoved` in `src/host/conflictFiles.ts` gives the new path to the parts that exist when the backups are renamed; a part added just after keeps the path it was given.

#### 12. A note moved by another program loses its backups (and its place if also edited)

**Status:** known quirk. **How often:** common with git or a file manager.

**What you see.** After git, a file manager or a sync tool moves or renames a note, its earlier backups are not listed for it. If the file's text is unchanged and the old path is gone, Tandem Markdown still restores its scroll place from its content hash; if the move also changed the file's text, it opens at the top.

**When you meet it.** Whenever a note is moved outside VS Code.

**Reproduce.** Create a backup for a note, close it, move it with `git mv` in a terminal or in a file manager, and open "Compare with Backup".

**Where.** `renameBackups` in `src/host/backups.ts` follows only the renames VS Code reports (`workspace.onDidRenameFiles`). VS Code reports a move by another program as a deletion and a creation, and pairing backups by a guess could give one note's backups to another. `src/host/viewPlaces.ts` transfers a deleted note's scroll place on an unambiguous exact content-hash match only.

### The editor panel

#### 15. After a failed Resolve in Source, a command gets the conflict's place

**Status:** known quirk. **How often:** extremely rare.

**What you see.** In a rich tab showing git's conflict markers, "Resolve in Source" can fail to switch the tab to Source. Until you move the cursor, a command that reads the tab's place, such as "Copy Relative Path with Line Numbers", gets the conflict's place, not the cursor's.

**When you meet it.** Only when the switch fails, which happens when the panel cannot hand over all of its typing first.

**Reproduce.** Not reproduced yet.

**Where.** `resolveInSource` in `src/panel/render/conflicts.ts` reports the conflict's place through `reportPlace` (`src/panel/reports.ts`), which keeps reporting it until the selection, the text or the mode next changes. The host abandons the switch when the panel's flush is not clean (`src/host/modeSwitch.ts`).

#### 16. Two list shapes are drawn differently from CommonMark

**Status:** upstream. **How often:** rare.

**What you see.** In the rich views, text after a blank line is drawn inside or outside a list item differently from CommonMark. Only the drawing differs: the file is never changed.

A list item whose marker stands alone on its line:

```markdown
-
  later

  more
```

`more` is drawn as a paragraph after the list, where CommonMark keeps it in the item.

```markdown
1.

   foo
```

`foo` is drawn inside the item, where CommonMark ends the item at the blank line.

A tab after a quote's `>`, before a list (the first line below has a tab after `>`):

```markdown
>	- tab
>
>     more
```

`more` is drawn as a code block after the list, where CommonMark reads it as a paragraph in the item. With a space after the first `>` instead of the tab, it is drawn as CommonMark reads it.

**When you meet it.** Only with these shapes, which are unusual in notes.

**Reproduce.** Paste any of the three into a note, or into the harness page (`npm run harness`). The parser alone shows it: `parser.parse` from `@lezer/markdown` puts the text outside or inside the item as described.

**Where.** `@lezer/markdown` 1.8.1. The list item's continuation in `DefaultSkipMarkup` ends an item that began with a blank line at the next blank line, even after content, and `OrderedList` never marks an item with nothing after its marker. The opening of a quote (`isBlockquote`) takes only a space as the optional space after `>`, while the quote's continuation takes a tab too. A report to `@lezer/markdown` is to be filed.

## Upstream reports still to be filed, handled here

These have their cause in another project. Each is handled here, or reached only through a fault of this project's own, as the last column says, and each needs a report to its project. Keep the handling in place until that project fixes the cause.

| Package | What it does | How it is handled here |
|---|---|---|
| `@codemirror/state` 6.7.6 | `ChangeSet.map` between change sets of different lengths can loop forever instead of throwing "Mismatched change set lengths", and returns without comparing lengths when the other set is empty | Reached only after a fault in the sync has put the panel's change sets out of step with the document. If a panel freezes while you work on the sync, look for that fault first |
| `@codemirror/view` 6.43.15 | Each measure reads the page's selection without asking the widget under it (`ignoreEvent`), so a caret the browser puts in a widget's text can become the editor's cursor when the measure runs before the `selectionchange` handler, which does ask | `keepSelectionWhilePressed` and `leaveSelectionOnClick` in `src/panel/render/framework.ts`: while a press that began on a drawing is held, a transaction that only moves the selection is dropped, and when the press ends the caret goes back to the cursor, or a selection it made is told to the editor |
| `@codemirror/lang-markdown` 6.5.2 | Enter on a later line of a numbered item (`insertNewlineContinueMarkup`) renumbers the next item | `continuesItemOnly` in `src/panel/commands/typing.ts` drops the renumbering |
| VS Code 1.146.0 | Copilot's review of its edits (the bar with Keep and Undo) does not attach to a custom text editor | The "Review in Source" button on a rich tab (`WORKING_WITH_AGENTS.md`, "Copilot's review, and Copy Relative Path with Line Numbers") |
| VS Code 1.146.0 | A rich tab's group becomes the active one again after a text editor opens beside it, while typing still goes to the text editor | A stated limit: `GUIDE.md`, "Limits" |
