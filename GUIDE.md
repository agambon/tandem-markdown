# Using Tandem Markdown

What happens when an agent or another program changes a note you have open is in [When an agent or another program changes your note](WORKING_WITH_AGENTS.md), and each piece of markdown Tandem Markdown supports, with an example, is in the [syntax reference](SYNTAX.md).

## The three views

Here your note is the text you work on in VS Code, with any typing you haven't saved, and the file is what is saved on disk. Your note opens in a tab, in one of three views, and all three show the same text:

| View | What it is |
|---|---|
| **Source** | VS Code's own text editor, untouched. Everything else you use on markdown keeps working there. |
| **Rich editor** | The note shown as a finished page, editable, with a toolbar and the usual keys. Markdown's marks, such as `**` or `#`, show only around the text your cursor is in. |
| **Rich view** | The same page, read-only, except that checkboxes can be checked. |

Together, the Rich editor and the Rich view are the rich views.

`Alt+M` (`Ctrl+Cmd+M` on a Mac) switches views: from Source to the Rich editor, then to the Rich view, then back to Source. When `tandemMarkdown.defaultRichMode` is `view`, the Rich view comes before the Rich editor. The buttons at the top right of a markdown tab go straight to the other two views, and the right side of the toolbar has a back-to-code pill (`← </>`) to return to Source alongside an eye/pencil toggle for Rich view and Rich editor. Switching keeps your cursor and your scroll position, never asks you to save, and undo works across views.

To open a view beside the one you are in, hold Alt (Option on a Mac) as you click the Show Source, Show Rich View or Show Rich Editor button at the top right of a tab. The view opens at your place in the note, in the next editor group (VS Code's name for each side-by-side part of the editor area), and the focus stays where it was. "Tandem Markdown: Open Rich View to the Side" and "Open Rich Editor to the Side" do the same from any markdown tab, and "Open Source to the Side" from a tab in the Rich editor or the Rich view. If the group beside already shows the note in that view, you go to that tab.

In the Explorer:

- right-click a markdown file for "Open in Rich Editor" or "Open in Rich View";
- a plain click opens the file in your default editor, which is Source unless you change it.

If the note is already open in a tab, a click goes to that tab when it shows your default editor: a tab in the Rich editor or the Rich view, with Tandem Markdown as the default, or a Source tab, with Source as the default. Otherwise the click opens the note again. A note open only in another group opens again in the one you are in, as VS Code does for every kind of file unless `workbench.editor.revealIfOpen` is on.

### Tandem Markdown as your default editor

To open markdown files in the Rich editor every time, run "Tandem Markdown: Use Tandem Markdown by Default". It asks:

> Open markdown files in Tandem Markdown's Rich editor by default?

Below the question it says what will change: search results and links to a line will open a note where you were last in it, not at the line, and it says where comparisons, such as git's, will open. Press "Use Rich editor" to make the change, or "Don't change". When `tandemMarkdown.defaultRichMode` is `view`, the question and its button name the Rich view instead.

The command changes the markdown entries of two of your user settings: `workbench.editorAssociations`, which says what opens a file, and `workbench.diffEditorAssociations`, which says what opens a comparison. Every other entry stays as it is. Comparisons never open in the rich views: they keep opening in VS Code's own comparison view, or in a comparison editor you chose, which stays.

The command leaves alone two kinds of setting that can still decide where markdown files open:

- the workspace's own settings, which the message's "Open workspace settings" button opens;
- a more specific pattern in your user settings, such as `**/*.md`, which VS Code uses before `*.md`.

Where one of them does, the command says so, in its question and again in the message after it.

"Tandem Markdown: Use Source by Default" changes it back: markdown files open in Source again, and your settings for comparisons stay as they are. Uninstalling Tandem Markdown leaves the settings these commands wrote, so run "Use Source by Default" first.

### Text files, untitled files and a tab VS Code stops answering

A `.txt` file opens in the rich views through "Reopen Editor With..." or "Open With...", and an untitled markdown or plain-text file through "Tandem Markdown: Show Rich Editor" or Switch View. Neither ever opens there by default.

If VS Code stops responding to a tab for 10 seconds, the tab says so, with a "Show Source" button: "This tab can't take typing right now, because VS Code isn't responding to it. Wait, or switch to Source." The warning goes as soon as VS Code answers.

## How a note looks

The rich views lay a note out the way GitHub shows markdown, in the colors of your VS Code theme. A quote's `>` is hidden, with a bar at its left and its text faded. In the Rich view, a blank line between paragraphs shows only as the space between them; in the Rich editor it stays a short empty line you can type on. In both, you can scroll past the end of the note, so its last line doesn't have to sit at the bottom of the window.

- Front matter at the top of a note shows as a table of names and values. In the Rich editor, its pencil, or moving the cursor into it with the arrow keys, shows its text to edit. `tandemMarkdown.frontmatter.display` shows it as text instead, or hides it.
- A math block, a Mermaid diagram or a block of HTML shows rendered. In the Rich editor:
    - its pencil, or moving the cursor into it with the arrow keys, opens its markdown to edit, with the rendered block kept below it;
    - Escape, a click on the rendered block, or the pencil again (a check mark while the markdown is open) closes it, and puts the cursor just after it;
    - a click on the block while its markdown is closed leaves the cursor where it was, so you can select and copy its text.
- Code blocks have colors for their language, a language label and a Copy button.
- Links open with a click in the Rich view, with Ctrl+click (Cmd+click on a Mac) in the Rich editor, and with `Alt+Enter` (`Ctrl+Cmd+Enter` on a Mac) at the cursor. Pictures show in place, and one that can't be shown says why.
- HTML comments are hidden in the Rich view and faded in the Rich editor.

## Writing

### The toolbar and keys

The Rich editor's toolbar has bold, italic, strikethrough, inline code, link, a heading menu, bullet, numbered and task lists, quote, code block, table, image, rule and Insert, with the back-to-code pill, eye/pencil mode toggle, and Find pinned at the top right (even when formatting buttons wrap on narrow panes). Every key below is a VS Code keybinding, so you can change any of them in Keyboard Shortcuts; "Tandem Markdown: Show Keyboard Shortcuts" opens the list.

| Windows and Linux | Mac | Does |
|---|---|---|
| `Ctrl+B`, `Ctrl+I` | `Cmd+B`, `Cmd+I` | Bold, Italic |
| `Alt+S` | `Ctrl+Cmd+S` | Strikethrough |
| `Alt+K` | `Ctrl+Cmd+K` | Link |
| `Alt+C` | `Ctrl+Cmd+C` | Check or uncheck a task |
| `Ctrl+Shift+]`, `Ctrl+Shift+[` | `Ctrl+Shift+]`, `Ctrl+Shift+[` | Add or remove a heading level |
| `Ctrl+K Ctrl+L` | `Cmd+K Cmd+L` | Fold or unfold the current heading section |
| `Ctrl+K Ctrl+0`, `Ctrl+K Ctrl+J` | `Cmd+K Cmd+0`, `Cmd+K Cmd+J` | Fold all or unfold all heading sections |
| `Alt+Enter` | `Ctrl+Cmd+Enter` | Open the link at the cursor |
| `Ctrl+F`, `Ctrl+H` | `Cmd+F`, `Option+Cmd+F` | Find, Replace |
| `Ctrl+Shift+V` | `Cmd+Shift+V` | Paste as plain text |
| `F2` | `F2` | Rename the heading, link or reference at the cursor |
| `Ctrl+.` | `Cmd+.` | Quick fixes for the problem at the cursor |
| `Alt+M` | `Ctrl+Cmd+M` | Switch view |
| `Ctrl+M` | `Ctrl+Shift+M` | Tab Moves Focus on or off |

On a Mac, Option with a letter types a character, so the keys that use Alt on Windows and Linux use Ctrl+Cmd there. Tooltips and labels name the keys of the system you are on. Highlight has no key or button of its own: it is in the insert menu, and in the Command Palette as "Tandem Markdown: Highlight".

### The insert menu

In the Rich editor, type `/` at the start of a line or after a space, and a menu lists everything the editor can insert: headings, lists, a quote, callouts, a code block, a Mermaid diagram, math, a table, a picture, a link, a footnote, a rule, a contents list of the note's headings, a definition list, front matter, and bold, italic, strikethrough, inline code and highlight. The toolbar's Insert button opens the same menu with nothing typed.

- Typing after the `/` narrows the list. Enter or a click inserts the entry in place of the `/` and what you typed; Escape closes the menu and leaves them. When nothing matches, the menu closes and your typing stays, so a path such as `/usr/bin` types as normal.
- A heading, list, task or quote entry turns the line you are on into one: `Intro /h2` becomes `## Intro`. Any other block goes on a new line below, and an entry inside a line, such as Link or Bold, goes where the `/` was.
- An entry for syntax you have switched off isn't offered, and Front matter is offered only while the note has none. No entry writes HTML.
- The menu doesn't open in code, in a table cell, in front matter, or in the Rich view.

### Lists

Enter continues a list, a task list or a quote, and Enter on an empty item ends it. Tab and Shift+Tab indent and outdent an item.

Because Tab indents in the Rich editor, the keyboard alone can't leave it. `Ctrl+M` (`Ctrl+Shift+M` on a Mac), or "Tandem Markdown: Toggle Tab Moves Focus", makes Tab and Shift+Tab move the focus instead, in every tab of the window that shows the Rich editor or the Rich view, until you turn it off. "Tab Moves Focus" shows in the status bar while it is on, and a click on it turns it off.

### Tables

Click a cell to edit it, and the cursor goes where you clicked. Tab and Enter move between cells and add a row at the end. Editing a cell changes only that cell in the file, unless you turn on `tandemMarkdown.table.alignOnEdit`, which pads every row after each edit so the columns line up, and so rewrites the whole table. The bar above a table adds, deletes and moves rows and columns, sets alignment, and lines the columns up when you ask. A link or a tag in a cell opens as one in a line does, and in the Rich view Tab reaches a cell's links.

### Links, wikilinks and pictures

- Typing `[[` offers your notes. A wikilink finds its note in any folder: `[[Note]]` links to a note named `Note.md` wherever it is, and `[[Folder/Note]]` to the one whose path ends `Folder/Note.md`. `[[Note|Shown text]]` shows other words for the link, and `[[Note#Heading]]` links to a heading. A wikilink with no note behind it is dashed.
- Point at a wikilink, or a link to a markdown file, and a preview shows the note's title, the start of its text, its path and an Open button.
- Typing a link's or a picture's address offers the files and headings VS Code's markdown support knows, as in Source, and a folder lists what is in it.
- The Image button picks a file. A picture you paste, or drop onto the page, is saved beside the note, or where `markdown.copyFiles.destination` says, and linked.
- Pictures load from the workspace and the note's own folder, and from https addresses while `tandemMarkdown.images.allowRemote` is on.

### Copy and paste

- A web address pasted over selected text makes a link.
- Cells copied from a spreadsheet become a table.
- Text copied from a web page or a document becomes markdown.
- `Ctrl+Shift+V` (`Cmd+Shift+V` on a Mac) pastes as plain text.
- A pasted emoji stays the character you pasted. An emoji code such as `:smile:` shows as the emoji, with its code when you point at it, so you can tell the two apart.
- Text you copy from the rich views goes to the clipboard as markdown and as formatted text, so it pastes as markdown into a text editor, and with its formatting into an email or a document.

### Find, replace and rename

`Ctrl+F` finds in both rich views, and `Ctrl+H` replaces in the Rich editor (`Cmd+F` and `Option+Cmd+F` on a Mac). `F2` renames the heading, link or reference at the cursor: a heading and every link to it, or a link's file and every link to that file, in every file it touches, through VS Code's markdown support.

## Diagrams and git's conflict markers

### A diagram opened large

Once a Mermaid diagram has appeared, a button at its top right, "Open the diagram large", opens it over the editor at the size of the tab. Zoom with its buttons, "Zoom in (+)", "Zoom out (-)" and "Show the whole diagram (0)", or with Ctrl and the scroll wheel, or a pinch on a trackpad. Move around by dragging, with the arrow keys, or with the scroll wheel. Escape, or "Close (Escape)", puts it away.

### Git's conflict markers

When a git merge leaves conflict markers in a note, the block from `<<<<<<<` to `>>>>>>>` shows as one "Merge conflict". Its sides are labeled in VS Code's words, with the names git wrote in parentheses, such as "Current change (HEAD)" and, for a branch named `north-wall`, "Incoming change (north-wall)", and "Base, before either change" when git writes that part too.

- In the Rich editor, "Accept Current Change", "Accept Incoming Change" and "Accept Both Changes" rewrite the block as VS Code's own buttons do in Source. Undo puts it back.
- "Resolve in Merge Editor" opens VS Code's merge editor for the note, when git lists the note as in conflict. Otherwise the link reads "Resolve in Source", and switches the tab to Source at the conflict, where VS Code's own buttons sit above it.
- The pencil opens the marker lines as text, to settle the conflict by hand.
- `tandemMarkdown.syntax.conflictMarkers` turns this off, and the lines are read as any other markdown.

These markers are git's own, inside the note. A file ending in `.conflict` beside a note is something else: Tandem Markdown writes it for your agent, as [the conflict file](WORKING_WITH_AGENTS.md#the-conflict-file) explains.

## VS Code's own tools in the Rich editor and the Rich view

- Problems that other extensions report, such as a spell checker's or a linter's, are underlined in both rich views, in VS Code's colors. Pointing at one shows its message and its quick fixes, and `Ctrl+.` (`Cmd+.` on a Mac) opens them from the keyboard. VS Code applies the fix, as it does in Source. Whether an extension reports on a note shown only in the rich views is up to that extension; Code Spell Checker does.
- Broken links are underlined too when VS Code's own link check is on (`"markdown.validate.enabled": true`), on VS Code 1.146 or later. On earlier versions VS Code checks only files open in its text editor, so the warnings show when the note is also open in Source.
- In the Rich editor's margin, a bar marks the lines added or changed since the file's last commit, and a mark shows where lines were removed. Click a mark to peek the committed lines or revert that hunk. They compare with the last commit, not with what is staged. `tandemMarkdown.changeMarks` turns them off.

Two of VS Code's tools stay in its own editors. Comparisons, such as git's, open in VS Code's own comparison view, or in the one you chose, also when Tandem Markdown is your default editor. And Copilot's review of its edits shows only in Source; [the agents guide](WORKING_WITH_AGENTS.md#copilots-review-and-copy-relative-path-with-line-numbers) says how the "Review in Source" button takes you there.

## Scroll sync, the outline and the word count

With a note open in two or more tabs side by side, the tab you scroll leads, and the others follow to the same place in the text. Each of those tabs has a button of its own at the top right for this: two arrows while the note's tabs are linked, and the arrows struck through while they aren't. A click on it links or unlinks all of the note's tabs at once, for that note only, until the window closes. "Tandem Markdown: Toggle Scroll Sync" does the same. A note starts linked once one of its visible tabs shows the Rich editor or the Rich view; open only in Source tabs, it starts unlinked. `tandemMarkdown.scrollSync` can change where it starts.

- "Tandem Markdown Outline" in the Explorer lists the headings of the note in the active tab, when that tab shows the Rich editor or the Rich view. Click a heading to jump to it, or drag a heading to reorder its section (including nested subheadings).
- Hover any heading in the Rich editor or Rich view to click its margin arrow and fold or unfold that section, or use "Toggle Section Fold" (`Ctrl+K Ctrl+L`, `Cmd+K Cmd+L` on Mac), "Fold All Sections" (`Ctrl+K Ctrl+0`), and "Unfold All Sections" (`Ctrl+K Ctrl+J`). Jumping into a folded section automatically unfolds it.
- The status bar shows which view you are in, and a word count ("1,204 words", or "37 of 1,204 words" with a selection), with the characters in its tooltip. Front matter isn't counted.

## Your place in each note

A note opens in the Rich editor or the Rich view where you left it: after a reload or a restart of VS Code, and when you close its tab and open the note again. It comes back in the same view, with the same cursor and scroll position.

- If the note has changed since, the line that was at the top of the tab goes back to the top, as long as that line's text is still in the note. Otherwise the note opens at its top, and so does a note you have never opened in the rich views.
- Your place is kept for the last 200 notes in each workspace. Tandem Markdown recognizes the note by a hash, a short code worked out from its text, and never keeps the text itself.
- A note renamed in VS Code keeps its place; a note moved by another program (such as `git mv`) keeps its place too when its text has not changed and the old path is gone.
- A search result, a link to a line from outside the rich views, or Quick Open's `file.md:12` opens the note at your place, not at that line, because VS Code doesn't tell an extension's editor which line was asked for (Microsoft's open issue 289785). Go to Line works in Source only. A link to a line inside the rich views does go to the line.

## Verify File and line endings

A tab in the Rich editor or the Rich view holds its own copy of your note, and keeps it in step with the note VS Code holds. "Tandem Markdown: Verify File" checks them: it compares what the tab shows with your note, and your note with the file on disk. When all three agree it says: "This tab shows your text exactly, and the file on disk matches it." When they don't, "Compare versions" opens what differs beside your note, and where the tab is what differs, "Reload tab" loads your note into it again. With unsaved changes, the file on disk isn't compared, and the message says so. A tab that differs from your note means a fault in Tandem Markdown: [Contributing](CONTRIBUTING.md#reporting-a-bug) says what a report of one needs.

Line endings are left as they are. Tandem Markdown never converts them, and a change that only flips them counts as no change. A file with a mix of Windows and Unix line endings is given one kind by VS Code when it saves, in any editor.

## Settings

Most of these can be set differently for each workspace folder (window-wide settings are noted below). Set them in VS Code's Settings, or in `settings.json`, for example `"tandemMarkdown.fontSize": 18`. The settings that switch the additions to markdown on or off are in the [syntax reference](SYNTAX.md#settings).

| Setting | Default | What it does |
|---|---|---|
| `tandemMarkdown.defaultRichMode` | `edit` | Which of the two rich views Switch View and "Reopen Editor With..." open first: `edit` for the Rich editor, `view` for the Rich view |
| `tandemMarkdown.contentWidth` | `860` | Width of the text column in pixels; `0` for the full width of the tab |
| `tandemMarkdown.fontSize` | `16` | Size of the text in pixels |
| `tandemMarkdown.fontFamily` | empty | The name of the font for the text; empty uses the system font |
| `tandemMarkdown.lineHeight` | `1.6` | Line height for the text, as a multiple of the font size |
| `tandemMarkdown.table.alignOnEdit` | `false` | Pad every row of a table so its columns line up after a cell is edited. This rewrites the whole table in the file. |
| `tandemMarkdown.frontmatter.display` | `table` | `table`; `source`, the text as it is in the file; or `hidden`, hidden in the Rich view, and in the Rich editor one line reading "Front matter" that opens the text when clicked |
| `tandemMarkdown.images.allowRemote` | `true` | Show pictures from https addresses, in markdown and in HTML, and play video and sound from them while `tandemMarkdown.syntax.media` is on |
| `tandemMarkdown.maxRichFileSizeKb` | `2048` | Files larger than this many kilobytes open in the rich views as plain markdown |
| `tandemMarkdown.scrollSync` | `true` | Scroll a note's visible tabs together once one of them shows the Rich editor or the Rich view |
| `tandemMarkdown.changeMarks` | `true` | Mark the lines changed since the file's last commit in git, in the Rich editor's margin |
| `tandemMarkdown.hideBuiltInPreviewButtons` | `true` | Hide VS Code's built-in Markdown preview buttons in the editor title bar and Explorer menu so Tandem Markdown's view buttons replace them (window setting; built-in preview commands and shortcuts still work) |
| `tandemMarkdown.outsideChanges.whenBothChanged` | `keepMine` | What to keep where you and another program both changed the same words ([what each value does](WORKING_WITH_AGENTS.md#settings-for-other-writers)) |
| `tandemMarkdown.outsideChanges.highlight` | `true` | Highlight each line another program changes, with an outline that stays until you have seen it |
| `tandemMarkdown.outsideChanges.announce` | `true` | Tell your screen reader when another program changes a note you have open in the Rich editor or the Rich view |
| `tandemMarkdown.conflictFiles` | `true` | Write what couldn't be settled in a conflict file beside the note, for your agent; backups are kept either way |

## Limits

- A file that isn't on disk, such as a git revision or a file in a virtual workspace, opens in the Rich view only.
- An untitled file can be edited in the rich views, but until it is saved there are no change marks, Verify File has no file to compare, pictures and links with a path relative to the note aren't found, and a pasted picture isn't saved.
- What you type in the Rich editor reaches your note when each word ends, and at once when the pointer leaves the editor, the window loses focus, or you press a key with Ctrl or Cmd (Alt too, except on a Mac). A tab closed with none of these happening first, by another extension or by a tap on its close button on a touchscreen, can lose the word you typed in the half second before, when the note has nothing else unsaved. And when the note's last tab closes while VS Code is saving the note, taking in another program's change, running an undo or busy, what you typed last may never reach the note; a copy is kept, and a message can put it back ([When your last typing never reached the note](WORKING_WITH_AGENTS.md#when-your-last-typing-never-reached-the-note)). [Can you lose anything?](WORKING_WITH_AGENTS.md#can-you-lose-anything) lists these with every other case.
- Just after you open a text editor beside a tab in the Rich editor or the Rich view, VS Code sometimes takes the other tab's group for the one you are in, though your typing still goes into the text editor. A VS Code command that acts on the current tab, such as Close Editor, then acts on the other tab. Tandem Markdown's own commands aren't affected. A click in the text editor, or on any tab, puts it right. In testing, this happened about one time in three on VS Code 1.146, and rarely on 1.120.
- VS Code shows the Show Source, Show Rich View and Show Rich Editor buttons only on the group you are in, unless `workbench.editor.alwaysShowEditorActions` is on. With it on, every group shows them, but VS Code tells Tandem Markdown which note a pressed button belongs to, not which group. So when two groups show the same note, both in Source or both in the rich views, a press changes the group you are in, or the first of the two if you are in neither.
- After you rename a note in VS Code, its tab in the Rich editor or the Rich view comes back by being made active, so it comes to the front of its group and takes the focus.
- A note over the size limit, 2 MB unless you change it, opens as plain markdown and says so: "Field notes.md is over 2048 KB, so it is shown as plain markdown.", with a "Change limit" button. In a note near that size, a key pressed at the far end in the first seconds after you jump there waits until the note has been read that far: the first Enter at the end of a 2 MB note took about a second and a half, once, and under a tenth of a second after that. Until then, the toolbar's buttons don't show what the cursor is in.
- Each tab showing the Rich editor or the Rich view is a web page of its own, and takes about 20 MB for a note of 50 KB. VS Code doesn't hand all of that back when the tab closes: measured on VS Code 1.146 on Windows, about 5 MB for each closed tab stayed in use for as long as any such tab was open, and all of it came back within a minute of the last one closing.
- A Mermaid diagram can't show pictures from elsewhere, and its links do nothing, as on GitHub. A diagram that takes longer than 20 seconds to appear is replaced by a message, and the editor stays usable meanwhile.
- Some markdown is shown as it is in the file, and one piece can be shown wrongly: the syntax reference lists them under [Shown as typed](SYNTAX.md#shown-as-typed) and [Drawn wrongly](SYNTAX.md#drawn-wrongly). In a table cell, anything that is a block by nature, such as a contents list or a block id (`^id` at the end of a paragraph), is shown as it is in the file too.
- An embedded note (`![[Note]]`) in a table cell shows as a link to the note.
- The outline, a contents list, and a link's preview show math as its text.
- There is no export and no spell checker of its own.
