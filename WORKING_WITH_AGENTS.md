# When an agent or another program changes your note

Tandem Markdown watches the file of every note you have open. When another program writes that file, Tandem Markdown merges the change into your note, even over typing you haven't saved, and tells you only when it can't.

Here your note is the text you work on in VS Code, with any typing you haven't saved, and the file is what is saved on disk. The examples use one note, `Field notes.md`, in a folder called `notes`.

## Who writes to an open note

- An agent that writes the file on disk, such as Claude Code.
- An agent inside VS Code that edits your note, such as Copilot, whose own review lets you keep or undo each of its changes (see [Copilot's review](#copilots-review-and-copy-relative-path-with-line-numbers)).
- git, when a pull, a checkout, or a stash changes the file.
- A sync tool or a shared folder, carrying a colleague's edits from their computer to yours.

Tandem Markdown merges every write to the file the same way, whichever program made it. Where it can't settle a change, it writes the change up in a conflict file beside the note, for your agent. The one exception is git. A write that leaves the file exactly as git's last commit has it, as a pull, a checkout, or a stash does, counts as git's own, whoever made it. For such a write no conflict file is written: what can't be merged stays in a backup, and a message lets you compare it with your note.

You and a colleague each edit your own copy of the file, and their changes reach you when their copy of the file reaches yours, not as they type.

## What merges with no message

- **Most changes merge silently**, even over unsaved typing, and your typing stays where it is. In the Rich editor and the Rich view each line that changed is outlined until you have seen it, and the outline fades after a few seconds. If you use a screen reader, it tells you in one sentence, once the changes stop and you pause typing, how much changed and under which heading.
- **Lines added by both sides at one place:** when you add lines in unsaved typing and another program adds different lines at the exact same gap (such as the end of a note), both are kept, yours first, as long as Tandem Markdown knows the exact starting text. Right after an undo, redo, or reload, Tandem Markdown treats the overlap as a clash so nothing is doubled.
- **A note with nothing unsaved always follows the file**, taking the new file as it is, just as VS Code does. Before replacing the note's text, Tandem Markdown saves a quiet backup of the previous version. Because a saved file belongs to the file on disk rather than to one writer, telling an agent to edit or remove something you just saved goes straight in without Tandem Markdown fighting it.
- **Line-ending-only changes count as nothing.** A file whose line endings flipped between CRLF and LF raises no message and leaves your cursor alone.

## Can you lose anything?

Most of what other programs write goes into your note, or is kept where you can get it back, and you are told. These are the known cases where something can be lost. Faults not yet fixed are in [Known issues](KNOWN_ISSUES.md).

### When something you do can lose text

| What you do | What can be lost | A copy kept | You are told |
|---|---|---|---|
| Press Undo (`Ctrl+Z`, or `Cmd+Z` on a Mac) after another program's change came in, then save | That program's change: Undo takes it out, as it takes out your own typing | No | No, though you see it go |
| Use "Save without Formatting" just after another program wrote the file | That program's change | No | No |
| Save after a conflict message where your text was kept | That other change, from the file on disk | Yes: in a backup, and in the conflict file for your agent | Yes, in the message |
| Save while one of the [two warnings in the status bar](#two-warnings-in-the-status-bar) shows | A change another program makes as you save | No | Yes, by the warning |
| Close a tab with a tap on a touchscreen within half a second of typing, with nothing else unsaved in the note (or another extension closes it) | The last word you typed | No | No |
| Type in VS Code's own Markdown Editor or another extension's WYSIWYG editor, with auto-save on | A key pressed at the instant VS Code reloads the file or a change is merged | No | No |
| Set `whenBothChanged` to `keepTheirs`, and change the same words as another program | Your conflicting words | Yes | Yes, and the strip offers "Undo" |

### When two things happen at the same moment

| What happens | What can be lost | A copy kept | You are told |
|---|---|---|---|
| Another program writes the file in the ~2 ms gap while VS Code writes a save ([A save at the instant another program writes](#a-save-at-the-instant-another-program-writes)) | That program's change | No | No |
| Another program writes the file as you close the note, before Tandem Markdown reads it | That change is left on disk as written | On disk | No |
| You close the note's last tab just after typing in the Rich editor while VS Code is busy, saving, or merging, and the note has nothing else unsaved ([When your last typing never reached the note](#when-your-last-typing-never-reached-the-note)) | What you typed last, from the file | Yes: in a backup, or in a new unsaved tab when no backup can be written | Yes, and the strip offers "Put My Typing Back" |
| A half-written file stays cut short after a retry ([A half-written file](#a-half-written-file)) | On a dirty note, nothing is lost; on a clean note, the editor follows the file | Yes: quiet backup + conflict file part | Yes, in the Problems list and conflict file |
| You move a line past other lines, and another program deletes that line where it stood before you save | That program's deletion: the line stays where you put it | No | No |

Backups themselves are deleted after 30 days, or once 200 newer ones have been written, with nothing said ([Backups](#backups)).

## Messages, the tab-top strip, and diff buttons

Messages appear one pop-up at a time in plain, single-sentence wording so they never pile up or flood the corner of the window:

- **Pop-up with "See Diff" and "Dismiss":** shown when your text was kept (a clash, an ambiguous merge, a restored dirty note whose file changed, a persistently cut-short file while dirty, or a non-UTF / unreadable encoding change). Pressing "See Diff" opens VS Code's diff with the disk version read-only on the left and your note on the right.
- **Diff title-bar choices:** while viewing that diff tab, the diff's title bar offers **"Use Change from Disk"** (for a clash, applying the disk version at the conflicting passages while keeping your other edits) or **"Replace My View"** (when the whole file could not be merged safely).
- **Tab-top message strip:** messages that offer an undo or recovery action ("Undo", "Put My Text Back", or "Put My Typing Back") stay in a thin strip at the top of the note's rich tab until you press the action or "Dismiss", so a timed-out VS Code notification never costs you an action. While any message is waiting, a separate status bar item ("1 message for you") and the Command Palette command "Tandem Markdown: Go to Waiting Message" take you straight to it.

### Message reference (for `Field notes.md`)

- **Overlapping edits (`keepMine`, default):**
  - *Both you and another program edited Field notes.md; your words were kept at the clash and the rest merged.* (or *...your words were kept.* when nothing else changed)
  - Buttons: "See Diff", "Dismiss". Diff title bar: "Use Change from Disk".
- **Safe handoff (ambiguous origin, restored dirty note, truncated file while dirty, or non-UTF encoding):**
  - *Field notes.md changed on disk and couldn't be merged automatically; your text was kept.*
  - *Field notes.md changed on disk while you had unsaved changes from an earlier session; your text was kept.*
  - *Field notes.md on disk looks cut short while you have unsaved changes; your text was kept.*
  - *Field notes.md changed on disk in an encoding Tandem Markdown couldn't merge; your text was kept.*
  - Buttons: "See Diff", "Dismiss". Diff title bar: "Replace My View" (except encoding, which is comparison-only).
- **Disk words applied (`keepTheirs`, "Use Change from Disk", "Replace My View", or reload over your text):**
  - *Another program's changes replaced yours in Field notes.md.*
  - *Field notes.md now has the change from disk.*
  - *Field notes.md was replaced with the version from disk.*
  - *VS Code reloaded Field notes.md from disk over your text.*
  - Stays in the tab-top strip with "Undo" (or "Put My Text Back"), "See Diff", and "Dismiss".
- **Note closed with a pending external change:**
  - *Field notes.md closed before an external change could merge; a backup was saved.* (or *...the disk version is open in an unsaved tab.* when no backup could be written)
  - Buttons: "See Diff", "Dismiss".
- **When a button can no longer act:**
  - A short warning explains why without changing your note, for example *Nothing was changed because you edited Field notes.md where those changes landed.* or *Nothing was changed because Field notes.md is closed.*

### When your last typing never reached the note

- *Your last typing on 2 lines of Field notes.md hadn't reached VS Code when the tab closed; a backup was saved.* (or *...a copy is open in an unsaved tab.*)
- Stays in the tab-top strip once reopened, with "Put My Typing Back", "See Diff", and "Dismiss". "Put My Typing Back" opens the note in the Rich editor with your typing restored unsaved, as long as the file has not changed since it closed.

## The conflict file

`Field notes.md.conflict` sits beside the note and is written for your agent. Its top explains that the note is open in Tandem Markdown, that nothing has been lost, and that the agent should read the note again, apply any changes still needed directly in the note, and then delete the `.conflict` file.

Each unsettled event is added as a numbered factual section with a timestamp, the backup path (when one was written), and the quoted passages or versions involved:

- **Overlapping edits:** quotes each conflicting passage with its line number and surrounding heading/anchor line (`User kept:` and `Your version on disk:`).
- **Safe handoff (`handoff`, `noBase`, `truncated`, `encoding`, `closedWithPending`):** explains why the change was not merged automatically and quotes the disk version (capped with an omission note and backup path for very long files).
- **Truncated clean follow:** when a clean note followed a file that stayed cut short after its retry, quotes the earlier version and the cut-short disk version alongside the backup path.

When you are ready for your agent to finish its change:

1. If you want any of the other program's words in your note yourself, press "See Diff" and copy them or press "Use Change from Disk" / "Replace My View" in the diff's title bar.
2. Save the note. Your agent reads the note's file on disk, so saving puts your words there while the backup and `.conflict` file preserve the other version.
3. Give your agent the sentence that "Tandem Markdown: Copy Prompt for Agent" copies.

Working with conflict files in VS Code:

- **Status bar:** one item counts the open changes waiting for your agent ("Tandem: 1 change"); clicking opens the conflict file (or asks which one when there are several). While any strip message is waiting on a tab, a separate speech-bubble item ("1 message for you") shows beside it; click it or run "Tandem Markdown: Go to Waiting Message" from the Command Palette to jump straight there.
- **Problems panel:** adds a warning from `Tandem Markdown` on each affected line, linked directly to the `.conflict` file.
- **Copy Prompt for Agent:** copies `Tandem Markdown wrote "notes/Field notes.md.conflict" beside "notes/Field notes.md". Read it and do what it says.` (or a list of files when several notes have open conflict files).
- **Automatic cleanup:** settling a conflict through "Use Change from Disk" or "Replace My View" removes its part from the `.conflict` file and deletes the file once its last part is settled. Deleting the `.conflict` file yourself, or your agent deleting it, clears its warnings and leaves your note untouched.
- **Persistence:** conflict files stay on disk if you close the note or restart VS Code.

A conflict file is not the same as git's conflict markers (`<<<<<<<`) inside a note, which git writes during a merge. [Using Tandem Markdown](GUIDE.md#gits-conflict-markers) says how those are shown.

## Setting up your agent

An agent busy with a note has no reason to look for a conflict file unless something tells it to, so give it a few lines of instructions.

### The offer

The first time Tandem Markdown writes a conflict file in a workspace, it asks:

> Update AGENTS.md so your agent knows how to work with Tandem Markdown?

Its buttons are "Update AGENTS.md" (which updates `AGENTS.md` and writes `.claude/rules/tandem-markdown.md`), "Copy instructions", and "Don't ask again". It does not ask when both files already hold the instructions.

### Add Agent Instructions

"Tandem Markdown: Add Agent Instructions" shows the exact lines and where they will go before it writes anything, and writes only when you press "Add the instructions". It adds them at the end of `AGENTS.md` in the workspace folder (or creates `AGENTS.md`), and writes `.claude/rules/tandem-markdown.md`, a rule file Claude Code loads whenever it reads or edits markdown or text files. It never changes `CLAUDE.md` or `.gitignore`. If your `AGENTS.md` has a "Tandem Markdown" section you edited by hand, is a link to another file, or isn't saved as UTF-8, it is left untouched and the reply offers to copy the instructions.

The lines it adds:

```markdown
## Tandem Markdown

Markdown files here may be open in the Tandem Markdown editor while you edit
them, and your edits are merged into the open note automatically. Two habits
keep that working:

- Read a note again just before you write to it.
- Before and after you write to a note, look for a file beside it with the same
  name plus ".conflict" (for "Field notes.md", "Field notes.md.conflict"). If it
  is there, read it and do what it says before going on.
```

### Which agents read them

Claude Code reads `.claude/rules/tandem-markdown.md`. Copilot in VS Code reads `AGENTS.md` at the top of the workspace while `chat.useAgentsMdFile` is on.

To have Claude Code reminded after every edit, you can add a `PostToolUse` hook on its Edit and Write tools that checks for `<path>.conflict` and tells Claude to read it; see [Claude Code's guide to hooks](https://code.claude.com/docs/en/hooks-guide).

## Copilot's review, and Copy Relative Path with Line Numbers

Copilot's review of its edits, the bar with Keep and Undo for each change, appears only in Source, because VS Code shows it only in its own text editor. Keep and Undo also work from the chat view. While Copilot has changes waiting in a note, a tab showing that note in the Rich editor or the Rich view has a "Review in Source" button at the top right, which switches the tab to Source at the place you are.

Agents read what you select in VS Code's text editor, and the Rich editor and the Rich view aren't that editor. So in either of them, "Tandem Markdown: Copy Relative Path with Line Numbers" puts the note's path and the selected lines on the clipboard, `notes/Field notes.md:12-18`, to paste into any agent's chat. With nothing selected, it copies the line the cursor is on, `notes/Field notes.md:12`.

- The line numbers are the file's, as Source shows them, front matter included.
- The path starts at the workspace folder, with forward slashes on every system. A note outside every folder gets its full path.
- If the note has unsaved changes, it reminds you to save so an agent reading the file finds the same lines.

## Backups

- Whenever Tandem Markdown sets aside or replaces text, a copy goes to a backup first: the other program's version when your words are kept, and a copy of your text whenever your words are replaced (including a quiet backup whenever a clean note follows an outside rewrite).
- Backups are kept in VS Code's own extension storage, not in your workspace. "Tandem Markdown: Open Backup Folder" opens the folder.
- A backup's name says which note it is for and what it holds, such as "other program's version" or "copy of your text".
- The Compare with Backup button sits in the note's tab bar, at the top right of its tabs. It lists the note's backups, newest first, and opens the one you pick beside your note. Each row has a "Copy path" button, to hand that backup to an agent.
- The button shows once a message or warning has named a backup of the note, and stays until you choose "Done with these backups" at the end of the list. Quiet backups do not bring up the button, though they still appear in the list.
- Each time Tandem Markdown starts in a VS Code window, it deletes backups more than 30 days old, and all but the newest 200 (quiet backups are pruned separately to the newest 50). A backup named by an open conflict file is never deleted.
- If a backup cannot be written (for example, a full disk), Tandem Markdown opens the preserved text immediately in a new unsaved tab so nothing is lost.

## Keeping conflict files out of git and your sync

A conflict file can quote words you have typed and not saved. It sits beside the note, so it syncs with the folder, and `git add -A` commits it. To keep conflict files out of git, add these lines to `.gitignore`:

```gitignore
*.md.conflict
*.markdown.conflict
*.txt.conflict
```

If your sync tool keeps a list of files to ignore, add the same patterns there, or turn conflict files off with `tandemMarkdown.conflictFiles` (backups are kept either way).

## Settings for other writers

| Setting | Default | What it does |
|---|---|---|
| `tandemMarkdown.outsideChanges.whenBothChanged` | `keepMine` | What to keep where you and another program both changed the same words: `keepMine` keeps your words and backs up the disk version; `keepTheirs` applies the disk words at the clash, backs up your text, and shows "Undo" in the tab-top strip. |
| `tandemMarkdown.outsideChanges.highlight` | `true` | Highlight each line another program changes, with an outline that stays until you have seen it. |
| `tandemMarkdown.outsideChanges.announce` | `true` | Tell your screen reader when another program changes a note you have open in the Rich editor or the Rich view. |
| `tandemMarkdown.conflictFiles` | `true` | Write what couldn't be settled in a conflict file beside the note, for your agent. Off, no conflict file is written; backups are kept either way. |

### VS Code's save question

VS Code normally refuses to save over a file that changed on disk, and asks you to compare or overwrite. Tandem Markdown has already merged the newer file into your note by then, so for markdown files it turns that question off, in Source too. To get the question back, add this to your user settings:

```json
"[markdown]": { "files.saveConflictResolution": "askUser" }
```

Uninstalling Tandem Markdown brings the question back automatically.

## Two warnings in the status bar

- **"No merge on save":** VS Code gives each extension's pre-save step a 1,500 ms limit and disables it for the rest of the session after repeated timeouts. If that happens, Tandem Markdown shows this status bar item and a pop-up with "Reload Window".
- **"Can't read Field notes.md":** a read of the file failed because another program holds an exclusive lock or the drive did not answer. Tandem Markdown retries automatically and clears the warning as soon as the file can be read again.

## Limits

- Changes from other programs are merged only into notes saved in UTF-8 or UTF-16. In any other encoding (such as Windows-1252), your own saves run quietly, while an external change to the file's bytes is backed up and handed off without attempting a merge.
- A file that isn't on disk, such as a git revision or a file in a virtual workspace, opens in the Rich view only, and outside changes aren't merged into it.
- With Tandem Markdown installed, outside changes to a file open in VS Code's own Markdown Editor or another extension's WYSIWYG editor are held while you type there and merged when you pause, switch tabs, or save. With auto-save on, VS Code itself reloads clean files, and that editor can drop a key pressed at the exact instant of reload.
- **"Save without Formatting"** skips VS Code's pre-save step (`onWillSaveTextDocument`), so an external change written just before the save and not yet read by Tandem Markdown can be overwritten without notice.

### A half-written file

When a disk read looks mid-write (empty non-empty file, cut mid-character, or missing the end of the file), Tandem Markdown waits once (750 ms outside a save, 100 ms inside a save) and re-reads. If the writer finishes in that window, the complete file merges normally. If the file remains unmistakably truncated after the retry:

- **With unsaved typing:** Tandem Markdown leaves your note untouched, backs up the cut file, shows a short warning, and writes a `.conflict` part for your agent.
- **With nothing unsaved:** Tandem Markdown follows the file on disk (keeping a quiet backup of the previous version), marks the cut end in the Problems list, and writes a `truncatedFollow` part in the `.conflict` file quoting both the previous version and the cut version.

### A save at the instant another program writes

Just before VS Code writes a save, Tandem Markdown reads the file in `onWillSaveTextDocument`, backs up any outside change it finds, and merges it before VS Code writes. Between the end of that pre-save read and VS Code's own disk write (a few milliseconds on a local drive), another program can write to the file and be overwritten by VS Code's write. No extension can prevent that write gap because VS Code owns the final disk write.
