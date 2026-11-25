# Architecture

This document is for someone who is about to change Tandem Markdown's code. It covers how the extension is put together and why: the layers, the words the code uses, how each promise in the README is kept, then each part in turn. Paths are relative to the repository root, and names in backticks are identifiers you can search for. Source files point here by section name ("docs/ARCHITECTURE.md, "Outside changes""), so keep the headings stable.

## The three layers

```
 panel (webview, browser)                    host (extension host, Node)
   CodeMirror 6 view                           custom editor (CustomTextEditorProvider)
   drawing features, editing commands          the three ports, the panel registry
   PanelSync  <-------- messages -------->     one DocumentCoordinator per document
         \                                      /
          core (TypeScript only: no vscode, no DOM)
          the document core: session, gate, reconciler, coordinator
          eol, hash, diff, merge3, encoding, protocol,
          wikilink matching, outline, table model, word counts
```

| Folder | Holds | May import |
|---|---|---|
| `src/core` | Everything that decides what is written to a document, and the small modules the host and the panel share | only `src/core` |
| `src/host` | The code VS Code runs: joins the core to VS Code's documents, editors and commands | `src/core`, `vscode` |
| `src/host/model` | The host's modules that do not need VS Code, tested without it | `src/core` |
| `src/panel` | The page inside the editor tab: CodeMirror, drawing, editing | `src/core`, the browser |

Nothing in `src` imports from `test`, `itest` or `harness`. `eslint.config.mjs` enforces every row of the table with `no-restricted-imports`, so `npm run lint` fails on an import that crosses a layer.

Four rules make the promises hold by construction:

- **VS Code owns the document.** The extension registers a `CustomTextEditorProvider`, so saving, the unsaved dot, auto-save, restoring unsaved text after a restart, encodings and line endings stay VS Code's. The extension never writes the user's file. The only files it writes are backups of outside versions, the conflict file beside a note, pasted images, the record of a fault in its own log folder, and, when its own button is pressed, its instructions for agents in `AGENTS.md` and `.claude/rules/tandem-markdown.md`.
- **The panel holds the same text.** CodeMirror's document is the document's LF text. Everything rich is decoration over that text; nothing converts a tree back to markdown.
- **Every text change is an exact change set.** Panel to host: CodeMirror change sets. Host to document: one `WorkspaceEdit` built from the composed change set. Document to panels: change sets built from VS Code's change events. Nothing is located by searching, and nothing is written by serializing.
- **Positions cross the wire as LF offsets.** They become VS Code positions by line and character through CodeMirror's line table (`documentEditRanges`, `positionOf`), so a `\r` never enters the arithmetic.

## Glossary

- **Document**: VS Code's in-memory `TextDocument` for a file. The one authority for the text.
- **File**: the bytes on disk. The document and the file differ while there are unsaved changes, and for a moment after another program writes.
- **LF text**: a text with every `\r\n` and every lone `\r` written as `\n` (`toLf` in `src/core/eol.ts`). Every offset, hash, diff and merge in the core and the panel is over LF text. Nothing converts LF text back to CRLF: VS Code does that when it applies an edit to a CRLF document.
- **Host**: the extension's code in VS Code's extension host (`src/host`).
- **Panel**: one webview showing a document in Rich view or Rich editor (`src/panel`). A document can have several panels, in several editor groups.
- **Source**: VS Code's own text editor for the file, or any editor that is not ours. **Rich view**: the panel, read-only, every mark hidden. **Rich editor**: the panel, editable. The panel's **mode** is `view` or `edit`.
- **Update**: one set of text changes (a CodeMirror `ChangeSet` over LF text) with the id of the client that made it.
- **Session**: the host's record of one document: its LF text and the ordered **log** of updates that produced it. The **version** is the number of updates the log holds. It is not VS Code's `document.version`.
- **Client id**: the id under which a panel's updates are logged. Every `init` gives the panel a new one.
- **Push**: a panel sending its unconfirmed updates to the host. **Confirmed**: the panel has seen its own updates come back in the host's log.
- **Resync**: the host sends a panel the whole text again (an `init` with reason `resync`), with a new client id. The answer to a fault, never to an ordinary race.
- **Flush**: the host asks a panel to push everything unsent and say whether anything is still unconfirmed.
- **Stamp**: a text's length and hash (`src/core/hash.ts`). Two sides compare stamps instead of texts.
- **Gate**: the one lock on a document (`DocumentGate`). Anything that edits the document holds it.
- **Coordinator**: the `DocumentCoordinator` of one document. It owns the session, the gate and the reconciler.
- **Port**: one of the three interfaces the host implements for the core: the document, the disk, the interface.
- **Outside change**: a change to the file made by another program (git, a script, another editor, an AI tool). **Outside version**: the text of the file after one.
- **Base**: the LF text of a version of the file that is known to have been on disk and that the document already contains. The document is the base plus the user's unsaved edits.
- **Candidate**: a text the document held that VS Code may have read from the file or written to it. A disk read equal to a candidate makes it the base.
- **Remembered base**: the stamp of a document's base, kept in the workspace state while the document has unsaved edits, so a document restored after a restart, or renamed, can find its base again.
- **Merge**: a three-way merge of the base, the document (ours) and the outside version (theirs). A **conflict** is a stretch both sides changed differently: the preferred side's text is kept and the other is saved to a **backup**, with a notice. Different whole lines both add at one place are not one when the base is exact: both are kept (see "Merging").
- **Hold**: an outside change that is found but not yet merged, because the user may be typing in another extension's rich editor of the same document (see "Outside changes", "Beside another rich editor").
- **Safe handoff**: a fallback (`handoff` in `src/core/reconcile/decide.ts`) used when a merge cannot be trusted (no known base, persistently truncated disk file while dirty, uncertain origin across candidates, or a tripped exit guard): the user's note stays untouched, the disk version is backed up, and a notice plus conflict file are emitted.
- **Unsaved-typing exit guard**: `takesUnsaved` (`src/core/reconcile/decide.ts`), which checks every merged result against the document and hands off rather than deleting, replacing, or splitting any word the user typed beyond the base (outside allowed clash spans under `keepTheirs`).
- **Core notice**: one of the eight prose-free `CoreNotice` events (`src/core/reconcile/types.ts`) the core emits (`conflict`, `truncatedFollow`, `applied`, `actionRejected`, `closedWithPending`, `readStatus`, `saveCheckOff`, `typingAtClose`). All user-facing English prose lives on the host side (`src/host/model/messageForms.ts`, `src/host/model/conflictFile.ts`).
- **Notice actions**: `NoticeActions` (`src/core/reconcile/actions.ts`), which owns stateful `use`, `replace`, and `undo` choices and rejects stale actions once the document has moved on.
- **Jumps**: the counter (`jumps` in `Reconciler`) incremented on undos, redos, and clean reloads, after which `exactBase` is cleared until a fresh confirmed disk read re-establishes an exact base.
- **Feature**: one part of the panel, such as headings, tables, paste or the toolbar: a `Feature` listed in `src/panel/features.ts`, which adds a CodeMirror extension, panel commands, or both.
- **Reveal**: in Rich editor, showing the markdown marks of the node the selection touches. Everywhere else the marks are hidden.
- **Optional syntax**: what the panel reads beyond CommonMark and GFM (wikilinks, tags, math...). Each has a setting, `tandemMarkdown.syntax.<id>` (see "Optional syntax").
- **Inline drawing**: the decorations the inline features give some inline content that is shown outside the editor's lines, such as a table's cell, made into DOM as CodeMirror makes a line (see "Inline features").
- **Drawn block**: a block of the document shown as a drawing that looks nothing like its source, such as a math block. Its source opens in place, above the drawing (see "Drawn blocks").
- **The door**: `src/panel/html/door.ts`, the one way HTML from a file becomes nodes on the page (see "HTML through one door").
- **Wrapper**: an HTML element written as two tag lines with markdown between them (`<details>` ... `</details>`); its tag lines are hidden and the markdown is drawn as anywhere (see "HTML blocks").
- **Place**: where a tab of a document is scrolled to, as a zero-based line and the share of it above the tab's top, such as 41.25 (see "Scroll sync").
- **Linked**: a document whose visible tabs scroll together. The tab the user scrolls **leads**; the others **follow** it to its place (see "Scroll sync").
- **News**: what a screen reader has yet to be told of changes from outside (see "What a screen reader is told").

## The four promises

The README makes four promises. Each is kept by a mechanism, not by care.

**1. Nothing you didn't edit changes.** The panel edits the document's exact text, and drawing is decorations and widgets over it (see "Drawing"). A widget that changes text does it with one change set over the range it stands for: a checkbox replaces its `[ ]`, a table cell replaces its own span. Opening and closing a document sends nothing to it: the coordinator edits a document only for a push or a merge. Re-padding a table is opt-in (`tandemMarkdown.table.alignOnEdit`), so a cell edit is one cell's change in the file.

**2. Text never lands in the wrong place.** Every push names the version it was made on (`baseVersion`) and the stamp of the text the panel expects to result; `preparePush` refuses it as `stale`, `invalid` or `diverged` otherwise. Before any edit the gate checks that the session's text is the document's; if not, nothing is applied and every panel is resynced. The edit is sent to VS Code at once, with ranges computed from the text just checked, and VS Code refuses an edit when the document moved since. Every `init` brings a new client id, so a push from before a resync is answered `superseded` and dropped. After every quiet update a panel compares its stamp with the host's; a difference is a fault, both texts go to the log folder, and the panel reloads from the document. A panel also sends its own stamp to the host (`check`) once its text has been still for `CHECK_MS`, so a difference that no later update would show is found as well. Nothing is ever guessed.

**3. Edits from other programs merge in.** The reconciler reads the file whenever it may have changed, merges an outside version into the document against the base, and keeps one rule: a disk version that differs from the base is merged into the document or backed up before a save can overwrite it. See "Outside changes" and "Merging".

**4. Anything it does not understand shows as the plain markdown you typed.** What the parser does not read as a construct stays text. Every feature draws inside a fault guard: one that throws is turned off for that panel and its text shows plain. A widget that throws while drawing shows its source text. Over the size limit nothing is drawn. None of this touches the text.

One more promise follows from the first rule above: **one document, one undo history.** All three views show the same document. The panel has no history of its own; undo and redo in a panel run VS Code's undo and redo on the document (see "Sync between panel and host").

## The document core

Everything that decides what is written to a document lives in `src/core`, free of VS Code, so that every interleaving that could put text in the wrong place can be simulated (see "Testing"). The host supplies three ports, forwards VS Code's events, and decides nothing.

| File | Holds |
|---|---|
| `src/core/coordinator.ts` | `DocumentCoordinator`: one per open document. Owns the session, the gate, the reconciler and the list of panels; takes VS Code's events; acts only through the ports |
| `src/core/typingAtClose.ts` | `UnappliedPushes`, each panel's last push not yet in the document; `copyAtClose`, the note's last text with those pushes in it; `linesChanged`, how many lines they changed (see "Closing") |
| `src/core/session.ts` | `SyncSession`: the LF text and the update log, the authority of `@codemirror/collab` |
| `src/core/documentGate.ts` | `DocumentGate`: the one lock, and which change event is which |
| `src/core/reconcile/types.ts` | `DiskPort`, `ReconcilerDeps`, `BackupLabel`, `ClashPassage`, `SaveStepCount`, and the 8 structured `CoreNotice` variants (zero English prose) |
| `src/core/reconcile/disk.ts` | Settled disk reads (`readSettled`), single-retry truncation detection (`mayBeMidWrite`, `isTruncatedAfterRetry`), and encoding/byte helpers |
| `src/core/reconcile/conflictPlaces.ts` | Computes anchor lines and quoted passages for overlapping clash spans |
| `src/core/reconcile/decide.ts` | Pure `decideReconcile()` decision engine (follow, merge, conflictKeepOurs, conflictKeepTheirs, handoff), uncertain-origin check, and `takesUnsaved` exit guard |
| `src/core/reconcile/actions.ts` | `NoticeActions`: bounded store for backup I/O and open notice actions (`useFileVersion`, `replaceNote`, `undoUsed`), always recomputed under the gate |
| `src/core/reconcile/reconciler.ts` | `Reconciler`: single serialized lock and compact per-document state coordinating watcher, focus, clean changes, `willSave`, `didSave`, and pending retries |
| `src/core/merge3.ts` | The three-way merge |
| `src/core/safeMerge.ts` | The check that refuses a merge result that repeats text |
| `src/core/encoding.ts` | Decoding the bytes read from disk |
| `src/core/diff.ts` | `diffChanges` and `applyChanges`: the text diff |
| `src/core/sequenceDiff.ts` | The bounded sequence diff under `diffChanges`, which `merge3` and the change marks also use |
| `src/core/alignDiff.ts` | Placing a change at word boundaries |
| `src/core/wordChars.ts` | The characters words are made of, which the comparison, the merge, the judgment of saves and the word counts read words by |
| `src/core/listText.ts` | How a list of names is joined in a sentence ("A, B and C"): the one rule for a list in a message, a warning or a conflict file |
| `src/core/positions.ts` | LF offsets, line and character positions, change sets as sent on the wire |
| `src/core/textLines.ts` | Lines and offsets in LF text: where a line starts and ends, offsets carried through changes |
| `src/core/hash.ts` | Stamps |
| `src/core/protocol.ts`, `featureProtocol.ts` | Every message between a panel and the host |

The rest of `src/core` is shared by both sides and decides nothing about the document: `eol.ts`, `wikilinks.ts` (parsing and matching wikilinks), `outline.ts` (headings), `plainText.ts` (inline markdown read as plain text, for the outline, the contents list and a note's card, and `anchorText`, the reading a heading's id is made from), `emojiCodes.ts` (the shape of an emoji code, which the panel's parser and the plain reading both read codes by), `formulas.ts` (where a formula opens and ends, which the panel's math parsers and the plain reading both follow), `htmlElements.ts` (the names of HTML's elements), `tableModel.ts` (GFM tables), `words.ts` (word counts), `frontmatter.ts` (the one rule for what is front matter), `attributes.ts` (attributes in braces), `blockId.ts` (block ids), `fileKinds.ts` (which files are markdown, images, video and sound, by their extension), `fill.ts` (filling in the «name» marks of a words table's sentences, for the host's words and the panel's alike), `markdownText.ts`, `noticeText.ts` and `errors.ts`.

### The session

`SyncSession` holds the document's LF text as a CodeMirror `Text`, the log, and the version.

- `acceptForeign(text, changes, reason)` takes a change the document made without the gate's holder: VS Code's undo or redo, a reload, an edit by another extension. When the text equals the session's (a change of line endings only), nothing is logged. Otherwise each change of VS Code's event is refined with `diffChanges`, because VS Code reports a reload as one replacement from the first changed line to the last, and passing that on would move every panel's cursor to its end. The refined set is placed at word boundaries (`alignDiff.ts`), applied, and compared with the new text; on any difference the whole change is rebuilt from a diff of the two texts and the anomaly is logged. The session's text always ends equal to the document's.
- `preparePush(clientId, baseVersion, updates, expect)` is refused as `stale` unless `baseVersion` is the version, as `invalid` when a change set does not fit the text, and as `diverged` unless the composed text has the stamp `expect` (the panel's own text). It returns the composed changes, the text expected after them, and `noop` when they change nothing.
- `commitPush` logs one entry per client update, in order, under the client's id, once per accepted push.
- `updatesSince(version)` serves a panel that is behind. The log keeps the last `LOG_LIMIT` entries; a panel further behind is resynced.

### Where a change is placed

Every update the host sends is a change set, and collab maps each panel's unsent edits and its cursor through it. Many change sets produce the same text, and the mapping depends on which one is sent: a deletion a panel has not sent yet deletes whatever the change set says now stands where its text was.

`diffChanges` (`src/core/diff.ts`) matches whole lines first and refines each stretch of changed lines character by character. Lines are compared without their line break, so a last line that has none matches the same line followed by one in the other text; the empty line after a text's final line break matches only the other text's. Otherwise a last line with no line break could not be matched with the same line elsewhere in the other text, and the changes on both sides of it would be read as one change running through it. No change boundary falls between the two halves of a surrogate pair, in `diffChanges` or after `alignToWords`, even where the text holds an unpaired half. With `lines: true` (`refineLines`), the save judgment's comparison, a stretch of changed lines is compared lines first: a character comparison of several lines can match one line's characters with two lines of the other text ("notes" made "note" with a line ending "adds" put in below comes out as "\nwhat it add" put in before the "s"), so where it does, the lines are matched first, by their words (`lineGroups`: runs of letters and digits, and each other character but white space, in order, without the markup neighboring lines share whatever their words, `lineWords`: quote marks, a list item's or a task's marker and a heading's marks at the line's start, and emphasis marks): the pairs of lines that together share the most, each sharing at least one, then the lines beside a pair made mostly of the other side's words there (a line broken in two, or lines joined), but a line that starts a list item, a task or a heading of its own (`ITEM_START`) is no piece of another line: it joins only as the first piece of the line paired beside it, where it starts with that line's own marker (a list item broken in two keeps its marker on its first half, `savedListItemSplit.test.ts`), and two groups side by side that hold the same words between them are one.

Two tasks share "- [ ]" before any word, so a task a version put in beside one the user saved a word in is no part of it, and the word is not matched with the same word in the version's task (`savedWordTaskBeside.test.ts`). Where the character comparison keeps characters unchanged only within a group, it stands; otherwise the stretch is compared again, characters only within each group, and a line in no group is taken out or put in whole. A stretch that only breaks the same words into lines differently is left as compared. A line put in so never takes characters from a line beside it, even where the character comparison, folding, kept only the last letter of a line ("notes") and matched it with the end of a line the version put in. Past `LINE_PAIRS` pairs of lines the groups come from the character comparison itself: a line spread over several lines keeps the one sharing the most of it, and each other one that holds more of its characters than not.

The character diff picks one of the shortest edit scripts, and that one can start an insertion at the first offset the text allows, or line an old word up with pieces of a different new one. When another program inserts a line holding `[10]` after a line ending in `[1]`, the diff can report three insertions around pieces of the old `[1]`, so the old token is matched with the brackets and the `1` of the new `[10]`; a panel's unsent deletion of `[1]` then deletes those, damaging the line the other program wrote.

`alignToWords` (`src/core/alignDiff.ts`) rewrites a change set, never the text it produces, by two rules:

1. **Fewest changes.** A pure insertion or pure deletion that can slide through the unchanged text beside it until it touches its neighboring change becomes one change with it, and sliding carries on from the joined change, to a fixed point. Only then does each change that is left move to its best place within its reach: one that needs no widening to whole words if there is one, then the highest boundary score, then the rightmost. In the example, what is left is one insertion of the whole line, and the old `[1]` is matched with itself.
2. **Whole words.** No change starts or ends strictly inside a word of the old text, or just inside a bracket around one, and no insertion extends a word of the old text. Such a change becomes a replacement of the whole word and its bracket (the text is the same: what the wider range takes in is inserted again). Otherwise another program changing `cat` to `cats` is an insertion of `s`, and a panel's unsent deletion of `cat` leaves the `s` behind.

Two repairs keep the rules from undoing each other's work: a replacement whose inserted text holds the replaced text whole becomes the two insertions around it, and a replacement made by joining or widening is split and trimmed again the same way, so aligning a change set that is already aligned changes nothing. `edgeScore` ranks where a change may start or end: the ends of the text, then a line break, then punctuation before a space, a space, any punctuation, with one point more for an edge just outside a bracket. `alignedDiff(a, b)` is `diffChanges` followed by `alignToWords`. The session aligns VS Code's own change events the same way (they may be VS Code's own inferred diff of a reload), and a merge is applied as `alignedDiff(document, merged)`.

### The gate

`DocumentGate` is the one lock on a document. Pushes, merges, the save step, undo and redo all run under it, one holder at a time, first come first served. Nothing else edits the document. A holder keeps the gate until its work has settled and so has every edit it sent: the save step's limit can end the step while its merge edit is still on its way, and the next holder's edit must not start before that one has landed or been refused.

The gate also decides which change event is which. VS Code delivers the change event for an applied edit before `applyEdit` resolves, and refuses an edit if the document moved since the caller last saw it. So while a holder waits on `applyEdit`, change events are held. When it resolves:

- **true, with events**: nothing foreign can have come first, or VS Code would have refused the edit, so the first held event is the edit landing. The holder commits (a push is logged under its client; a merge is logged as a foreign update with reason `merge`). If the text after that event is not what the holder expected, because VS Code added a change of its own such as trimming whitespace, the difference is logged as a small foreign update. The other held events are then foreign, in order.
- **true, no event**: commit only if the document holds the expected text; otherwise the outcome is `failed`.
- **false**: every held event is foreign. The outcome is `stale` if there was one, else `failed`.

Outside `applyEdit`, every change event is foreign and is handed on at once. A push that composes to no change is committed without calling `applyEdit`.

### The coordinator

One `DocumentCoordinator` per open document. Its inputs are VS Code's events and the panels' messages; its outputs go only through the ports.

1. A push whose client id is not the panel's current one is answered `superseded` and ignored.
2. Otherwise it waits for the gate, then `preparePush`. A refusal is answered and nothing is applied.
3. An accepted push is applied through the gate. On `applied`, the new log entries go to every panel, and the panel that pushed reads its own as confirmation. On `stale` or `failed` the panel is told so.
4. A resync request also waits for the gate, so a resync never overtakes a push in flight. The answer is an `init` with a new client id.
5. Every foreign update is sent to every panel as it is logged. A panel receives updates only after its `init` has been posted. When a post to a panel fails, the panel gets nothing more until it is resynced: when it next reports in, or after `POST_RETRY_MS`, doubled for each further failure. A push of its that the core refuses after such a failure (it waited for the gate meanwhile) is not answered with the refusal, which would leave the panel waiting for updates it was never sent: the panel is resynced instead, as when it reports in.
6. A change event with no content changes is not logged (the reconciler still hears that the dirty flag may have changed).
7. Foreign updates carry a reason: `undo` and `redo` (from VS Code), `merge` (an outside version merged by the core), and `outside`, a hint from the host that no text editor of this document was active when the change came.

The host builds it with `CoordinatorOptions`: the three ports (`disk` is null for a document that is not a file, which then has no reconciler), the clock (`schedule`), the uri as `key` (what the base's stamp is remembered under) and the file's name for notices. Optional: `readOnly`, `whenBothChanged` (asked each time it is needed, so that a change of the setting holds at once), `newId` (a new id for each init and notice), `debug` (the reconciler's every decision; the host logs it at trace level), `holdOutside` (see "Beside another rich editor") and `saveSteps` (see "The save step"). `findUndoneSaves` is for tests: false turns off the rule at the exit's finding of saves a merge would undo, and its judgment of a version a clean note followed, leaving only the net under them. `noteRecord` is for the simulation: it keeps the note's record beside the reconciler (`noteRecord.ts`, above).

`inspect()` reports the coordinator's state for the log, for Verify File and for the in-VS-Code suite.

### The three ports

The host implements these in `src/host/documents.ts`; the simulation implements them with fakes.

**DocumentPort**, VS Code's `TextDocument`:
- `getText()`, `isDirty()`, and `encoding()` (VS Code's name for the document's encoding, `utf8` where VS Code gives none).
- `applyEdit(edit)`: when the document is closed, resolve `false` and send nothing. Otherwise build one `WorkspaceEdit` from `documentEditRanges(edit)` (each change a start and an end as line and character, its text with `\n` line breaks, which VS Code turns into the document's own; never positions counted in `getText()`, which may hold `\r\n`) and resolve with what `workspace.applyEdit` resolves. Call it synchronously, with nothing awaited in between: the ranges are computed from the text the gate just checked, and VS Code refuses the edit if the document moves before it arrives. That refusal keeps text out of the wrong place. Never reject: catch and resolve `false`.

**DiskPort**, the file through Node's file system (`model/fileReads.ts`: stats, and reads in a worker thread), and the backups through `workspace.fs`:
- `stat()`: `{ mtime, size }`, or `null` when there is no file. Never rejects.
- `read()`: the raw bytes, or a failure named `missing` (no such file), `busy` (locked, or no permission: `EBUSY`, `EPERM`, `EACCES`) or `failed`. Never rejects; the core decodes.
- `backup(bytes, label)`: writes a backup and returns its path. May reject (see "Outside changes").
- `deleteBackup(path)`: deletes a backup whose outside version has since been merged without a conflict.
- `readBackup(path)`: the bytes of a backup the core wrote, or null when it is gone or cannot be read; a choice on a conflict reads its version back from it. Never rejects.

**UiPort**, everything else:
- `postToPanel(panelId, message)`; when VS Code reports the post failed, the host calls `panelPostFailed(panelId)`.
- `initFields(panelId, reason)`: the parts of an `init` the host decides (mode, settings, view state, file information).
- `notify(notice)`: shows a conflict and the choice it offers; the user's saved words and another program's text standing at one place, with "Use its change"; a change used over the user's text (by the setting, a choice, or VS Code's reload) or applied to words the user saved, with Undo; a reply that a choice or an Undo changed nothing; an outside version kept (a caught change a close or Revert File threw away among them); a file that cannot be read, and that can again; a change written over at a save; the warning that the save step is not running; or typing a note never had when VS Code closed it, with "Put my typing back" (see "Closing").
- `log(level, message, detail?)`, `dumpFault(record)` (two texts written to the log folder), `reloadPanel(panelId)` (the panel speaks another protocol version), and `remember` and `recall` (the workspace state, which survives a restart; remembering `undefined` forgets).

### What the host does at each VS Code event

| VS Code event | Call |
|---|---|
| `onDidChangeTextDocument`, every one, also those with no content changes | `documentChanged({ text, changes, reason, dirty })`, reading `getText()` and `isDirty` synchronously inside the handler |
| `onDidCloseTextDocument` with `document.isClosed` | `documentClosed()`, at once, and drop the coordinator |
| a file watcher's create, change or delete for the file | `diskChanged()` (the core debounces) |
| `window.onDidChangeWindowState`, focused | `windowFocused()` on every open document's coordinator |
| `onWillSaveTextDocument` | `event.waitUntil(coordinator.willSave())`: it never rejects, resolves within `WILL_SAVE_LIMIT_MS`, and returns no text edits |
| `onDidSaveTextDocument` | `didSave()` |
| `resolveCustomTextEditor` | `panelAttached(panelId)`, then build the page. The coordinator posts `init` itself when the page sends `ready` |
| a message from a panel | `panelMessage(panelId, message)`; when it returns false, the host's own router handles the message |
| the panel is disposed, or its page reports `startFailed` | `panelDetached(panelId)`. A page that failed to start answers no flush, so nothing may wait on it; a reload of the page calls `panelAttached` again |

### Closing

VS Code applies an edit sent to a closed document's uri to a fresh copy of the file, loaded at that moment, with no version check. So the coordinator is told of the close at once, in the close handler itself, and from then on reads nothing, merges nothing, retries nothing, accepts no push and applies nothing. Outside versions it had not merged are announced, each with its backup, except those that need neither: one already in the note (VS Code reloaded it), the version the file still holds (closing with "Don't Save" leaves it there), and one another program replaced in the file with a newer version before any save of ours (see "The check"). A language change arrives as a close and then an open of the same document object, which is not closed (`document.isClosed` is false): that is not a close. A choice or an Undo pressed on a notice after the close changes nothing (the coordinator answers false), and the host says so.

After its last panel closes, a coordinator keeps hearing pushes for `CLOSE_LINGER_MS`, so a push already on its way is still applied while the document is open.

**Typing the note never had.** A push can reach the coordinator and not the document: it waits for the gate behind a save step, a merge, an undo or a redo; VS Code puts it on the fresh copy of the file (above) when the close comes first; or it is refused as `stale` and the close comes before the panel sends it again. When VS Code then closes the document with nothing unsaved, it asks nothing, and the typing would be lost with no word. So the coordinator keeps each panel's last push that has not gone into the document (`UnappliedPushes` in `src/core/typingAtClose.ts`): a push holds every update its panel has not had confirmed, so the panel's next push replaces it. A push leaves it when it is logged, or when it is refused in a way that drops the panel's unconfirmed typing (`invalid`, `diverged`, `superseded`, a mismatch), and every push of a panel leaves it when the panel is sent an `init`. A push refused as `stale` or `failed` stays, since its panel sends its typing again, or asks for a resync, only after an answer the close may not leave time for.

At the close, when the document is not dirty and has not been dirty since it last held its saved text (by a did-save, an undo or redo back to it, or a revert: `dirtySinceSave`), VS Code closed it without asking, and the coordinator rebuilds the note's last text with that typing in it (`copyAtClose`): VS Code's last text of the document with each push applied in the order they came, each moved first over the log's entries since the version it was made on, then over a change VS Code made that the gate still held, then over the pushes before it, with `rebaseUpdates` from `@codemirror/collab`, as the panel itself would have moved its updates. A push the log no longer reaches back to, one whose updates do not fit, and one made on the last version that does not give its panel's own text (its `expect` stamp) are left out. A revert is a change of the text that turns the document clean other than an undo or a redo (Revert File, or "Don't Save" as VS Code closes the note): the pushes then on their way stay, since their panels still show that typing and push it again, so a close VS Code makes without asking after a Revert File tells of typing that had not landed (`typingAtClose.test.ts`). After "Don't Save" a push is rarely still on its way, since VS Code's question takes the focus from the page and the push lands before the answer ("Pushing"); one that is is kept and told like any typing the note never had, never lost unsaid. When the rebuilt text differs from VS Code's last text, it goes to a backup of the user's text (`yours`, through the reconciler's `NoticeBook.backupBytes`, as every such copy does) and is told once, with the notice `typingAtClose`, which names the backup or, when none could be written, carries the copy for the host to open in a new unsaved tab, and gives how many lines the typing changed (`linesChanged`: in each run of changed lines, the larger side's count, as a comparison marks them). No part goes to the conflict file: the typing is the user's own.

"Put my typing back" on that message opens the note again in the Rich editor, then asks the new coordinator to put the copy in (`putBack`): under the gate, only while the document holds exactly its text at the close, with nothing unsaved, and done already when it holds the copy (VS Code's fresh copy of the file is opened again when the push landed there). The change is logged with no reason, so the panels take it as the user's own edit and do not mark it as another program's. The host reads the note before it opens a tab, so a note that has changed since opens none.

### Never outside the core

- Never call `workspace.applyEdit` on a coordinated document, or run a command that edits it, except through `DocumentPort.applyEdit` (which the core calls) or inside `runExclusive` or `undoRedo`. An edit the gate does not know about is caught before the next edit (nothing is applied and every panel reloads), but it must not happen.
- Never return text edits from `onWillSaveTextDocument`: VS Code applies those without a version check.
- Never compare the document with the file, or decide anything about outside changes, in host code.

## Sync between panel and host

The model is CodeMirror's own collaborative editing module, `@codemirror/collab`: one authority with an ordered log, and clients that hold unconfirmed changes and replay them over whatever arrives first. The coordinator's session is the authority; each panel's `PanelSync` (`src/panel/sync.ts`) is a client. `PanelSync` has no DOM in it and takes its clock as a parameter, so the simulation runs it against a bare `EditorState`.

### Messages

Panel to host (`src/core/protocol.ts`): `ready`; `push { clientId, baseVersion, updates, expect }`; `fault`; `resyncRequest`; `viewState { selection, topLine, topOffsetPx, mode }`; `focus { editor, field }`; `flushed { id, clean }`; `check { clientId, version, length, hash }`; and feature messages (`src/core/featureProtocol.ts`).

Host to panel: `init { protocol, clientId, text, version, length, hash, mode, readOnly, settings, viewState?, docInfo, reason }`; `updates { fromVersion, updates, version, length, hash }`; `pushRejected { reason, version, clientId }`; `flush { id }`; `setMode`; `tabShown { shown }`; `settings`; `command { id, args }`; `notice`; `reply`; and feature messages.

Inside VS Code the panel takes a message only from VS Code's host page, the page that holds the panel's frame (`vscodeBridge.ts`). That page loads the frame from its own origin and posts every message with that origin as the target, and the API it gives the frame sets `window.parent` to the frame itself, so the bridge knows the page by the origin: a message of the panel's own origin from a window other than the panel's. So a frame inside the panel (the diagram frame, whose origin is opaque) cannot pass for the host. The diagram frame in turn takes messages only from the panel, and the panel takes the frame's answers only from that frame (`render/diagramFrame.ts`, `render/frame/main.ts`).

A feature message that carries a `requestId` is answered with `{ type: 'reply', requestId, ok, result | error }`. Both message unions are closed: every message either side may send is declared in one of the two files, and the host checks every field of a message from a panel before it uses it. `PROTOCOL` names the version both sides speak; a panel whose bundle speaks another is reloaded.

### Pushing

Local transactions collect as unconfirmed updates. A push goes only once every push before it has been answered. A push is sent:

- at once after any change that is not plain typing: a paste, a cut, a drop, a command, a deletion of more than one character, a table cell's commit, a checkbox;
- at once when typed text ends a word (whitespace, or one of `.,;:!?)]}"`);
- after `IDLE_MS` without a keystroke, and when the oldest unsent change is `OLDEST_MS` old;
- at once whenever the user is about to act outside the page: the pointer leaves the panel, the page loses focus, is hidden or is unloaded, or a key is pressed with a command modifier (Ctrl or Cmd, or Alt off a Mac; `isCommandChord` in `ui/keys.ts`);
- on `flush`.

The pointer is there for the mouse: a tab's close button takes no focus from the page (VS Code stops the button's `mousedown`), and closing the tab removes the page and stops listening to it in one step, so a push posted while the page unloads never reaches the host. The pointer leaving the page on its way to the button is the last moment the page hears of it; the push then reaches the document within a few milliseconds, so VS Code finds it unsaved and asks before closing. Without it only a document with nothing else unsaved loses typing: for an unsaved one VS Code asks anyway, and its question takes focus from the page, whose push lands before the answer. The key listener sits in the capture phase on the window, ahead of VS Code's webview host page, which forwards keys to the workbench from the window's bubble phase: the push goes first on the same channel and reaches the host before the command the key runs. What is not covered: a tab closed with no input in the page at all, by another extension or a command run from outside the page, or by a touch on the close button while the mouse pointer rests in the page; and a click landing before the push has reached the document, a few milliseconds after the pointer leaves.

A pointer injected through the DevTools Protocol (Playwright's `page.mouse`) gives the page no leave event: Chromium hands such an event straight to the frame under the point, while a mouse's moves pass through the code that tells the frame the pointer left. Checking this inside VS Code needs the operating system's pointer, or mouse moves posted to the window as messages.

Each push becomes one undo step in VS Code, so undo removes a word or a phrase, not a letter. During IME composition pushes go on as at any other time, so what is composed so far reaches the document by the same rules, the pointer leaving the panel included. Of the host's messages, those that leave the panel's text as it is are taken as they come: the copies of its own updates that answer a push, a `flush`, and a push refused as `stale`. An update from anyone else, and whatever ends in a resync, waits with everything behind it until `compositionend`, since a change to the text under an input method can break its composition (and a watchdog, every `COMPOSITION_POLL_MS`, drains the queue if the view reports it is not composing and no `compositionend` came). While such an update waits, a push is made as the view will be once it has taken what waits, received into a copy of its state and never into the view (`ahead`): it names the host's version, so the host takes it, and what is composed meanwhile reaches the document by the same rules while the text under the composition stays as it is. The host's answers wait in the queue too, and a push counts as answered once its answer is there, so the next one does not wait for `compositionend`.

### Receiving, and when a push is refused

Host messages are processed strictly in order. On `updates`: from the panel's version, apply them; from a lower version, drop the part already seen; from a higher one, a message was missed, so ask for a resync. A transaction that applies host updates carries the `receivedUpdates` annotation: each update with its reason and its change set (`src/panel/outsideChanges.ts` reads it, for the outline and for what a screen reader is told).

On `pushRejected`: `stale` means push again at once if anything is unconfirmed (the missed updates have been applied by then, since messages are processed in order); if the panel is still behind the rejection's version after `STALE_WAIT_MS`, it asks for a resync. `superseded` is ignored. Anything else asks for a resync. A push with no answer for `PUSH_ANSWER_MS` also asks for one.

### The stamp check

After applying `updates`, when the panel has nothing unconfirmed and its version is the message's, it compares its stamp with the message's. A mismatch is a `fault`: the host writes both texts to the log folder, the panel asks for a resync, and a notice says "The view was reloaded from the document. Nothing was written to the file." with "Open log".

That comparison needs an update to arrive. So the panel also sends the host its stamp at its synced version, in a `check` message, `CHECK_MS` after its text last changed (by the user or by an update), and when the view regains focus if its text changed since its last check; only with nothing on its way (nothing unconfirmed, no push awaiting its answer, no resync asked for), and during IME composition it looks again after `CHECK_MS`. The coordinator answers (`handleCheck`):

- A panel behind the log is sent the updates from its version again, in one `updates` message; it applies them, or passes over those it already holds when they were only crossing the check. When the log no longer reaches back that far, the panel is resynced. An update lost on its way is so made good.
- A panel at the log's version whose stamp differs from the document's is sent an `updates` message with no updates that carries the document's stamp. Its stamp check then reports the fault and asks for the resync, as above, so a panel's text that went wrong after its last update is found within `CHECK_MS`.
- A check with a matching stamp, from an earlier client id, or from a panel that is closing or that a post failed to reach (it is resynced anyway), is ignored.

A stamp is the text's length and a hash that composes under concatenation: a polynomial hash over the text's UTF-16 code units, modulo two primes, so the hash of two texts joined follows from the hashes of the two. It is therefore cached per node of CodeMirror's `Text` tree: an edit rehashes one leaf and the path to the root, not the whole text, so a stamp costs next to nothing per keystroke even in a large document. The host's tree and a panel's tree for the same text have different shapes, and the hash gives the same value for both, and for the same text as a string. One function, `stampOf` in `src/core/hash.ts`, serves both sides.

### Resync

The host sends `init` with reason `resync`, the whole text and a new client id. The panel builds a fresh editor state at that version, carries the selection across with `diffChanges(oldText, newText)`, and keeps the scroll position. Unconfirmed changes are dropped, and the notice says so when there were any. When the `init` brings exactly the text the panel already held, no notice is shown.

From the moment the panel asks for a resync until the `init` arrives, the view takes no edits: the state is read-only (`resyncPending(state)` tells code that changes the document without looking at `state.readOnly`, such as a checkbox or a table cell, to do nothing). A request with no answer is sent again after `RESYNC_RETRY_MS`. If nothing at all answers for `LOST_CONTACT_MS`, a standing notice says the view is not connected to VS Code and has stopped taking edits, with "Show Source"; only an answer clears it.

### Undo, redo, save and close

VS Code owns the history. While a panel has focus, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z run `tandemMarkdown.undo` and `tandemMarkdown.redo`. The coordinator's `undoRedo` runs them one at a time per document: it flushes every panel; if one is not clean, it does nothing and the host says so ("Undo didn't run. Try again in a moment.", or the same for Redo); otherwise it runs VS Code's `undo` or `redo` with the gate held. For an active custom text editor VS Code's undo acts on the document. CodeMirror's history extension is not installed and the panel binds no undo keys. While a text field inside the panel has focus (a table cell, the find box), the same keys run the browser's own undo in that field instead.

Save from a panel flushes the panel, then saves. Close (Ctrl+W, and Ctrl+F4 on Windows and Linux) flushes the panel and closes its tab only if the flush is clean. Updates with reason `undo` or `redo` move the cursor to the end of the last changed stretch, in the focused panel only.

### Timing

| Constant | Where | What it waits for |
|---|---|---|
| `IDLE_MS` | `src/panel/sync.ts` | A pause in typing before a push |
| `OLDEST_MS` | `src/panel/sync.ts` | The oldest unsent change before a push while typing goes on |
| `FLUSH_MS` | `src/core/protocol.ts` | How long a panel takes at most to answer `flush` (it answers `clean: false` then) |
| `FLUSH_WAIT_MS` | `src/core/protocol.ts` | How long the host waits for that answer. Must exceed `FLUSH_MS`, and a test says so |
| `STALE_WAIT_MS` | `src/panel/sync.ts` | Missed updates after a `stale` answer, before asking for a resync |
| `PUSH_ANSWER_MS` | `src/panel/sync.ts` | An answer to a push, before taking it as lost |
| `RESYNC_RETRY_MS` | `src/panel/sync.ts` | An `init` after a resync request, before asking again |
| `LOST_CONTACT_MS` | `src/panel/contact.ts` | Any answer, before the lost-contact notice. Longer than `PUSH_ANSWER_MS` plus `RESYNC_RETRY_MS`, so a resync has been asked for by then |
| `CLOSE_LINGER_MS` | `src/core/coordinator.ts` | Pushes from a panel that has closed |
| `POST_RETRY_MS` | `src/core/coordinator.ts` | A resync of a panel a post to which failed, doubled for each further failure |
| `COMPOSITION_POLL_MS` | `src/panel/sync.ts` | How often a stalled composition is looked at |
| `CHECK_MS` | `src/panel/sync.ts` | A panel's text to be still, before its stamp goes to the host in a `check` |

## Outside changes

The reconciler (`src/core/reconcile/`) runs for every open markdown document backed by a file, whichever view shows it, Source included. It is split into six focused modules with no user-facing prose:

- `types.ts`: ports (`DiskPort`, `ReconcilerDeps`), `BackupLabel`, and the eight structured `CoreNotice` events.
- `disk.ts`: stat-settled reads, encoding helpers, and single-retry truncation detection (`readSettled`, `isTruncatedAfterRetry`).
- `decide.ts`: pure decision engine (`decideReconcile`) and the unsaved-typing exit guard (`takesUnsaved`).
- `conflictPlaces.ts`: extracts conflicting stretches and nearest-line context (`clashPassages`).
- `actions.ts`: stateful user actions on notices (`use`, `replace`, `undo`) and action staleness checks (`NoticeActions`).
- `reconciler.ts`: serialized check loop, base and candidate tracking, save-step integration, and timers (`Reconciler`).

**Core invariant:** a settled outside disk version that differs from the base is always cleanly merged into the document, followed (when the note holds no unsaved edits), or safely handed off with a backup and notice before a save can overwrite it. Unsaved user typing is never silently dropped or split.

### The base and candidates

The base (`s.base`) is the LF text of the last version known to have been on disk that the document already contains. It moves only after a confirmed disk read (`readSettled`) when:

1. the disk text equals the document's text (as written in its encoding);
2. the disk text equals a candidate recorded for an in-flight save or an unconfirmed clean reload;
3. a follow or merge of that disk text into the document has been confirmed through the gate; or
4. a safe handoff (no base, truncated disk file, uncertain origin, or guard trip) backs up the disk version and announces it.

Because VS Code reports the first edit to a clean document with `isDirty = false` and sends a dirty-only event immediately after, a clean content change is never trusted as a reload on its own. It is recorded as `pendingCleanChange` and schedules a disk read; if another edit or dirty-only event supersedes it before the read settles, a changed clean state is retained in bounded `recentCleanCandidates` (`MAX_CLEAN_CANDIDATES = 4`) so the next read still knows every possible starting point. During a save, candidate texts the save may have written are tracked in `inFlightSave.candidates` (`MAX_SAVE_CANDIDATES = 8`).

Until the first read confirms the base on a freshly opened clean note, `openingText` stands in as the initial candidate base. Any undo, redo, or clean reload increments `jumps`, which clears `exactBase` (`jumps === baseJumps`, no in-flight save, and no unconfirmed clean candidates) until a fresh read confirms the base again.

### Reading the disk

`readSettled` (`src/core/reconcile/disk.ts`) reads the file until before/after stats agree (`sameStat`), and outside a save step waits `SETTLE_MS` (200 ms) for an unknown text to stop changing before treating it as settled. Known synced texts skip the settle pause so reloads confirm immediately.

- **Mid-write retry:** if a read is empty while `base` is non-empty, cut mid-character (`cutInsideCharacter`), or missing the base's last 40 characters (`mayBeMidWrite`), `readSettled` waits once (`TRUNCATED_RETRY_MS = 750 ms` normally, `SAVE_TRUNCATED_RETRY_MS = 100 ms` inside a save step) and re-reads. After that retry, `isTruncatedAfterRetry` flags the read as `truncated` only when a non-empty file is emptied or strictly prefixed mid-line (not ending cleanly on a line break).
- **Missing or unreadable files:** a missing file retries once after a short pause; if still missing, the reconciler does nothing. Busy or failing reads retry once, then emit `readStatus` (`ok: false`) until a subsequent read succeeds (`ok: true`).
- **Decoding:** `src/core/encoding.ts` checks BOMs first, then the document's encoding (UTF-8, UTF-8 with BOM, UTF-16 LE, UTF-16 BE). UTF-8 is decoded strictly; UTF-16 decodes code unit by code unit. For UTF-8 documents, comparisons normalize unpaired surrogates to U+FFFD (`asWritten`) to match what VS Code writes. Any other encoding returns `{ kind: 'bytesOnly' }` (see "Encodings").

### Pure decision and invariants

`decideReconcile` (`src/core/reconcile/decide.ts`) is pure and performs no I/O. Given `{ doc, encoding, base, possibleBases, disk, truncated, prefer, exactBase, afterSave }`, it returns one of seven typed decisions:

1. **Already in sync (`noop` / `advanceBase`):** `disk` matches `docWritten`, a non-base candidate, or (outside post-save revert detection) `base`.
2. **Clean note (`follow`):** judged strictly by content against the sole effective starting base (`effectiveCandidates.length === 1 && effectiveCandidates[0] === docWritten`), never by VS Code's `isDirty` flag. Outside a save step, a clean note waits `CLEAN_RELOAD_GRACE_MS` (350 ms) once to let VS Code's own reload run first, then takes the disk text directly while keeping a quiet backup (`beforeRemoval`) of the prior text (and emitting `truncatedFollow` if `truncated` was true).
3. **No base or truncated disk file on a dirty note (`handoff`):** keeps the user's note untouched, backs up the disk version, advances the base, and emits a `conflict` notice (`reason: 'noBase'` with `choice: 'replace'`, or `reason: 'truncated'` with `choice: 'none'`).
4. **Uncertain-origin rule:** merges `doc` and `disk` against every candidate in `effectiveCandidates` (`checkedMerge`, combining `merge3Detailed` and `repeatsText`). If any candidate refuses or produces a different merged text (or conflicts where the primary did not), returns `handoff` (`reason: 'handoff'`, `choice: 'replace'`) instead of guessing.
5. **Unsaved-typing exit guard (`takesUnsaved`):** computes edits against `doc` and rejects any change that deletes, replaces, or inserts inside a word of any stretch `doc` added beyond `primaryBase` outside allowed clash spans (under `keepTheirs`). If triggered, returns `handoff` (`reason: 'handoff'`, `choice: 'replace'`).
6. **Clean merge (`merge`):** no conflicts; applies `alignedDiff(doc, nextText)` through the gate and saves a quiet backup (`beforeRemoval`) if any characters in `doc` were replaced or deleted.
7. **Overlapping clash (`conflictKeepOurs` / `conflictKeepTheirs`):**
   - Under `keepMine` (`prefer: 'ours'`), keeps the user's words in conflicting spans, merges disjoint edits, backs up the disk version, and emits `conflict` (`reason: 'clash'`, `choice: 'use'`, plus `passages` from `clashPassages`).
   - Under `keepTheirs` (`prefer: 'theirs'`), takes the disk text at conflicting spans, backs up both the user's prior text and the disk version, computes `undoTarget` (the `prefer: 'ours'` merge result so Undo restores only the user's words while keeping non-conflicting disk changes), and emits `applied` (`how: 'setting'`, `canUndo: true`).

### User actions and notice staleness

`NoticeActions` (`src/core/reconcile/actions.ts`) handles `use` ("Use Change from Disk"), `replace` ("Replace My View"), and `undo` ("Undo").

- Every choice stores the snapshot or backup reference it needs (bounded to recent notices) and checks freshness before editing: `use` and `replace` fail with `actionRejected` if the note closed, the backup is missing, VS Code refuses the edit after `MERGE_TRIES`, or another outside change landed since; `undo` works only while the document text still matches what the applied action left behind.
- Before applying `use`, `replace`, or `undo`, the current text being taken out is backed up so no version ever disappears without a copy.
- When the host renders a conflict notice, the notice stays in the tab-top strip (`src/host/messages.ts`) and in the diff title bar (`src/host/backupViews.ts`) only while `coordinator.offers(id)` remains true.

### The save step

`beforeSave` (`willSaveTextDocument`) runs a read and reconcile pass inside `WILL_SAVE_LIMIT_MS` (800 ms) while holding the document gate so panel pushes pause until the save check settles. Any merge is applied as a normal version-checked edit inside the step so VS Code saves the merged document. Once the step ends, the gate is released so typing is never blocked during disk I/O, while `inFlightSave` records candidate texts (`MAX_SAVE_CANDIDATES`) until `didSave` (or `SAVE_WINDOW_EXPIRE_MS = 5000 ms`).

- On `didSave`, a forced post-save check confirms the saved text on disk, reconciles any outside change that landed during the write (including detecting an external revert back to pre-save `base` when `willSaveRan` was true and the saved candidates did not include `base`), and retries any `pending` outside version whose earlier merge was blocked or deferred.
- **VS Code save-participant disablement tracking:** VS Code 1.146 stops calling a `willSave` listener for the rest of the session after `VSCODE_STEP_ERRORS` (3) timeouts over `VSCODE_STEP_TIMEOUT_MS` (1500 ms). The reconciler tracks timeouts against `SaveStepCount` and emits `saveCheckOff` once per session if a save then arrives with no `willSave` step.
- **Save without Formatting:** runs no `willSave` step; `didSave` still runs the post-save check, records the saved document text as a candidate, and reconciles against disk afterward.

### Beside another rich editor

Another extension's rich editor (such as VS Code's built-in Markdown Editor, `vscode.markdown.editor`) can open the same text document. Because that editor reloads its buffer and shifts the cursor on external edits, the reconciler calls `holdOutside()` before applying a non-save merge (`src/host/model/outsideHold.ts`). While another custom editor is the active tab of the active group, the window has focus, and the document changed within `OUTSIDE_QUIET_MS`, the outside version is backed up and held as `pending`, retrying after `RETRY_MS` until the tab is inactive, focus leaves, or typing pauses. The save step is never held, and VS Code's own reload of a clean document cannot be held.

### A document restored dirty

When a document turns dirty, the host stores the stamp of its base in workspace state under `rememberedBaseKey(uri)` (`src/host/documents.ts`), and forgets it when the document turns clean. A document first seen dirty (restored after reload or crash) whose file matches that remembered stamp adopts the file as its base; otherwise `base` starts as `null` and the first outside change takes the `noBase` handoff path.

On `workspace.onWillRenameFiles`, the host copies the remembered stamp to the new URI and cleans up the old key on `onDidRenameFiles`. Because VS Code 1.146 opens a renamed dirty document clean and immediately sends a dirty-only event, `noteDirtyOnly` handles that transition as a restored dirty document so its opening text is never mistakenly treated as the clean disk base.

### Encodings

A document in an encoding other than UTF-8 or UTF-16 returns `{ kind: 'bytesOnly' }` and is watched by raw bytes (`baselineBytes`) rather than merged. The first clean read and our own saves update `baselineBytes` quietly; any other byte change is backed up (`label: 'undecodable'`), announced as an encoding conflict (`reason: 'encoding'`, `choice: 'none'`), and becomes the new baseline.

### Backups

A backup holds either an outside disk version (on conflict, handoff, truncation, or unsupported encoding) or a copy of the user's text before other words replace it (under `keepTheirs`, "Use Change from Disk", "Replace My View", or a clean reload over unsaved text). Backups live in global storage under `outside-versions/`, named `<note name> (<what it holds>) <yyyy-MM-dd HH.mm.ss> <hash tag>.md` (`src/host/model/backupNames.ts`). Quiet copies (`beforeRemoval`) are pruned under a separate count (`QUIET_MAX_COUNT`) from user-announced backups (`BACKUP_MAX_AGE_DAYS`, `BACKUP_MAX_COUNT`), and backups referenced by an open `.conflict` file are exempt from pruning (`src/host/backups.ts`).

Every comparison opens in VS Code's diff editor (`src/host/backupViews.ts`) with the read-only backup on the left, the live note on the right, and action buttons ("Use Change from Disk", "Replace My View", or "Undo") in the diff title bar while the choice remains valid.

### A backup that cannot be written

If `DiskPort.backup` rejects (full disk or unwritable storage), the base still advances as usual so later merges do not run against a stale base, and the host opens the preserved text in an untitled tab while keeping the notice's choice backed in memory.

### Limits

These are known and accepted. `README.md` and `WORKING_WITH_AGENTS.md` ("Limits") describe the ones users can encounter:

- **Mid-write pauses:** a program that pauses longer than `TRUNCATED_RETRY_MS` (750 ms; 100 ms in a save step) while writing a file can be read partway. If the file looks unmistakably truncated (empty or cut mid-line) on a dirty note, the reconciler hands off without altering the note; on a clean note it keeps a quiet backup and raises `truncatedFollow`.
- **Save-write gap:** an outside write that lands after `willSave` finishes reading and before VS Code's write completes can be overwritten by VS Code's save (VS Code's own editor has the same race). The same applies to "Save without Formatting", which skips `willSave`.
- **Clean note following disk:** if a note has no unsaved edits and another program writes an older copy over a prior save, the clean note follows disk while keeping a quiet backup of the previous text in `outside-versions/`.
- **Moved lines:** as in any line-based 3-way merge, a line moved by one side and deleted at its original location by the other stays at its new location cleanly.
- **Non-UTF-8/16 encodings:** watched by raw bytes, backed up and announced on change, never text-merged.
- **Undo after merge:** VS Code's undo can revert a merged outside change, just like a native reload; the next save writes the undone state.
- **Mixed line endings:** VS Code normalizes mixed EOLs to one style on save, in any editor.
- **Closing races:** an edit still in flight from the webview when a tab closes is captured in a backup and announced (`typingAtClose`); an outside disk write arriving after the document closes is left untouched on disk.
## Merging

`merge3(base, ours, theirs, { prefer, exactBase })` in `src/core/merge3.ts` merges LF texts: the base both sides started from, ours (the open document) and theirs (the file as another program left it). The identities hold first: `ours == theirs` gives that text, `ours == base` gives theirs, `theirs == base` gives ours.

### Two levels

Level 1 is a line merge. Each side is diffed against the base by lines, and the two diffs are combined by diff3's rule (`diff3Regions`, a port of node-diff3's `diff3MergeRegions`): where only one side changed, take it; where both changed the same or touching lines, that stretch goes to level 2.

Level 2 merges the stretch again, split into tokens: runs of word characters, runs of spaces, each line break, and single other characters (each Chinese or Japanese character is a token of its own). A paragraph is one long line, so two edits to different sentences of it must merge with no conflict, and level 2 is what makes that so. At level 2 each side is still diffed by lines first, and by tokens only inside the lines it changed (`sideHunks`).

For example, with the base `The cat sat on the mat. It was warm. The dog slept.`, ours `...on the red mat...` and theirs `...The old dog slept.`, the merge is `The cat sat on the red mat. It was warm. The old dog slept.` with no conflict.

### Every reading

Two changes merge cleanly only when every way of reading the two texts gives the same result. Where text repeats (blank lines, a line or a word that occurs twice), a side's change can be read in more than one place, so each change is taken over every place it could sit (`spanOfPlaces`, `changePlaces`). A kept line counts as kept only when every shortest line diff keeps it (`certainMatches`). A side's token diff is read by its words first, then the stretches between two words it keeps by their other tokens that are not spaces, then with their spaces (`tokenReading`): read with the marks and spaces from the start, a reading that keeps a mark or a space in place of a word is a shortest one too, so "alpha beta gamma" made "alpha gamma delta" would also read as "beta" made "gamma", and a deletion of "beta" by the other side would meet this side's edit; and "see [[a]] and [[b]] or [[c]]" made "se [[d]] e [[a]] and [[b]]" would read as every word changed and the brackets kept, which a deletion of "or [[c]]" by the other side would meet. A run of lines a side rewrote with lines joined, split or of uncertain match pairs its new lines with its old ones only by reading, and is marked in doubt (`LineRun.doubt`).

A line diff pairs only equal lines, so an edited line costs a deletion and an insertion wherever it stands, and a shortest diff can read it as written beside its old self. Where a side removed a blank line on one side of a line it edited and put one on the other, every shortest diff keeps the blank lines paired one further along: the edited line reads as new above a blank line, the old one as deleted below it, each its own change. The other side's change to that line would then meet only the lines read as replacing it, and the edited copy, read as new, would stand whatever the other side did, the words the other side took out of the line included. So each side's line diff, at both levels, pairs a line the side wrote with a line it removed when either shares the most words with the other, counting the words the side's changes remove from one line and write in one line (`joinSplitLines`). Where the diff put the two in different changes with only blank lines, or lines the whole base or the whole side holds more than once (judged so at both levels), kept between, those changes and the lines between are one change, in doubt: the lines between are kept only in the reading that pairs equal lines. When such a change starts or ends at a line kept between the halves, with lines the side wrote before or after it in the reading that pairs equal lines, a change of the other side right at that edge stands where those lines do, and is in doubt too. A line of text each text holds once between them is a block moved, as in "A change split in two". The other side's change to any line of that change then lands in lines in doubt and is a conflict with the edit, kept as the preferred side's text and reported, never the edit applied beside the line as new.

Two changes from the two sides then conflict when they delete the same base token, insert text at a point both can sit at (except whole lines both insert at one certain point when the base is exact, below), one inserts text strictly inside the other's stretch or at either end of the other's replacement, or either lands in lines whose reading is in doubt. Changes that only meet end to end (a deletion next to an edit, edits of neighboring lines) are both applied. The same change made by both sides is taken once. What conflicts goes into the result as the preferred side's text, and the conflict is reported with all three versions of that stretch.

Two examples, as lines:

- Base `A B B C`; ours deletes one `B` (`A B C`); theirs deletes one `B` and appends `E` (`A B C E`). The result is `A B C E` with no conflict. A merge that took ours as deleting the first `B` and theirs as deleting the second would apply both and lose a line that each side kept. Over every reading the two deletions can be the same one, so it is taken once.
- Base `a x x b`; ours deletes one `x` (`a x b`); theirs changes the second `x` to `y` (`a x y b`). This is a conflict: read as deleting the first `x`, ours merges cleanly into `a y b`; read as deleting the second, it collides with theirs's edit. The result keeps ours's `a x b` and reports the stretch. With distinct lines (base `a x z b`, ours `a z b`, theirs `a x y b`) there is only one reading, and the merge is a clean `a y b`.

The merged text is made only of pieces of the three inputs: base lines and tokens, and the content of one side's changes. Nothing else is ever written into it.

### A change split in two

A side's diff can read one change as text removed at one place and written at another. A line moved past a line of text reads so, and so does a word moved within a line. (An edited line read beside its old self across blank lines or repeated lines is one change already, see "Every reading".) Each stretch is resolved on its own, so a conflict can give the preferred side's text where one half is while the other half is applied: where the conflict holds the text the side wrote, the line is then in neither form, and where it holds the text the side removed, the line is written twice.

So the two halves are resolved alike (`keepHalvesTogether`, which runs only when a merge has a conflict). They are found by a word or a whole line that the base, ours and theirs each hold once: one text in all three. Where the stretch holding the base's copy and the stretch holding a side's copy differ, and one of them is a conflict, the other becomes part of the conflict where it applies that side's change (or keeps lines both inserted), until no such stretch is left. The conflict then holds the whole change, and under either preference the merge keeps every word and line that each version holds once. A merge with no conflict is not changed.

Text a version holds more than once is not paired, since which copy a side moved is not known; nor is a line edited until it shares no word with its old form, which reads as a new line and the old one deleted.

A move reads as a deletion and an insertion, as in every line-based merge, and that is a stated limit (`WORKING_WITH_AGENTS.md`, "Limits"): a line one side moves past a line of text, which the other side deletes where it stood, comes back where the moving side put it, as that side left it, with no conflict and no notice. Both sides deleted it at its old place, which merges as one deletion, and the moved copy is a line the moving side wrote. Where the other side edits or rewrites the line instead, the two meet there and conflict. Pairing the two places across lines of text would make every plain move a conflict with any change beside it.

### A text with no final line break

A side whose text ends without the line break the base ends with took that line break off its own last line. Merged as an edit, that removal would come off whatever line the merge puts there, and lines the other side wrote after it would be joined onto that line: a line neither side wrote. So such a side is merged with the line break put back (`merge3Detailed`), and the merged text loses it again only where that side's lines end it (`Output.takeBreaksOff`): where that side's text ends in the last stretch that gives text, and that stretch gives this side's text, as both sides' text alike, as this side's change, or as a conflict with this side preferred. When the other side's lines follow only in a conflict, or the line break stands alone right after a conflict (the one ending the conflict's last line, or a blank line the other side kept), the line break moves into that conflict, as the other side's text and the base's, so each preference ends as its own side does. Lines both sides insert at the end stay a conflict, since text that ends without a line break is not whole lines. A base with no final line break is merged as one with it (`endingOf`, `open`), and so is each side with none either: a side that deletes the last line then takes out that line and never the line break before it, so what the other side typed at the end of that line clashes with the deletion, as it does with a final line break, instead of joining the line above (`lastLineDeletedNoBreak.test.ts`). The merged text loses that line break again where those sides' lines end it; a side that put a final line break on (`grew`) keeps it where its own lines or both sides' alike end the text, and lines both sides append are a conflict only where the two sides end differently. A conflict reports the base as it was, without the line break.

### Lines both sides add at one place

When the caller says the base is exact (`exactBase`), different whole lines that both sides insert at the same place, where neither side deletes or replaces anything there, are not a conflict: both are kept, ours's first (`keepBoth`, chosen in `mergeTokens`). It applies to one insertion from each side that its line diff inserted whole (`RawHunk.fromLines`), each certain to stand at that point (no other reading place), of the same form: text ending in a line break inserted at a line start, or, after a last line with no line break, text starting with one (both then agree on whether the text ends with a line break). A line travels with the blank lines directly before it; blank lines at the end of an insertion lead the line after the place, which both sides share, so they are kept once, as many as the side with more has. Lines common to both, in the same order, appear once; between them ours's lines come first, then theirs's, and a line of theirs that ours's insertion holds elsewhere is not written again (`A`, `B` against `B`, `A` gives `A`, `B`). So the result holds every line of each side, ours's in their order, and no line more often than the side with more copies of it. It stays a conflict when a line only one side has holds the words of a line only the other has, in order and together (`x` and `x y`, or the same words with other spaces): it may be one line edited. And as before: two insertions inside a line; an insertion beside a deletion or replacement by either side; insertions either of which could stand on the other side of an equal line; and insertions that disagree on the text's final line break. `merge3Detailed` reports where the result keeps both sides' lines (`BothInserted`), and what each side's changes brought in (`brought`), for the repeat check.

Against a base older than both sides, one line both already held and each edited looks like two different lines added at one place, and kept both it would stand twice; a half-written file taken as the base does the same to the lines it lacked. So the reconciler passes `exactBase` only when it knows the base is the text the document and the file both started from (`Reconciler.isExactBase()`):

- a read found the document holding the base (the read equaled the document, a text one of its saves wrote, or a text VS Code put in it), not a merged version or a stand-in;
- the document has had no undo or redo, and no reload or revert of VS Code's, since it held that text (`jumps`), so it is that text plus edits (an undo can take it back past a reload of a half-written file, to text the base lacks, and a reload can put another program's text into it with the base where it was);
- no text a save of ours may have written is unconfirmed (see "Outside changes", "The base"), so nothing of ours reached the file after the base either.

A half-written file the document loaded and then only edited is harmless: the document cannot hold the rest of that file, so keeping both writes the rest after the user's lines (the limit "VS Code itself may reload a half-written file"), never a line twice. Every other merge is made without `exactBase`, and lines both add at one place stay a conflict there, as do merges of a pending version the disk no longer holds.

### The work allowance

Every diff in a merge is `diff.ts`'s sequence diff (the linear-space search of E. W. Myers' "An O(ND) Difference Algorithm and Its Variations"), drawing on one work allowance per merge, `MERGE_WORK`, because a merge runs inside the save step and its cost must be bounded. The allowance is sized so that a merge of 1 MB texts that spends it all stops in about a quarter of a second, while ordinary merges, tens of edits a side, use a small part of it. When it runs out the merge does not guess: it returns the preferred side whole, with one conflict over the whole text, so the other side goes to a backup and the user is told. `diffChanges` has an allowance of its own (`CALL_WORK`): once spent, what is left of a stretch is one replacement trimmed to its common start and end, which is still exact, only coarser.

### The repeat check

A three-way merge only takes text from one side or the other, so text can occur more often in the result than in either side only where both sides' changes brought it in (the same phrase added in different places) or a change was applied twice. `safeMerge` (`src/core/safeMerge.ts`) refuses a result that repeats text: the preferred side is kept whole, and the whole difference is reported as one conflict. `merge3Detailed` reports, stretch by stretch, the text each side's changes brought into the result (`brought`: a change only that side made, its side of a conflict where the merge took it, its lines where lines both sides inserted are kept together, each with where it starts in that side's text), and the check (`repeatsText`) reads that. A result repeats text when it holds a line a side holds more often than each side and than both sides' changes give it together (ours's count and theirs's, less the base's). Against a base known exact (`exactBase`), nothing both sides brought in counts beyond that: it is two additions. Against any other base, two more tests count it. A line both sides' changes brought in, held more often than each side, is a repeat where a copy from each side stands between the same lines in both texts (`standsAtOnePlace`: the nearest line before it that is not blank, or after it, is the same line): that is one line both sides held, which a base older than both lacks, written once from each, while the same line added at two places stands between different lines. And a run of three tokens within one line, one of them rare (each side holds it at most `RARE_TOKEN` times), that both sides' changes brought in, is a repeat where the result holds it more often than each side. Text only one side's changes brought in is no repeat, and since a run lies within one line, no run is made where one line ends and the next begins: an addition that ends with "Done." just before a line that starts with "Next", and another that starts with "Next" just after a line that ends with "Done.", merge (`safeMerge.test.ts`).

Runs are made of words and other marks without the markup lines share whatever their words (`runTokens`, each line's `lineWords`, which the lines-first comparison matches lines by too: the marks at a line's start, quote marks, a list item's or a task's marker and a heading's marks, and emphasis marks; a line of markup alone keeps its marks), so two task lines or two headings both sides added at different places, which share "- [ ]" or "##" and a word, are no text repeated. A blank line, empty or of spaces only, holds no text, and no part of the check counts it. The check counts lines over the four whole texts, and reads runs only in what both sides' changes brought in, counting a run in the whole texts only when both brought it in. Where the merge kept lines both sides inserted at one place, those lines may share words: a run's copies in that stretch count only beyond what the stretch would hold as one side's lines alone, read in the stretch itself (`keptTogether`), and such a stretch that holds a line more often than both sides' lines there do is still a repeat.

## What VS Code is assumed to do

The core rests on these behaviors of VS Code, seen in VS Code 1.146. `itest/suite/vscodeAssumptions.test.ts` records the first four in a real VS Code and fails if a version behaves differently; it also passes on 1.120, the floor in `engines.vscode`, and CI runs it on both the floor and the current stable release. The simulation's stand-in for the document (`test/sync/fakes/document.ts`) behaves the same way.

1. **The dirty flag lags.** The first edit to a clean document, of any kind (typing, `TextEditor.edit`, a `WorkspaceEdit`, a panel's push, the first save participant's edit), arrives in a change event that says the document is clean, and a separate event with no content changes turns it dirty a moment later. A reload from disk is one clean change with nothing after it. So a clean change does not show that VS Code read the file. Undo back to the saved version arrives dirty and turns clean after; Revert File marks the document clean first, then puts the file's text in it.
2. **An applied edit's change event comes first.** The change event of an applied `WorkspaceEdit` reaches the extension host before `workspace.applyEdit` resolves. The gate depends on this.
3. **"Save without Formatting" runs no will-save step**, nor any other save participant. VS Code also stops calling a will-save listener it judges too slow.
4. **An edit to a closed document is not refused.** `workspace.applyEdit` on a closed document's uri resolves true: VS Code loads the file as it is at that moment and applies the ranges to it, with no version check, giving an unsaved document no editor shows. Hence "Closing" above.

And, relied on elsewhere:

- VS Code refuses an edit when the document moved since the extension host last saw it, and an edit that changes nothing resolves false with no event. The editor may add a change of its own to an applied edit (trimming whitespace).
- A clean document whose file changes is reloaded as one replacement from the first changed line to the last, after a separate whole-document event if the line ending changed.
- A language change fires `onDidCloseTextDocument` and then `onDidOpenTextDocument` for the same object, which is not closed.
- `reopenActiveEditorWith` takes an editor id (`tandemMarkdown.editor` or `default`), acts on the active editor of the active group, and replaces the tab in place, clean or dirty, without a prompt.
- For an active custom text editor, VS Code's `undo` and `redo` act on its document.
- `workspace.fs.stat` does not report a local file's read-only attribute; only a read-only file system is reported.
- Setting `webview.html` to the same string does nothing, so a reload needs a new page (each page has a new nonce).

On VS Code 1.100 to 1.119, switching views reverts the document to the file and discards unsaved text; 1.120 does not. That is why `engines.vscode` is `^1.120.0`.

## The host

The host (`src/host`) joins the document core to VS Code. It implements the core's ports, forwards VS Code's events to one coordinator per markdown document, hosts the panel in a custom editor, switches views and runs the commands. It decides nothing about text.

### Activation

`package.json` lists one activation event, `onLanguage:markdown`: a markdown document open in any editor needs a coordinator, because outside changes are merged in Source too. VS Code adds the rest from the contributions: the custom editor (`onCustomEditor:tandemMarkdown.editor`), every contributed command, and the outline view. Nothing activates the extension in a window with no markdown file.

`activate` (`src/host/extension.ts`) starts, in order: the log; the panel registry and the documents, which create coordinators for documents already open; the custom editor and the commands; then the features. In test mode it returns the test hook.

The extension runs in untrusted workspaces (it runs no workspace code) and in virtual workspaces with a limit: a document whose scheme is not `file` has no reconciler, and one whose scheme is neither `file` nor `untitled` opens in Rich view only.

### Files

| File | Holds |
|---|---|
| `extension.ts` | `activate` |
| `documents.ts` | One coordinator per document, its three ports, VS Code's events |
| `provider.ts` | The custom editor, the page, its content policy, the start guard |
| `panels.ts`, `panelValue.ts`, `contextKeys.ts` | The panel registry; a value each live panel is kept told of, such as whether its note holds unsaved changes, posted only when it differs from what that panel holds; the context keys the extension sets, each set again only when its value changes |
| `panelMessages.ts` | The router for messages from panels |
| `modeSwitch.ts` | Switching views |
| `commands.ts`, `commandRegistration.ts` | The host's general commands and those forwarded to the panel; `registerCommand`, through which every command is registered, which imports of the host only the log and `model/commandTitles.ts`, so a module whose commands commands.ts starts does not import it back |
| `tabs.ts`, `uris.ts`, `strings.ts` | Tabs (`isOurTab`, `panelOfTab`, `otherRichEditorActive`, `currentTab`, `showTarget`), uri and path helpers, interface text the host shares |
| `localFiles.ts`, `questions.ts` | The host's own writes of whole files and whether a file is there; the questions commands ask (a modal question, a message with buttons, a pick from a list), which the test hook answers in the suite |
| `scrollSync.ts` | Scroll sync: which documents are linked, the title bar's context keys, and leading and following (see "Scroll sync") |
| `openToSide.ts` | Opening a view in the group beside (see "Opening to the side") |
| `settings.ts` | The settings a panel needs |
| `statusPlaces.ts` | Where each of the extension's status bar items stands |
| `notices.ts`, `backups.ts`, `backupViews.ts`, `heldTexts.ts`, `log.ts` | The core's notices; backup files; comparing with a backup, Compare with Backup and the backups button (see "Backups on the host"); the texts held in memory that comparisons open; the log channel |
| `viewPlaces.ts` | Where each note opens in a rich tab (see "Where a note opens") |
| `conflictFiles.ts`, `conflictFileWriter.ts`, `conflictViews.ts`, `gitExplains.ts`, `agentInstructions.ts` | Conflict files beside notes: their parts; the file on disk; their Problems warnings and quick fix, status bar count and Copy Prompt for Agent; whether git explains a change; Add Agent Instructions and its offer (see "Conflict files") |
| `features.ts` | The host's features, started after everything above |
| `links/` | Links: `location.ts` (where a note is), `linkService.ts` (the index), `openLink.ts`, `notePreview.ts` (a note's preview and what an embed shows), `embeds.ts` (embeds' answers and the notes they watch), and `index.ts` (the feature) |
| `images.ts`, `tags.ts`, `verify.ts`, `defaults.ts`, `statusBar.ts`, `outlineView.ts`, `tabFocus.ts`, `copyLines.ts` | The other features (`tags.ts` opens VS Code's search for a tag; `tabFocus.ts` is Tab Moves Focus; `copyLines.ts` is Copy Relative Path with Line Numbers) |
| `diagnostics.ts`, `rename.ts`, `completions.ts`, `changeMarks.ts`, `gitConflicts.ts`, `gitApi.ts`, `gitFollow.ts`, `panelText.ts` | VS Code's own features in the rich views: problems and quick fixes, rename, suggestions, git change marks, whether git lists a note as in conflict, the part of the git extension's interface they use and following it over time, and how places cross between a panel and the host (see "VS Code's features in the rich views") |
| `testApi.ts`, `testSnapshots.ts` | The test hook: with what five commands resolve with, the in-VS-Code suite's way into the extension (test mode only; see "The test hook"); the readers features hand it (`exposeSnapshot`) |
| `model/` | Everything above that needs no VS Code: the document's text read once per version (`documentText.ts`), whether an outside change waits (`outsideHold.ts`), the link index (`folderIndex.ts`), reading a link's address (`linkAddress.ts`), a note's preview text (`notePreviewText.ts`), the emoji list a hover card and the outline read emoji codes by (`emojiNames.ts`), the part of a note an embed shows (`noteSection.ts`), path containment (`insideFolder.ts`), heading anchors (`headingAnchors.ts`), anchors written as HTML (`namedAnchors.ts`), links to a line (`lineFragment.ts`), pasted image names (`pastedImages.ts`), what a tag search looks for (`tagSearch.ts`), globs and those of markdown files (`glob.ts`), the status bar's texts (`wordCountText.ts`), the outline's nesting (`outlineTree.ts`), `timestamp.ts`, backup names (`backupNames.ts`), Verify File's comparisons (`verifyText.ts`), the problems a panel is sent (`diagnosticItems.ts`), VS Code's suggestions as the panel takes them (`suggestions.ts`), the lines changed since a commit (`lineChanges.ts`), where a line stands after an edit (`lineEdits.ts`), which documents the rich views are offered for (`richOffered.ts`), the reads of a document's file (`fileReads.ts`), when a commit explains a write (`gitWhen.ts`), the language change that reloads a panel (`languageReload.ts`), a command's name in its failure message (`commandTitles.ts`), which backups go (`backupPrune.ts`) and how a backup is listed and its comparison titled (`backupViews.ts`), where a note opens again (`viewPlaces.ts`), what Copy Relative Path with Line Numbers copies (`lineReference.ts`), a conflict file's name (`conflictName.ts`), what a conflict file says (`conflictFileWords.ts`, `conflictFileParts.ts`, `conflictFileText.ts`), which notices give it a part (`noticeParts.ts`, `textChanges.ts`), what the left-out warning's quick fix replies when the core's put-back changes nothing (`putBackReply.ts`), how two versions of a line differ, in words (`lineDifference.ts`), when a part comes and goes (`conflictStore.ts`), its status bar and prompt (`conflictStatus.ts`), the agent instructions' places (`agentInstructions.ts`), which documents' tabs are linked (`scrollLinks.ts`) and a text editor's place and who leads from it (`textEditorFollow.ts`), the tab the user is in (`currentTab.ts`) and the tab a title bar Show button acts on (`showButtons.ts`), the ids of this extension's editor and of VS Code's text editor (`VIEW_TYPE`, `TEXT_EDITOR`; `editorIds.ts`), which editor VS Code opens a file in by its editor associations (`editorAssociations.ts`), what Use Tandem Markdown by Default and Use Source by Default say (`defaultsWords.ts`), and `templates.ts`, which hands the host's words tables the core's `fill` |

### Documents

Every open document with language `markdown` and scheme `file` gets a coordinator from the moment it opens, whether or not a panel shows it, and it has a reconciler. Any other document opened in our editor gets a coordinator too: a `.txt` file with a reconciler, anything else with none, read-only unless its scheme is `file` or `untitled` (a git revision, say). A read-only document (a read-only file system, or a scheme that is not `file`) opens in Rich view, its checkboxes do nothing, and pushes are refused. A language change is not a close: a document that has a reconciler keeps its coordinator, whatever its language, until it closes, so versions waiting and the backups its messages name stay its own; a document with none that turns markdown while panels show it gains a coordinator with one, and the panels move to it.

On a rename the remembered base, the rich tab, the place kept and the backups follow the file (see "Outside changes", "A document restored dirty", "Where a note opens" and "Backups on the host"). The document's text is read from VS Code at most once per version (`documentText`): VS Code joins its lines again on every `getText()`.

### Reading the file

The reconciler's stat and read of a document's file go through Node's file system (`model/fileReads.ts`), not `workspace.fs`, which in VS Code 1.146 first makes a round trip to the window on every call, and around a save the window is busy saving. A stat queries attributes only, and a read opens the file shared for reading, writing and deleting, so neither can refuse another program's write. Reads run one at a time in a worker thread, each opened, read and closed in one go: where a virus scanner holds the first open of a changed file, the open of VS Code's save waits for the same scan, and a read made of event-loop steps, each waiting its turn, would mostly lose that race. A read with no answer after `READ_ANSWER_MS` (a network share that dropped) is abandoned: it fails, the check is tried again, and the worker is replaced.

### The editor and its page

`provider.ts` attaches each new panel to its document's coordinator before the page exists; the coordinator posts `init` when the page sends `ready`, and until then the panel gets no updates. Webviews are created with `retainContextWhenHidden`, so switching tabs does not rebuild the editor.

A file VS Code opens at a line (a search result, a link to a line, Quick Open's `file.md:12`) opens in a rich view where it was left (see "Where a note opens"), not at the line. VS Code hands the line to the editor pane in the open options and no further: `resolveCustomTextEditor` receives the document, the panel and a cancellation token, and a custom editor's tab carries only its uri and view type. From 1.142 VS Code passes the line on to a custom text editor that implements `resolveCustomTextEditorNavigation`, but that is the proposed `customTextEditorNavigation` interface, which a stable VS Code withholds from any extension it does not list itself, and `vsce` refuses to publish an extension that declares it. The panel's own links to a line are opened by the host and do reach it (see "Links and images on the host").

The page has a strict content policy (`pageHtml`): `default-src 'none'`; scripts and styles only with the page's nonce or from the webview's resource origin (`cspSource`); images from that origin, `https:` and `data:`; video and sound from that origin and `https:`; fonts from that origin; `form-action 'none'` and `base-uri 'none'`. There is no `'unsafe-inline'`: styles are set through the DOM's style object, never through a `style` attribute. The nonce is also in a `<meta>` element so CodeMirror can put it on its own style elements, and the address of `dist/panel/` is in `<meta name="tm-assets">`, where the panel finds the files it loads on demand (KaTeX's stylesheet and fonts). The resource roots are the extension's `dist`, every workspace folder and the document's folder.

`https:` in `img-src` and `media-src` is the upper bound, fixed when the page is built; whether a picture or a player's file from a web address loads is decided by one setting, `tandemMarkdown.images.allowRemote`, which the host's `resolveImages` reads: every picture and player the panel draws, in markdown or in HTML, takes its address from there. The HTML door reads the setting too, for HTML in a line. `data:` is there for the panel's own icons and for pictures stored in a file, which the door limits to PNG, JPEG, GIF and WebP.

A small inline script, with the nonce, guards the start: when the panel bundle fails to load or throws before it has drawn anything, the page shows "Tandem Markdown could not start in this tab." with "Show Source", and reports `startFailed`, so nothing waits on a page that will never answer.

### Where a note opens

A rich tab opens where its note was left: after a reload or a restart of VS Code, and when the note is opened again after its tab closed (`viewPlaces.ts`, `model/viewPlaces.ts`). The place last reported by any rich tab of a note, its selection, the line at its top and the rich view, is kept in the workspace's state by the note's uri, with a hash of the note's text and a hash of the first line at or below the top that holds more than white space, never the text itself, for the last `PLACES_KEPT` notes; a note never saved keeps none. It is kept once the reports have settled (`KEEP_AFTER_MS`), and at once when the note's last rich tab closes. A tab that opens with a place of its own (a switch from Source, an open to the side) takes that; any other takes the kept place, with the view a command asked for when it named one. A note whose text is the same opens at the same place; a note changed since opens with that line at the top again where the line is still in it, the copy nearest where it was, and at the top otherwise, in the rich view it was left in. Two rich tabs of one note open at the place last reported by either. A rename VS Code reports (`onDidRenameFiles`: the Explorer, a workspace edit) takes the place of each note under the renamed path, a folder's notes included, to the note's new path. VS Code reports no rename made by another program, or through `workspace.fs`: it sees one file deleted and another created, so the note opens at its new path as if new, and its place stays under the old path until newer notes push it out.

### The panel registry and context keys

`panels` (`panels.ts`) knows every open panel, which one is active, each panel's mode and last reported view state. It sets three context keys describing the active panel:

- `tandemMarkdown.editorFocus`: focus is anywhere in the panel's page (the editor, the toolbar, a notice, a field in it);
- `tandemMarkdown.fieldFocus`: a text field inside the panel has focus (a table cell, the find box);
- `tandemMarkdown.mode`: `view` or `edit`, or empty when the active editor is not ours.

It also keeps two lists of files for the title bar's Show buttons, `tandemMarkdown.richViewFiles` and `tandemMarkdown.richEditorFiles` (see "The title bar's Show buttons").

The keys are set from the panel's `focus` messages, so every keybinding that reads them also requires `activeCustomEditorId == 'tandemMarkdown.editor'`, which VS Code keeps itself. A panel that stops being active is taken to have lost focus.

Post only to a panel that is live (sent its `init`): a page that has not had its init drops what it gets.

What other host code sees of a panel is a `HostPanel`: `id`, `document`, `uri`, `webviewPanel` (its `webview.asWebviewUri` serves a picture), `readOnly`, `mode`, `viewState` (the last reported: LF offsets and a zero-based `topLine`), `focus`, `live`, `disposed` and `post(message)`.

```ts
const p = panels.activePanel();             // undefined when the active editor is not ours
p?.post({ type: 'command', id: 'revealHeading', args: { from } });
panels.panelsFor(uri);                      // every panel of one document
panels.onDidChangeViewState((p) => {});     // selection, scroll or mode reported, or the mode changed by a command
panels.onDidBecomeLive((p) => {});          // a panel was sent its init (open, reload, resync)
```

### Messages from panels

Every message from a page goes to the coordinator first: it takes `ready`, `push`, `resyncRequest`, `fault` and `flushed`, and it needs to see every message to know the panel is alive. `viewState` and `focus` go to the registry and `log` to the log channel. Anything else goes to the handler registered for its type:

```ts
registerPanelMessageHandler('resolveLinks', async (message, panel) => ({ ... }));
```

A handler receives the message unchecked and must check every field it reads. Its return value, awaited, answers a message that carried a `requestId`; what it throws becomes the error. One handler per type: registering a type twice, or one the host takes itself, throws.

### Features

A host feature is a function `(context, documents) => Disposable` in its own file, listed in `features.ts`. It answers panel requests with `registerPanelMessageHandler`, registers its commands with `registerCommand` (`commandRegistration.ts`), and reaches panels through `panels`. Features start after the documents, the registry and the router exist.

### The tab the user is in

The commands that act on "the active tab" (the view commands and opening to the side from the palette or a key, Switch View, Verify File, Toggle Scroll Sync, and undo, redo, save and close from a panel) find it with `currentTab()` (`tabs.ts`, the rule in `model/currentTab.ts`). It is the active group's active tab, with one exception.

About a quarter of a second after a text editor opened beside a webview tab takes focus, VS Code at times makes the webview tab's group active again while the keyboard stays in the text editor (often on 1.146, rarely on 1.120, and with its own Markdown Editor as well). The tab API then names the webview tab, and `window.activeTextEditor` names the text editor: VS Code's main thread gives the active text editor as the text editor whose text has focus, before the active group's editor. So when the active tab is a rich tab whose page reports no focus (its own `focus` report, the one `tandemMarkdown.editorFocus` shows) and the active text editor is the active tab of its own group, the user is in that text editor's tab.

`window.activeTextEditor` alone would not do: VS Code works it out again only when a text editor gains focus or the active editor changes, so when the keyboard then moves into the rich tab, which is the active editor already, it still names the text editor. The rich tab's own report says where the keyboard is. In VS Code's ordinary states the rule gives the active tab: a rich tab with the keyboard has no active text editor; the commit box and the chat box are editors VS Code leaves out of the active text editor; with the keyboard in the Output view, a notebook cell or a diff, the active text editor is not the active tab of a group; in the Problems or the Search view, or with the window unfocused, it is the one VS Code named before.

Two places keep the active group on purpose. `reopenActiveEditorWith` acts on VS Code's active editor, so a switch first makes the tab it switches the active one and then checks that it is (`activeTabShows`). The hold for another extension's rich editor (`otherRichEditorActive`) reads the active group: that editor reports nothing about the keyboard, and holding a change only delays it.

A Show button on a title bar acts on the tab it is drawn for when that can be told (see "The title bar's Show buttons").

### Switching views

The view commands act on the tab the user is in (above), or from a title bar on the tab the button is for (below), whatever editor it is: any editor that is not ours counts as Source. They read the tab through the tab API. Rich view and Rich editor are one panel, and switching between them is a `setMode` message; nothing reloads.

- **Source to rich**: the text editor's selection and top line are stored for the uri, then the tab is replaced in place with `reopenActiveEditorWith`. The new panel's `init` carries the stored view state. If that command is missing or does not replace the tab, `vscode.openWith` opens the panel and the old tab is closed only when it is not dirty, since closing a dirty tab would ask to save.
- **Rich to Source**: flush the panel; if it is not clean, stop with "Source didn't open. Try again in a moment." Then, holding the gate, `reopenActiveEditorWith` with `default`, and the text editor gets the panel's selection and top line.

`reopenActiveEditorWith` is given no resource: VS Code would look one up with `findEditors`, whose first match may be in another group, so the host checks instead that the panel is still the active editor.

A switch never saves, never prompts and never closes a dirty tab. The custom editor is registered with `priority: "option"`, so Source stays the way markdown opens unless the user chooses otherwise ("Use Tandem Markdown by Default"; it and "Use Source by Default" are the only commands that write settings, after asking: the `*.md` and `*.markdown` entries of the user's `workbench.editorAssociations`, and of `workbench.diffEditorAssociations`, which keeps comparisons in VS Code's text comparison, as VS Code 1.120 to 1.128 would not otherwise; `defaults.ts`). An entry the commands do not write can still decide where a note opens. VS Code takes, of the entries that match a file, the workspace's over the user's and the user's over a default's for one pattern, then the longest pattern of all, passing over an editor that is neither VS Code's own nor a custom editor or notebook of an installed extension; both settings are the window's, so the workspace's own value counts (`.vscode/settings.json` for a folder, the settings of a `.code-workspace` file) and a folder's never does (`model/editorAssociations.ts`). Before asking, after writing, and when the user's settings already say what was asked, the commands work out which entry wins for a plain note at the top of each workspace folder, then for the note in the active tab, and name one that keeps markdown files, or for the Rich editor their comparisons, from opening where asked, with the file that holds it (`model/defaultsWords.ts`). They never change it.

### The title bar's Show buttons

A markdown file's title bar has Show Source (on a rich tab), Show Rich View and Show Rich Editor, less the one for the view the tab is in; with Alt held they are Open Source, Open Rich View and Open Rich Editor to the Side. VS Code draws the editor actions for the active group alone, on its title bar or on the window's, unless `workbench.editor.alwaysShowEditorActions` is on with the actions on the groups' own title bars (`editorActionsLocation` `default`, tabs shown): then on every group's title bar (`actionsOnEveryGroup`, `model/showButtons.ts`). A button runs its command with the file of the tab it is drawn for and VS Code's own id of its group, which the extension API cannot match to a tab group, and clicking it does not make its group active (1.120 and 1.146 alike).

**Two forms of a button.** VS Code judges a title bar's `when` clauses for that group's own tab, `activeCustomEditorId` among them. So Show Rich View and Show Rich Editor, and their Alt forms, each have two title bar forms, commands of their own named for the tabs they are drawn on: `showRichViewOnRichTab` and `showRichViewOnSourceTab`, `showRichEditorOnRichTab` and `showRichEditorOnSourceTab`, `openRichViewToSideOnRichTab` and `openRichViewToSideOnSourceTab`, `openRichEditorToSideOnRichTab` and `openRichEditorToSideOnSourceTab`. The `OnRichTab` form is drawn where `activeCustomEditorId == 'tandemMarkdown.editor'`, the `OnSourceTab` form on every other tab of markdown. They have the titles and icons of the plain commands and are kept out of the Command Palette; the palette and the keys run the plain commands, which act on the tab the user is in. Show Source is drawn on rich tabs only and has one form, the plain command.

**What a rich tab offers.** `panels` keeps two lists of files as `uri.toString()`, from the rich tabs the buttons are drawn for (every visible one, or else the active panel alone): `tandemMarkdown.richViewFiles`, the files with such a tab in Rich view (a read-only document's always is), and `tandemMarkdown.richEditorFiles`, those with one in the Rich editor. On a rich tab, Show Rich View needs `resource in tandemMarkdown.richEditorFiles` and Show Rich Editor `resource in tandemMarkdown.richViewFiles`, so a rich tab offers what fits its own file's tabs, not the active panel's mode. A file shown in both rich views at once is in both lists, and both its rich tabs offer both buttons. The keys keep `tandemMarkdown.mode`, the active panel's.

**The tab a click acts on** (`showTarget` in `tabs.ts`, the rule in `model/showButtons.ts`): of the groups' active tabs showing the file that the buttons are drawn for, one of the kind the clicked form is drawn on (rich, or not ours) that the button would change. Show Source changes a rich tab; Show Rich View a Source tab or a rich tab in the Rich editor; Show Rich Editor a Source tab or a rich tab in Rich view. On a Source tab the rich buttons are drawn for markdown only, by language or by name, not for a `.txt` file or untitled plain text. With one such tab, that one; with several, the tab the user is in when it is one of them, else the first by column. The Alt forms start from the tab chosen the same way. A plain command given a file by other code takes a tab of either kind.

With the buttons drawn for the active group alone, that is the active group's tab, even while VS Code leaves the keyboard in a text editor beside it ("The tab the user is in"). With them on every group's title bar, a button cannot tell apart two visible tabs of one file of the same kind that it would both change: two Source tabs, two rich tabs for Show Source, or two rich tabs in the same view (two in the Rich editor for Show Rich View, two in Rich view for Show Rich Editor). It then acts on the one the user is in, or the first by column.

### Scroll sync

The visible tabs of one document scroll together while the document is linked (`scrollSync.ts`). A tab is visible when it is its group's active tab, and the tabs that count are VS Code's text editor and ours, in any mix: Source and Source, Source and rich, rich and rich, three at once.

**Linked.** One value per document, kept in memory for the window (`ScrollLinks`, `model/scrollLinks.ts`) and shared by all its tabs. A document nobody has toggled starts linked when `tandemMarkdown.scrollSync` is on and a rich tab of it is among its visible tabs; visible only in Source tabs it starts not linked, so VS Code's own editors scroll as they always have until the user links them. Once toggled, the choice holds whatever tabs the document has, and it follows a rename VS Code reports, of the note or a folder holding it. A markdown document can always be linked; a `.txt` or untitled document only while a rich tab of it is visible (`canLink`), so ordinary text files are left alone.

**The button.** The host keeps two context keys, each a list of documents as `uri.toString()`: `tandemMarkdown.scrollSyncOn`, those visible in two or more tabs and linked, and `tandemMarkdown.scrollSyncOff`, those visible in two or more tabs and not linked. A context key is the window's, while `resource` in a title bar's `when` clause is that group's own tab, so `resource in tandemMarkdown.scrollSyncOn` shows "Turn Off Scroll Sync" (icon `sync`) on every visible tab of a linked document, and `resource in tandemMarkdown.scrollSyncOff` shows "Turn On Scroll Sync" (icon `sync-ignored`) on every visible tab of one that is not; a click on either changes the document's one value. VS Code (1.120 and 1.146 alike) sets `resource` to the uri's `toString()`, and `in` compares `file:` uris in a list without case on Windows. "Toggle Scroll Sync" acts on the active tab's document. None of them writes a setting.

**Places.** A rich view reads its place from the line block at its top pixel (`placeAtHeight`, `src/panel/scrollFollow.ts`). A block drawn taller or shorter than its source (a picture, a table, a diagram, hidden front matter) stands for its lines in proportion: halfway down a table drawn over lines 10 to 19 is line 15. It puts a place at its top to the pixel (`ScrollFollow.goTo`), first scrolling an undrawn line into view, since a line's height is only an estimate until it is drawn. A text editor's place is the start of its first visible range, which VS Code gives as its first completely visible row: the line, and for a wrapped line the share of its characters before that row (`placeOfTop`). A place is shown in a text editor with `revealRange` and `AtTop`, at the line and, where lines wrap (`editor.wordWrap`), the character the share falls on (`revealPosition`), as VS Code's markdown preview does.

**Who leads.** The tab the user scrolls leads, and every other visible tab of the document goes to its place: the host sends a rich view `scrollTo { line }` and reveals the place in a text editor. Neither side uses a clock to tell the user's scroll from a follow.

- A rich view decides for itself, and tells the host only of the user's scrolls, with `scrolled { line }`, while the host has linked it (`scrollLink { linked }`). It marks a scroll of its own (a follow, or the place an init or a resync restores) from its start to its last write. After that, CodeMirror goes on moving the view by a pixel or a few as it measures lines it had estimated, and the browser rounds the position to whole pixels, so a place alone cannot tell the two apart: a scroll is the user's only when the user has acted in the page since the view's own last scroll (a wheel, a key, a pointer or a touch, or a command from VS Code, such as a heading chosen in the outline), and it shows another place than the one last reported or landed on, carried through edits (`LeadWatch`).
- The host decides for each text editor from what it reports (`EditorFollow`, `model/textEditorFollow.ts`). VS Code puts a revealed line up to `padding` rows below the top: room it keeps above the line for sticky scroll's headings (`editor.stickyScroll.maxLineCount`, 5 by default) or for `editor.cursorSurroundingLines`, whichever is more. A report answers a reveal when the line asked for, or the fold that hides it, is in view, the top is not past it, and at most `padding` visible lines lie above it, or when the editor shows the document's last line and cannot scroll further. Reveals still on their way are kept, oldest first, and a reveal that would not move the editor (it is at that place already) is not sent. With `editor.smoothScrolling`, VS Code reports each step of a reveal, and a report on the way from the last top to the line asked for answers it too.
- A text editor's report whose top did not move (only its bottom did, or an edit moved the text and VS Code kept it in place) is no lead. VS Code keeps the text in place over an edit only in an editor without focus whose document another code editor shows too.

Typing moves no other tab. It changes what a tab shows at its top only when it scrolls that tab, as typing on the last visible line does, and then that tab leads.

**What it costs.** While no document is linked and visible twice, no rich view listens for scrolling, the host has no visible ranges listener, and nothing is posted to a page; the host's listeners on tabs and editors only work out which documents are visible twice. A leading rich view posts one message per scroll event. `scripts/speed/follow.mjs` measures a rich view scrolled alone, linked, and with a second one following.

**What does not follow exactly.**

- A text editor reports whole rows: scrolled partway into a row, it reports the next.
- When a rich tab leads, a text editor shows the line up to `padding` rows below its top, as VS Code reveals any line; when the text editor leads, its top row is at the rich tab's top.
- A line folded away in Source: the other tabs follow to it, and Source shows the fold.
- After a text editor has followed, the user's own scrolls of it within the `padding` rows above the line it was put at are taken for the answers to reveals still kept; scrolling on leads.
- Word wrap turned off in one editor with View: Toggle Word Wrap while `editor.wordWrap` is on: a rich tab leading inside a long line also scrolls that editor sideways.
- An edit by another program above the top of both tabs: VS Code's text editor keeps its scroll position and the text moves under it, while a rich tab keeps showing the same text. They differ by the lines added or removed until the next scroll.

### Opening to the side

"Open Rich View to the Side", "Open Rich Editor to the Side" and, from a rich tab, "Open Source to the Side" (`openToSide.ts`) open the tab's document in the group beside it with `preserveFocus`, so focus stays where it is. They are the `alt` commands of the title bar's Show Rich View, Show Rich Editor and Show Source, as VS Code's own Open Preview to the Side is of its preview button: with Alt held (or Shift, on Windows and Linux) the buttons run them instead.

- **The group beside** is VS Code's `ViewColumn.Beside` when the tab's group is the active one: the next group in the direction `workbench.editor.openSideBySideDirection` names, made when there is none. VS Code reckons Beside from the active group, so for a button of a group that is not active the column after the tab's group is used. VS Code makes a group active when an editor is opened in it by column number with `preserveFocus` (`handleGroupActivation`, in its `editorGroupFinder.ts`), so after such a button the group the rich tab opened in is the active one while the keyboard stays where it was; a text editor opened with `showTextDocument` and `preserveFocus` leaves the active group as it was.
- **The place.** A new rich tab gets the tab's view state as a switch from Source does (`setPendingOpen` in `modeSwitch.ts`): from a text editor, its selection and top line, and, once the panel is live, a `scrollTo` with the share of a wrapped top line; from a rich tab, its last reported view state. A new text editor gets the rich tab's selection, and its top line through scroll sync's `revealPlace`, so that the answer to that reveal is not taken for the user's scroll once the tabs are linked.
- **Gone to, not opened twice.** VS Code shows an editor a group already has (the same uri in our editor, or in its text editor) instead of opening another. That tab keeps its own place, and a rich tab there is switched to the view asked for, since one panel holds both rich views. `vscode.openWith` resolves once VS Code has had our editor resolve the tab, so a new panel is already in the registry then, and one that is not there was reused.

### The outline view and the status bar

The outline (`outlineView.ts`, `model/outlineTree.ts`) is the Explorer view `tandemMarkdown.outline`, declared with `when: activeCustomEditorId == 'tandemMarkdown.editor'`, so it shows only while one of our panels is the active editor: that panel's headings, nested by level, from `buildOutline`, the parser the panel draws with, which leaves out the front matter by the one rule in `src/core/frontmatter.ts`. It is built again when the active panel changes and shortly after its document last changed, never while the view is out of sight. The heading the panel is scrolled to is selected without taking focus; choosing a heading runs `tandemMarkdown.revealHeading` with the offset of its line, and the panel scrolls to it. A note with no headings shows "No headings in this file."

The status bar (`statusBar.ts`, `model/wordCountText.ts`), while one of our panels is the active editor, shows the word count ("1,204 words", or "37 of 1,204 words" with a selection, the tooltip giving the characters the same way), counted without the front matter, and the view's name, which runs Switch View when clicked.

### Commands and keys

`package.json` declares every command, menu, key, view and setting. The host runs the view commands, undo and redo, save, close and the log commands; the formatting, find, Open Link, Rename and Quick Fix commands are forwarded to the active panel as `{ type: 'command', id }`, and the panel runs them. A command that only forwards is one entry in `FORWARDED` (`commands.ts`), plus its declaration and key in `package.json`.

Every panel key applies only when `activeCustomEditorId == 'tandemMarkdown.editor' && tandemMarkdown.editorFocus`; the formatting keys also need `tandemMarkdown.mode == 'edit'` and `!tandemMarkdown.fieldFocus`. Switch View applies wherever a markdown file is the active tab. A key CodeMirror also binds would act in the page before the forwarded command arrives, so `src/panel/editor.ts` leaves such keys out of the panel's base keymap (`KEYS_VSCODE_OWNS`). On a Mac the Alt keys of Windows and Linux are Ctrl+Cmd: Option with a letter types a character there.

**Tab Moves Focus** (`tandemMarkdown.toggleTabMovesFocus`, `tabFocus.ts`). Tab indents in the Rich editor, so without it the keyboard alone cannot leave the editor. Like VS Code's own mode for its text editor, it makes Tab and Shift+Tab move focus instead, in every panel of the window, until it is turned off. The host holds the mode and sends each live panel the panel command `setTabMovesFocus` with `{ on }`, also a panel that starts or reloads while it is on; panels start with it off and send nothing back. A status bar item shows while the mode is on and one of our panels is the active editor. CodeMirror binds the same keys (`Ctrl-m`, `Shift-Alt-m` on a Mac) to its own toggle, so they are in `KEYS_VSCODE_OWNS`: a toggle in one page alone would leave that page and the status bar item disagreeing.

After every await, look again. A flush, the gate or any other wait lets the user close the tab or move to another. Reading a disposed webview throws, so check `panel.disposed` first, and run a VS Code command that acts on "the active editor" (`undo`, `redo`, save, close, `reopenActiveEditorWith`) only while the panel is still `webviewPanel.active`; a save from a panel that is no longer active uses `document.save()` of its document instead.

A command that asks something asks through `questions.ts`: a modal question, a message with buttons, or a pick from a list. In the in-VS-Code suite the test hook answers them (`answerPrompts`), seeing each question's words and its buttons.

**Review in Source.** VS Code shows chat's bar for keeping or undoing its changes only in its own text editor. While chat has changes waiting in a note, its rich tab's title bar shows "Review in Source" (`tandemMarkdown.reviewInSource`), which runs Show Source. Its `when` clause reads VS Code's context key `chatEdits.hasEditorModifications`, which VS Code sets for each group's active editor, custom editors included, but does not document: if VS Code renames it, the button stops appearing and nothing else changes.

**Copy Relative Path with Line Numbers** (`copyLines.ts`, `model/lineReference.ts`), from a rich tab: chat and agent extensions read a text editor's selection, and a rich tab is not one, so this copies a pointer to the lines selected there, as `notes/Field notes.md:12-18`: the note's path from its workspace folder (its full path outside one), with forward slashes on every system, and the lines Source numbers, front matter included; the cursor's line when nothing is selected. The selection is the one the tab last reported, once its typing has reached the document. The message says what was copied, and asks for a save first when the note has unsaved changes.

### Links and images on the host

The index of linkable files (markdown, images, PDF, video and sound) is one per workspace folder, built on first use with `workspace.findFiles` and kept current by a watcher. Panels ask with `resolveLinks` and `listLinkTargets` and are told `linksChanged` when the index changes. Wikilink matching is `src/core/wikilinks.ts`, shared with the panel (see "Tables, links, images and front matter"); a target is resolved through `wikilinkResolver`, which reads a note's headings for Bear's `[[Note/Heading]]`.

Opening a link: `http`, `https` and `mailto` go to `env.openExternal`; a markdown file opens in our editor in the view the link was clicked in, at its `#heading`, or at an anchor written as HTML (`<a name>` or `<a id>`, `findNamedAnchor`) when no heading has that name, or, for a markdown link, at the line it names (`#L12`, `#12`, `#L12,5`, `#L12-L20`, read as VS Code's markdown extension reads them, `findLine`), with the cursor there in the Rich editor; `#heading` alone scrolls the panel; another file opens with VS Code's default editor; a folder is shown in the Explorer; anything else with a scheme is refused with a notice. A path starting with `/` is taken from the note's workspace folder. Links to network shares are refused.

The host reads a workspace file for a panel in two cases, both behind path checks:

- **A note's preview** (`previewNote`, for the hover card): only a markdown file inside a workspace folder, reached through no symbolic link or junction, of at most `NOTE_PREVIEW_MAX_BYTES`. A link to a block (`[[Note#^id]]`) previews that block. The card shows the note's title and the start of its text read as plain text block by block (`model/notePreviewText.ts`, by `plainText`'s rule).
- **An embedded note** (`embedNote`, for `embedNotes`): the same checks, within `EMBED_MAX_BYTES` (256 KB), a note open in an editor read with its unsaved edits; the answer is the part the embed names (`notePart`) or a sentence saying why there is none. `EmbedWatch` remembers which panels embed which notes and tells them `embedsChanged` when one changes on disk or in an editor.
- **An image** (`resolveImages`, which answers for a player's file too): a file that passes `isInsideFolder` for a workspace folder or the note's own folder, served through `asWebviewUri`; an `https:` address only while `tandemMarkdown.images.allowRemote` is on. A picture stored in the file is the panel's own and never asked about.

`isInsideFolder` normalizes both paths, ignores case on Windows, and refuses another drive, Windows device and long-path forms, and a name holding `:` (an alternate data stream).

### VS Code's features in the rich views

The rich views take part in what VS Code offers for a text editor, through the providers and the data other extensions give the document:

- **Problems and quick fixes** (`diagnostics.ts`, `model/diagnosticItems.ts`): every diagnostic VS Code holds for a panel's document goes to its panels, again whenever they change and to each panel that starts. A panel asks for the quick fixes of a range and has one applied: VS Code applies its edit and runs its command, and the panel sees an ordinary change.
- **Rename** (`rename.ts`): `prepareRename` and `rename` by whatever rename provider VS Code has for the document; the edit is applied by VS Code, to this document and any other, and the panel sees its own document's part as an ordinary change.
- **Suggestions** (`completions.ts`, `model/suggestions.ts`): where a link's address or a reference is being typed, VS Code's completion items for the place, read into what the panel shows.
- **Git change marks** (`changeMarks.ts`, `model/lineChanges.ts`): the lines that differ from the file at the last commit, worked out a moment after the document last changed, from the git extension's interface (`gitApi.ts`).
- **Git's conflicts** (`gitConflicts.ts`): whether git lists the note as in conflict, from the repositories' `mergeChanges`, sent to each live panel as `gitConflict` when the answer differs from what it holds (each init starts it at "not"). While it does, a conflict block's link reads "Resolve in Merge Editor", and its `openMergeEditor` runs git's own `git.openMergeEditor` for the note; otherwise the link switches the tab to Source.

**Places crossing** (`panelText.ts`, `src/panel/hostRanges.ts`). A panel's request names a place by an LF offset in its own text, with that text's stamp: the host has the panel send what is unsent, then goes ahead only if the document holds that text. What the host sends of its own accord (problems, change marks) is in the coordinator's text at its log version, which every panel carries over the changes it has seen since.

### Settings

`settings.ts` reads the `tandemMarkdown.*` settings, and `editor.tabSize` and `editor.insertSpaces`, for each panel's document (scope: the document's uri and the markdown language), into `PanelSettings`. They reach the panel in `init`, and again as `settings` whenever one changes. A new panel setting needs a field in `PanelSettings` (`src/core/protocol.ts`), a line in `readPanelSettings`, and its declaration in `package.json`, with `scope` and `order`. The optional syntax's settings need no line: the host sends the whole `tandemMarkdown.syntax` section, as VS Code gives it with the defaults filled in, keeping only true, false and strings, and the panel takes its own default for anything missing or not one of a setting's values. `PanelSettings.workspaceTrusted` is VS Code's workspace trust; the settings are sent again when the user grants it. The settings the host reads for itself (`tandemMarkdown.conflictFiles`, `changeMarks`, `scrollSync`) are read in the same scope (`markdownScope`). VS Code applies a `"[markdown]"` block of the settings to a read that names markdown's language even for a setting declared `resource`, not `language-overridable`, as all of the extension's are: measured in 1.120 and 1.146 by `itest/suite/factsLanguageOverride.test.ts`.

The extension sets one VS Code default for markdown files, in `configurationDefaults`: `files.saveConflictResolution` is `overwriteFileOnDisk`. VS Code's own prompt before saving over a newer file would come after the reconciler has already merged that file in.

### Notices and the log

The core raises 8 structured, prose-free `CoreNotice` variants (`src/core/reconcile/types.ts`). All English wording lives on the host side in `src/host/model/messageForms.ts` (single-sentence wording) and `src/host/model/conflictFile.ts` (conflict file rendering, status bar text, and agent instructions). `src/host/notices.ts` bridges every notice to `src/host/messages.ts` (one pop-up at a time through `model/messageQueue.ts`, a persistent tab-top strip for Undo/recovery notices, and diff title-bar choice buttons for conflicts), `src/host/conflictFiles.ts`, `src/host/backupViews.ts`, and status bar warnings. The log is a `LogOutputChannel` named Tandem Markdown; fault dumps go to the extension's log folder.

| Notice | Shown as |
|---|---|
| `conflict` | Pop-up ("See Diff", "Dismiss"); diff title-bar choice ("Use Change from Disk" for `clash`, "Replace My View" for `handoff`/`noBase`/`truncated`, none for `encoding`); `.conflict` file part and Problems warning |
| `truncatedFollow` | Quiet backup of previous text, `.conflict` file part, and Problems warning (no pop-up) |
| `applied` | Tab-top strip (and pop-up) with "Undo" (or "Put My Text Back" for `reloaded`), "See Diff", and "Dismiss" |
| `actionRejected` | Immediate short warning reply ("Nothing was changed because ...") |
| `closedWithPending` | Pop-up ("See Diff", "Dismiss") and `.conflict` file part |
| `readStatus` | Status bar warning ("Can't read Field notes.md") while `ok: false`; cleared when `ok: true` or note closes |
| `saveCheckOff` | Standing status bar warning ("No merge on save") and one pop-up ("Reload Window", "Dismiss") |
| `typingAtClose` | Tab-top strip (once reopened) and pop-up with "Put My Typing Back", "See Diff", and "Dismiss"; backup named to `backupViews` (or unsaved tab if backup failed) |

### Backups on the host

Every comparison opens one way (`backupViews.ts`, `model/backupViews.ts`): VS Code's diff, the backup on the left, which the diff editor keeps read-only, the person's text on the right, and a title naming both, the left side as the message names it: by the backup's kind, except a copy of the file on disk that a save step wrote the note over (`conflictVersionName`), named as the other program's version or the file as it was before VS Code's save, in its comparison and its row in the list, after a restart too (`VERSION_NAMES_KEY`). The backup's own label and name stay as they are, since older backups are known by them. A version the core could not back up opens at once in a new unsaved tab beside, and "See Diff" compares against that tab. "Compare with Backup" lists the backups of the note in the tab, newest first, each with what it holds and when it was written, and a "Copy path" button on each row. The backups button on the title bar of a note's tabs, Source and rich, shows while the note has a backup that a message or warning named (`showsButton`): every backup but one kept with nothing said, since no message told the person of it (`QUIET_KEY`), and those the person is done with. Opening a backup leaves the button where it is. The list ends, while the note's backups show the button, with "Done with these backups" (`DONE_ROW`), which marks them done, so the button goes until the note has another backup that shows it. Which backups the person is done with is kept in the extension's global state (`DONE_KEY`), so it lasts across a restart. Every window shares that state, and VS Code passes one window's write on to the others, so no window keeps a copy of these records (`DONE_KEY`, `QUIET_KEY`, `VERSION_NAMES_KEY`): each is read from the state where it is used, and changed only by the window's own additions and removals. A backup is found for its note by the tag in its name, a hash of the note's uri, so a rename VS Code reports renames the backups of each note under the renamed path (`renameBackups`). A note another program moves keeps its backups under the old tag, where Compare with Backup does not find them.

### Conflict files

What Tandem Markdown could not settle about an external change is written beside the note in `<note>.conflict` (`Field notes.md.conflict`, `todo.txt.conflict`) by `src/host/conflictFiles.ts` using one factual template in `src/host/model/conflictFile.ts`.

- `partForNotice()` maps `conflict`, `truncatedFollow`, and `closedWithPending` notices to one of three part shapes (`clash`, `handoff`, or `truncatedFollow`) plus zero-based line spots for the Problems panel.
- Every change to a note's parts updates the in-memory store immediately and writes the file atomically through a temporary file + rename (`writeWhole` in `src/host/localFiles.ts`, retrying brief Windows EPERM locks). A failed write retries on the next change or window focus.
- Nothing is written when `tandemMarkdown.conflictFiles` is off, outside a workspace folder, for a `.conflict` file itself, when the folder cannot be written, or when git explains the write (`gitExplains.ts`: file matches `HEAD` and `HEAD`'s commit timestamp precedes the write).
- Each open part produces a Warning diagnostic from `Tandem Markdown` linked directly to the `.conflict` file (`conflictViews.ts`), updates the status bar (`Tandem: N changes`, or the waiting strip message link), and is included by `Tandem Markdown: Copy Prompt for Agent`.
- Settling a conflict via "Use Change from Disk" or "Replace My View" removes its part and deletes the `.conflict` file when the last part settles (and pressing "Undo" on the resulting strip restores the settled part). Deleting the `.conflict` file on disk clears its parts and Problems warnings immediately and leaves the note untouched.
- The first time a conflict file stays open for `OFFER_AFTER_MS` in a workspace whose `AGENTS.md` and `.claude/rules/tandem-markdown.md` do not already hold the instructions, `agentInstructions.ts` queues the one-line offer (`Update AGENTS.md so your agent knows how to work with Tandem Markdown?`).

### The test hook

When the extension runs under the in-VS-Code suite (`ExtensionMode.Test`), `activate` returns the object in `testApi.ts`: read a panel's state, run actions in a panel (`insert`, `replace`, `select`, `command`, `setMode`, `flush`, and `corrupt`, which changes the panel's text without telling the host), hold a document's gate as a save does, read the coordinator's state, the notices and the log, load another panel script, set the window's focus as the hold sees it, answer every question a command asks (`answerPrompts`, through `questions.ts`) and press a notice's buttons (`answerNotice`), read what the status bar, the outline, scroll sync and the places kept show, forget every place kept (`forgetPlaces`, which the suite's `closeEverything` calls so each test opens each note as if new), and ask what a link's hover card would show (`previewNote`, the function that answers the panel's request), what VS Code suggests at a place (`completions`, likewise), what an embed shows (`embedNote`) and what the host answers a panel's request (`request`). Besides what five commands resolve with, it is the suite's only way into the extension: the extension registers no command for tests. Verify File, Use Tandem Markdown by Default, Use Source by Default, Add Agent Instructions and Compare with Backup resolve with what they did (`VerifyResult` in `verify.ts`, `DefaultsResult` in `defaults.ts`, `AddResult` in `agentInstructions.ts`, `CompareWithBackupResult` in `backupViews.ts`), and the suite reads that through `executeCommand`, importing those types. They resolve so in every mode, which is all this adds to what ships, and each result is made from the values the command showed and wrote, so what the suite reads is what the user was shown. A feature the suite reads hands the hook a reader with `exposeSnapshot`, in test mode only; `testSnapshots.ts` holds the readers alone, so such a feature does not import the hook, which imports features. The editor's test-only state (the panel script to load, what failed pages reported) is one object, `testHooks` in `provider.ts`, present only in test mode.

The hook reaches a panel with a `test` message, which the panel answers with `testResult` (see "The panel", "Boot"); the failure page's guard answers too. In test mode every `init` carries `testMode: true`, and only a panel that was told so answers. Outside test mode none of this is reachable: nothing sends a `test` message, and no panel would answer one.

## The panel

The panel (`src/panel`) is the page inside the editor tab: one CodeMirror 6 editor over the document's LF text.

| File or folder | Holds |
|---|---|
| `main.ts` | The entry point: wraps `acquireVsCodeApi()` and loads `boot.ts` with a dynamic import, so a module that throws while it loads shows the failure page instead of an empty tab |
| `vscodeBridge.ts` | The `HostBridge` over VS Code's webview API, which passes on only the messages VS Code's host page sends (see "Messages") |
| `boot.ts` | The page skeleton, each `init` and resync, the routing of host messages in the order they arrive, and Verify File's stamp answers |
| `failurePage.ts` | The page shown when the panel cannot start; it imports nothing, so `main.ts` can draw it when `boot.ts` did not load |
| `contact.ts` | The lost-contact warning (`ContactWatch`) |
| `reports.ts` | Focus and view-state reports to the host, and sending what is unsent when the user is about to act outside the page (`PanelReports`) |
| `scrollFollow.ts` | Scroll sync in a rich view: its place, putting a place at its top, and telling the user's scrolls from its own (`ScrollFollow`) |
| `testHook.ts` | The answers to the host's test hook, created only when the `init` says test mode |
| `corruption.ts` | The fault the test hook's `corrupt`, the harness's "Corrupt panel" and the simulation's panels make: the text under the panel's unconfirmed edits goes wrong without the sync layer knowing |
| `sync.ts` | `PanelSync` (see "Sync between panel and host") |
| `outsideChanges.ts` | The updates a transaction applies from the host, as the panel reads them: whether each came from outside (reason `outside` or `merge`), the log version it brings the panel to, and where a position in the host's text now stands in the panel's, for the outline on changed lines and for what a screen reader is told |
| `announce/` | What a screen reader is told of changes from outside: what is gathered (`news.ts`, `landed.ts`), where it is (`places.ts`), the words (`words.ts`) and when (`index.ts`) (see "What a screen reader is told") |
| `editor.ts` | `createEditorState`, `createEditorView`: the base extensions, then every feature; the content element's accessible name |
| `innerStates.ts` | `innerState`: the editor state a drawing makes to draw from with the features (a grid table's cell, an embedded note), made by `editor.ts` through the state the drawing is in, so no feature imports the editor |
| `context.ts` | `PanelContext`: what a feature may use to reach the host, the page and the settings |
| `modes.ts` | Rich view and Rich editor, held in the state |
| `features.ts` | The `Feature` type and the ordered list of features |
| `focus.ts`, `notices.ts` | What has focus in the page; the notice strip |
| `hostAnswers.ts` | Asking the host in batches, caching, asking again when files change (images, wikilinks) |
| `hostRanges.ts` | Ranges the host sends in its own text at a log version, placed in the panel's text (see "VS Code's features in the rich views") |
| `onDemand.ts` | `onDemand`: a module loaded by a dynamic import on first use, so it stays out of the bundle the panel starts with (the paste converter, the copy renderer, the YAML parser, KaTeX, the emoji list, the HTML door, the diagram frame's code) |
| `assets.ts` | The panel's own files beside its bundle (KaTeX's stylesheet and fonts, the diagram frame's code), found from the page's `tm-assets` |
| `syntax/` | The optional syntax: one entry per syntax beyond CommonMark and GFM, with its setting, its parser extensions and its drawing, in one file per family (`foundation.ts`, `html.ts`, `drawn.ts`, `inline.ts`, `boxes.ts`), joined by `index.ts` (see "Optional syntax") |
| `markdown/` | The parser and our syntax extensions; `nodes.ts` names the node sets features share |
| `html/` | HTML from a file: `door.ts`, the one way it reaches the page, `renameInline.ts`, which keeps parsing it from tripping the page's policy, `elements.ts`, which names are HTML and which a file may use, `blocks.ts`, reading an HTML block's tags without a DOM, `links.ts`, the addresses a link may have and the `<a href>` links in a line, `storedPicture.ts`, pictures stored in the file, and `load.ts`, the door loaded on demand (see "HTML through one door") |
| `render/` | The render framework and one drawing feature per file; `layout.ts` holds what several features share about where text sits; `inlineDom.ts` makes an inline drawing into DOM; `layers.ts` holds what the features drawn in a layer beside the text share; `frame/` is the code that runs in the diagram frame (see "Diagrams") |
| `tables/` | Tables: the feature (`tables.ts`), reading a table from the tree (`model.ts`), the widget and its grid (`widget.ts`, `grid.ts`), the cell field (`cellEdit.ts`), the structure bar (`bar.ts`), structure edits (`edits.ts`), the table commands (`commands.ts`) |
| `links/read.ts` | Reading links from the syntax tree, for drawing, tables and the hover cards |
| `links/footnotes.ts` | The file's footnotes: their numbers, kept in step with edits, and following one |
| `links/farDefinitions.ts` | Link and footnote definitions past the stored parse, read from the blocks alone |
| `commands/` | Editing commands (`base.ts`: what every command shares; `lineInfo.ts`: a line's list and quote marks; `inline.ts`, `blocks.ts`, `lists.ts`), the typing rules (`typing.ts`), the command registry (`registry.ts`), where a new block goes (`placeBlock.ts`) |
| `paste/` | Paste, drop, copy and cut, in nine files: the feature and its event handlers (`index.ts`), which rule applies (`choose.ts`), what each rule writes (`changes.ts`), reading clipboard HTML without a DOM (`classifyHtml.ts`), HTML to markdown with turndown (`htmlToMarkdown.ts`), markdown to HTML for a copy (`markdownToHtml.ts`), copy and cut (`copy.ts`), pasted and dropped images (`images.ts`), and pastes whose text comes later (`held.ts`) |
| `ui/` | The toolbar, find and replace, the hover cards, a problem's card and its quick fixes (`problemCard.ts`), the rename box (`rename.ts`), Rich view from the keyboard, `revealHeading`, key names and key matching (`keys.ts`), Tab Moves Focus (`tabFocus.ts`), DOM helpers (`dom.ts`) |
| `complete/` | Wikilink completion, and VS Code's suggestions in the same list (`vscode.ts`) |
| `theme/` | `panel.css`, the syntax colors, reading colors and their contrast (`contrast.ts`), and when VS Code changes the page's theme (`themeChanges.ts`) |
| `types/` | Type declarations for a package that ships none (`@joplin/turndown-plugin-gfm`) |

### Boot

For each `init`, `PanelSync.start(init)` gives an extension; the boot code builds a fresh editor state with it, puts the state in the view, and calls `sync.bind(view)`. The first `init` creates the view. Every later one is a resync: a fresh state at the new version, the selection carried across with `diffChanges(oldText, newText)`, the scroll position kept. The page pushes unsent typing whenever the user is about to act outside it (see "Pushing"), and reports focus and view state (debounced by `VIEW_STATE_DEBOUNCE_MS`) to the host (`reports.ts`). Lines in a view state are zero-based, as VS Code counts them.

An `init` that fails its checks, or a first `init` that throws while the editor is built, shows the failure page (`failurePage.ts`) and tells the host `startFailed`. When the panel's code does not load at all, `main.ts` draws the same page.

The first `init` with `testMode: true` creates the test hook (`testHook.ts`). `boot.ts` routes each `test` message to it in turn with every other message, so a test action sees every host message that came before it. The hook runs the actions and answers `testResult` with the panel's state, the lines outlined as changed from outside, the drawn widgets and the content-policy violations the page recorded; after a failure it answers for the failure page and can press its button. A panel whose `init` did not say test mode has no hook, and `main.ts`'s failure page, which never receives an `init`, never answers one.

### The editor state

CodeMirror 6 with: `@codemirror/collab` (through `PanelSync`); the markdown language (`@codemirror/lang-markdown` over `@lezer/markdown` with GFM, plus front matter and the optional syntax that is on); code-block languages from `@codemirror/language-data`, loaded when a block first names one; the render framework; the features; CodeMirror's default keymap less the keys VS Code's keybindings use. There is no history extension. The language sits in a compartment: when the optional syntax changes, the editor gets a new parser and parses the document again, without reloading the view or touching the document.

### Modes

Rich view: `EditorState.readOnly` and not editable; no cursor; every mark hidden; a plain click opens a link; checkboxes can still be checked, unless the document is read-only. The content element keeps `tabindex="0"` so the keyboard can scroll it and the find keys reach it, and Tab moves between links and checkboxes (`ui/viewKeys.ts`). Rich editor: editable; marks reveal by the reveal rule; Ctrl+click (Cmd+click on a Mac) opens a link. Changing mode is one dispatch of `setModeEffect`.

### Features and their order

A `Feature` is `{ id; extension?(ctx); commands? }`: an id, what it adds to each editor state, and the panel commands it provides, by id. A feature may have either or both: most drawing features have only an extension; the inline, block, list and table commands, `revealHeading` and Tab Moves Focus have only commands; links, find, paste, a problem's card and the rename box have both. `features.ts` lists them in precedence order: where two features' decorations meet, the earlier one's are drawn inside the later one's, and an earlier replacement wins. The list holds the drawing features (frontmatter, HTML blocks, tables, grid tables, headings, heading attributes, footnotes, math, diagrams, contents lists, embedded notes, block ids, tags, emoji, emphasis, images, links, wikilinks, styled spans, tracked changes, abbreviations, lists, definition lists, callouts, boxes, quotes, code, rules, HTML, comments, spacing, the outline on lines changed from outside and, beside it, what a screen reader is told of those changes, the problems VS Code reports, the git change marks), the others (the hover cards, a problem's card, wikilink completion, Rich view's keys, find, the rename box, paste, typing, the toolbar) and the features that only provide commands. To add one: export a `Feature` from its own file, import it in `features.ts` and add it to the list.

`editor.ts` builds every editor state from the list: each feature's extension, and its commands through the `panelCommands` facet (`commands/registry.ts`). A feature that throws while it is set up, or that provides a command id another feature already provides, is reported as a fault and left out; the rest of the editor keeps working.

### Commands, notices and requests

- **Commands**: a panel command is a function `(view, args?) => boolean`, provided by a feature in `Feature.commands` and found by id in the `panelCommands` facet (`commands/registry.ts`). Nothing registers a command by being imported. The ids are the host's command ids without the `tandemMarkdown.` prefix (`toggleBold`, `insertTable`). The host's `command` message and the toolbar both run commands through `runCommand`, so a command is written once.
- **Key names**: the panel shows a key the way VS Code shows it on the platform it runs on, `Ctrl+B` off a Mac and `⌘B` on one, through `keyName` (`ui/keys.ts`), from `COMMAND_KEYS`, a copy of the bindings `package.json` declares that a unit test holds to them. The find box matches its own keys with `keyMatches`, so on a Mac Option with a letter types its character there, as in VS Code's own find box.
- **Accessible names**: the editor's content element is named for the view and the file, "Rich editor, notes.md" or "Rich view, notes.md".
- **Notices**: `ctx.notify({ kind, text, actions?, sticky? })`. A notice that is not sticky leaves after `LIFETIME_MS`; one with the same kind and text as one showing is not added again. Text is plain and short: what happened and what to do.
- **Host requests**: `ctx.request({ type, ... })` adds a `requestId` and resolves with the reply's result; it rejects on an error or after `REQUEST_TIMEOUT_MS` (a second argument changes the wait, or removes it for a file dialog).
- **Focus**: `focus.ts` is the one test of what has focus, used for the context keys and by the toolbar, which turns its formatting buttons off while a text field has focus.
- **Settings**: `ctx.settings` is always current, and `ctx.onSettingsChange(fn)` returns its unsubscribe. The width, the font size and the font family reach the stylesheet as `--tm-content-width`, `--tm-font-size` and `--tm-font-family` on the root element.

## Drawing

The render framework is `src/panel/render/framework.ts`: the reveal questions, the two ways to contribute decorations, the one widget base class, and the fault guard around all of them, which records and reports a fault through `render/faults.ts`; the line table and block index it draws from are `render/lines.ts`, and what an edit damages is `render/damage.ts`. The features in `render/` and `tables/` draw through it; `render/outsideMark.ts` keeps its own state field, because it draws from the updates a transaction carries rather than from the syntax tree, and so do `render/diagnostics.ts` and `render/changeMarks.ts`, which draw what the host sends (see "VS Code's features in the rich views").

The outside-change mark outlines the lines an update from outside changed, each until it has been in the panel's view, and then fades over `FADE_STEPS` steps, at once where the person asks for reduced motion. A tab kept behind another tab, or in a hidden group, is out of the panel's view too: VS Code hides it with a style on its own page, which the panel cannot see, so the host tells the page when its tab is shown and when it is not (`tabShown`, from `WebviewPanel.visible` on each change of the webview's view state, and after each init while the tab is not shown), and a mark there waits until the tab is shown. A marked line that no line of its own draws is outlined through what stands for it on screen (`standIns`): a block drawn in place of its lines is outlined whole (front matter drawn as a table, a diagram, a math block, an embedded note, git's conflict markers, a `<details>` block's summary, a table whose delimiter row changed), and a line folded away through the line or block its run of hidden lines follows (a folded callout's head, a folded `<details>` block's summary). Hidden lines that follow a blank line begin a block that shows nothing, such as an HTML comment in Rich view, and nothing is outlined for them. The lines carry a line decoration, which table rows carry as a `MarkSource`; the outline is drawn in a layer above the text, around each run of marked lines or table rows, or the block or line that stands for them, its sides in the margin beside the text column and its top and bottom on the line boundaries, so it lays nothing under any text and every kind of text keeps the contrast it has. Its color comes from the theme's, read when the panel starts and whenever VS Code changes the theme (`markColor`, over `theme/contrast.ts`): the theme's inserted-text border or its inserted-line color, darkened or lightened until it stands out from the page by `MARK_FLOOR` (4.5:1). A closed outline around the line is plain to tell from the git change marks, a bar in the margin further out (`render/changeMarks.ts`).

### The reveal rule

In Rich editor, a node's marks show when a selection range touches the node, inside it or at either edge. Touching a child reveals the child only. Line marks (`#`, a rule's dashes) show when the cursor is on that line; a code block's two fence lines show while the cursor is anywhere in the block. A table or front matter block shows its source while the selection is inside it. In Rich view nothing reveals. While a mouse button is down the reveal state is frozen, and for `REVEAL_RELEASE_DELAY_MS` after, so a line does not shift under the pointer and turn a click into a drag, and a double click lands on the same layout.

Ask reveal questions through the draw context `d`, never directly: a block feature records each answer and draws again, over just that block, only when an answer flips. Every answer is false in Rich view.

| Ask | For | True when a selection range touches |
|---|---|---|
| `d.revealed(from, to, inner?)` | an inline node's marks | the node, edges included; a range inside one of `inner` (children that show their own marks) reveals that child only |
| `d.lineRevealed(pos)` | a line mark | the line holding `pos` |
| `d.blockRevealed(from, to)` | a block that turns to source | any line of the block |

### Inline features

An inline feature is a view plugin over the visible lines: marks, hidden ranges and inline widgets within one line. It draws again on every change of document, viewport, selection, mode or tree, over `[d.from, d.to]`, so keep it cheap: walk with `d.iterate` and return `false` for nodes whose inside you do not need. Example, autolinks with their angle brackets hidden unless the cursor touches them:

```ts
import { EditorView } from '@codemirror/view';
import type { Feature } from '../features';
import { inlineFeature } from './framework';

export const autolinks: Feature = {
  id: 'autolinks',
  extension: () => [
    inlineFeature('autolinks', (d) => {
      d.iterate((node) => {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false; // skip children
        if (node.name !== 'Autolink') return true;
        d.mark(node.from, node.to, 'tm-autolink');
        const revealed = d.revealed(node.from, node.to);
        for (let m = node.node.firstChild; m; m = m.nextSibling) {
          if (m.name !== 'LinkMark') continue;
          if (revealed) d.mark(m.from, m.to, 'tm-mark'); // shown, faded
          else d.hide(m.from, m.to); // hidden; the cursor steps over it
        }
        return false;
      });
    }),
    EditorView.baseTheme({ '& .cm-content .tm-autolink': { color: 'var(--tm-link)' } }),
  ],
};
```

**Outside the lines.** Some inline content is shown somewhere other than its own line: a table's cells, which the table widget draws in place of the table's lines, a grid table's cells, a task's name for its checkbox, a note's text in the hover card. The same builds draw it. `inlineDrawing(state, owner, nodes, base)` runs every inline feature whose syntax is on over the given nodes (a table's rows, a `Paragraph`), with nothing revealed, and gives one decoration set per feature, in the features' order; `inlineDom` (`render/inlineDom.ts`) makes the sets into DOM as CodeMirror makes a line (marks nested by precedence, a replaced range drawn as its widget or left out), each text node recording where its characters come from in the source, and `inlineText` reads them as plain text, each widget as its `plainText`. So a syntax added as an inline feature is drawn in a cell with nothing more. What holds only inside a cell belongs to the feature it concerns, read from the tree: in a cell `\|` is a pipe even in code and a picture's alt text (`inTableCell` in `markdown/nodes.ts`), and a list written as HTML is a list. A cell's holder says where in the document its text starts (`setDrawingStart`), so `posOf` and `drawnSpan` find the source of anything drawn in it: Rich view's Tab stops on a cell's links, and the hover cards open over them at the character under the pointer (`hoverPlace` and `drawnCard` in `ui/linkCard.ts`).

A grid table's cell holds markdown of its own, paragraphs and lists, so it is drawn by an editor state of its own (`innerState`) that holds that part of the file (`filePart`): what its inline features read beyond the text (link definitions, footnote numbers, abbreviations) is the file's, each character's origin is its place in the file, read line by line, since each line of a cell is a stretch of a file line (`tables/gridCells.ts`), and `linkAt` and `tagAt` find a link or a tag at a place in a grid table in its cell's markdown, where Rich view's Tab finds its stops too (`gridStops` in `ui/viewKeys.ts`). The footnote index keeps the references in a grid table's cells where they stand in the file, and numbers them in the order Pandoc reads the table: row by row, cell by cell. What a feature marks on a line from state of its own, not from the tree (a find match, a problem's underline, the mark of a line another program changed), it also gives as a `MarkSource` (`markSources`): a table draws those marks into each row's cells with the row's inline drawing, and a class on the line on each of the row's cells, and a grid table does the same for each cell's lines. Such content never reveals, so a mark whose spec names a class as `whenHidden` (find's current match) and whose text the drawing hides, as a link's address, marks the visible text nearest it with that class instead (`nearestVisible` in `render/inlineDom.ts`), as find does in Rich view's lines. A block build asks for them with `d.marks(from, to)`, which notes them over the range, so a change to them (a cursor move while find is open, a step of the mark's fade) draws again only the tables whose marks changed.

A line is drawn again on every change, so a build may read anything in the state. Content drawn outside the lines is drawn again only when something says so. `inlineKey(state)` changes whenever it may draw differently with the same text: the settings, the mode, the size limit, a feature's fault, a redraw asked for an inline feature or for a feature that shows inline content (the host's answers arrived, a module loaded), and what each inline feature with no `placed` option declares, in its `reads` option, that its build reads beyond the text it draws (`definitionsKey` for links and pictures, the abbreviations). A feature that reads something of where a node stands gives it as a key for the node in its `placed` option, which then holds everything the build reads for that node: the footnotes give the numbers of the notes a node refers to, and their `reads` (the order of the notes) only says when to look at those keys again. `placeKey(state, node)` joins the features' keys, and a block build asks for it through `d.placeKey(node)`, which notes the answer over the node. A block feature that shows inline content passes `inline: true`. While it has drawn anything, it is drawn whole again when `inlineKey` changes; when only what the `placed` features read changes, which a long note's growing parse does at every step, it draws again only the nodes whose key is no longer the one noted. A table keeps each row by its line's text, its `placeKey` and `inlineKey`, and a task's name is kept the same way, read only when its box is drawn (so a list drawn whole, as when a long stretch is parsed at once, reads only the names on screen), so a change draws again only the rows it touched, and a row drawn again that draws as before is kept with its DOM. An inline feature that reads something new beyond its text names it in `reads`, and in its node's key when it has `placed`, or content outside the lines keeps the old drawing.

### Block features

A block feature is a state field over the whole document: line classes, hidden whole lines, block widgets, anything that changes a line's height. Whole lines are hidden or replaced with block replace decorations, never with CSS that sets a height to zero. Example, a block shown as a widget until the cursor enters it:

```ts
import type { EditorView } from '@codemirror/view';
import type { Feature } from '../features';
import { blockFeature, RichWidget } from './framework';

class Box extends RichWidget {
  constructor(source: string, readonly title: string) {
    super(source);
  }
  override sameAs(other: Box): boolean {
    return other.title === this.title;
  }
  draw(view: EditorView): HTMLElement {
    const box = view.dom.ownerDocument.createElement('div');
    box.className = 'tm-box';
    box.textContent = this.title; // never innerHTML
    return box;
  }
}

export const boxes: Feature = {
  id: 'boxes',
  extension: () =>
    blockFeature('boxes', (d) => {
      d.blocks((block) => {
        if (block.name !== 'Table' || d.blockRevealed(block.from, block.to)) return;
        d.replaceLines(block.from, block.to, new Box(d.doc.sliceString(block.from, block.to), 'Table'));
      });
    }),
};
```

**The partial-redraw rule.** After an edit, a block feature draws again only over the top-level blocks that changed, plus one neighbor on each side; the rest of what it drew is kept. So what you draw for a block may depend on that block, the blocks holding it and its neighbors, never on anything further away. Draw only for the blocks `d.blocks()` gives you; a decoration may run into the blank lines just after its block, no further. A change of mode, of the size limit or of the settings draws everything again. `test/panel/render/incremental.test.ts` checks that partial and full drawing agree over random edits; extend its starting text with any new syntax.

When what a feature draws depends on something outside its blocks, it dispatches `redrawFeatureEffect.of(id)` when that thing changes, and that feature alone draws the whole document again. Wikilinks do this when the host's answers about which targets exist arrive, for themselves, the front matter and the contents lists; what shows inline content outside the lines follows such a redraw of an inline feature by itself (see "Inline features"). Never dispatch it from inside an update.

When the drawing of top-level blocks depends on each other within one document, as an HTML wrapper's lines depend on its two tag lines, the feature names those runs in `blockFeature`'s `linked` option: a pure function of the state giving them as a `RangeSet` of `LinkedRun`, each run's range its extent and its key what else decides its drawing, mapped through each change while the runs stay what they are so that `RangeSet.compare` finds nothing to do. When a run appears, disappears, changes its extent or its key, or a reveal answer asked inside it flips, the feature draws the whole run again; an edit inside a run that changes none of these draws only what it touched, so the build must find what holds a block (the HTML block feature keeps the top-level tag blocks and wrappers in range sets in a state field for this).

### The draw context

`d.state`, `d.doc`, `d.tree` (as far as parsed), `d.mode`, `d.ctx`, `d.from`, `d.to`, and two tables built once per change: `d.lines` (line starts and texts) and, in block features, `d.blocks(fn)` (each block with its node, range, first and last line, and list and quote depth). Use them in loops: `doc.line(n)` and one-character `sliceString` calls over thousands of lines cost milliseconds per keystroke.

To draw: `mark(from, to, class, attrs?, tagName?)`, `hide(from, to)`, `replace(from, to, widget)`, `widget(pos, widget, side?)`; in block features also `line(pos, class, attrs?)`, `hideLines(from, to)`, `replaceLines(from, to, widget)` and `blockWidget(pos, widget, side)`. Hidden and replaced ranges are atomic: the cursor steps over them. A selection landing inside a replaced block (a click, find, undo) reveals it. Add in any order; the framework sorts. `d.drawWhenLoaded(module)` asks for a library a build met (see "Libraries loaded on demand").

### Widgets

Extend `RichWidget` and implement `draw(view)`; optionally `redraw(dom, view)` to update in place, `sameAs(other)` to compare the fields that change the drawing, `ignores(event)`, and `plainText`, what an inline widget reads as where no drawing is shown (its source by default; an emoji's character, a picture's alt text). Never override `toDOM`, `updateDOM`, `eq` or `ignoreEvent`: those are the guarded wrappers. `source` is the document text the widget stands for, shown in its place if `draw` throws. `editable` is taken: CodeMirror reads a widget's `editable` (it is not in its published typings) and, when it is true, leaves the widget's element editable by the browser instead of marking it `contenteditable="false"`, so a drawing could be typed into. `RichWidget` declares it false, which makes the compiler refuse a field of that name in a subclass. "No drawing can be typed into" in `harness/tests/syntax.spec.mjs` checks one drawing of every widget class and every kind of drawn block, by its class: a new one gets its line there.

- Build DOM with `createElement` and `textContent`. Never assign `innerHTML` (lint forbids it in `src/panel`), and never set a `style` attribute: set `element.style` or use a class. The page runs under a strict content policy, and text from a document or the clipboard can be anything.
- Block widgets have no vertical margins (CodeMirror cannot measure them); use padding. If a widget's height changes after drawing (an image loading), call `view.requestMeasure()`.
- A widget inside a line must stay inline (`inline`, `inline-flex`, `inline-block`). One whose drawing can reach past its own box, as a formula's does, must not scroll or clip (`overflow` other than `visible`), or it shows scroll bars or cuts the drawing off.
- Do not store document positions in a widget; find yours at event time with `view.posAtDOM(dom)`.
- Buttons in a widget cancel `mousedown` (which keeps focus and the selection) and act on `click`.

### Drawn blocks

Some blocks are shown as a drawing that looks nothing like their source: a math block, a block of HTML, a `<details>` summary, a grid table, a diagram, a contents list, an embedded note, a conflict git left. They behave one way, built once in `render/drawnBlock.ts`: a block feature finds each one and calls `drawBlock(d, block, kind, text, fences)`, and a `DrawnKind` says how that kind is drawn (`draw(text, view)`, which never throws), the library that draws it (`library`, an `onDemand` module), its name for a screen reader, its pencil's two labels (`editLabel`, `doneLabel`), its size limit, the height to keep for a drawing not yet made, and a class for its frame's own spacing (`frameClass`). A drawing that holds something (a watch of the host's answers for its pictures, an embedded note's editor) returns it as `dispose`, called once another drawing replaces it or it leaves the page. A drawing's own buttons (a diagram's "Open the diagram large") are its `controls`, shown at the frame's corner under the pencil while it is the drawing in place, and not beside a mistake. `text` is everything the drawing is made from, so a drawing that depends on more than its block's source (a contents list's headings, an embed's note) puts that in it too; what it reads that the text cannot hold (the state its build saw, for a grid table's cells) goes beside it as `given`, with a key of it in the text, so that drawings of one text are alike. `stepOntoKeys(accepts)` gives Up and Down that step onto the lines any widget `accepts` stands for, as the drawn blocks' keys do; the HTML block feature uses it for tag lines that are hidden until the cursor is on them.

- **Closed**, the drawing stands in place of the block's lines (`replaceLines`), in a frame with `role="group"` named for its kind. A click on it leaves the cursor where it is (the widget ignores the editor's events; clicks inside keep their own meaning). In Rich editor a pencil at its corner opens it. A drawing wider than the page scrolls sideways inside the frame's body, so the pencil stays at the corner. While a drawing is made the frame is `aria-busy`, `tm-drawn-waiting` while it has nothing to show yet; after a mistake it is `tm-drawn-failed`.
- **Open**: the pencil, or the cursor moved into the block, opens it. CodeMirror's own Up and Down step over a widget that stands for whole lines, so `drawnBlockKeys` puts the cursor at the drawing's edge instead, past any folded lines in between, which reveals the block. The source shows as code lines (`tm-code-line`, the delimiters faded) and the drawing stays directly beneath it (a block widget after the last line). The open drawing keeps its element while the source is typed in: CodeMirror hands each new text to `redraw`, which draws again `DRAW_PAUSE_MS` after the typing stops, never on the keystroke. A mistake shows its message under the last good drawing. Rich view has no pencil and never opens a block.
- **Closing**: the block closes when the cursor leaves it, with Up or Down or by one of three ways out: the pencil, which while the block is open is a check mark named by `doneLabel` ("Done editing the math"); Escape, once the base keymap's Escape has reduced several ranges or a selected range to a cursor (`drawnBlockKeys` binds it below that keymap and below the find box's); and a click on the drawing beneath the source, unless it lands on a link or control inside the drawing. The three ways out put the cursor at the start of the line after the block, or, when the block ends the document, at the end of the line before it, and scroll only as far as keeps the cursor in the window, which for a block in view is not at all: the block's top stays where it is and what follows moves up by the source's height, as when the cursor leaves with Down. A block that is the whole document cannot be closed, so it has no pencil while open. The open block is found from the cursor (`openBlockAt`): the innermost block node around the cursor's line whose last line has the open drawing beneath it.
- **The page does not jump**: a drawing is made from a cache by its text (the library's own, for KaTeX), so the closed and the open drawing of one text have one height; a drawing not yet made keeps the height its text was last drawn at, or the kind's estimate, which is also what CodeMirror's height map is told (`estimatedHeight`). Walking the cursor through a block with Up and Down moves its line at most one line a key, and closing a block in the middle of the window by each way out moves the cursor's line at most one line, scrolls nothing and scores under 0.1 for layout shift, every shift counted (`harness/tests/syntax.spec.mjs`).
- **Limits against a hang**: a block longer than its kind's `limit` shows as code with a "Draw anyway" button; while a drawing is made its key is kept in the page's session storage (`SESSION_MARK`), so a page that went away mid-drawing finds the mark when it starts again and holds that block back the same way. The buttons are reached with Tab in Rich view (`tm-stop`, `ui/viewKeys.ts`).
- CodeMirror makes widgets only near the window, so a drawing is made only there.

Front matter keeps its own widget: its three display settings and its bar for hidden front matter do not fit the drawn block, and its table is made at once from the YAML, with no library to wait for or to guard against. It opens by the same reveal rule.

### Faults and the size limit

Every build runs inside a guard, and so do the widget methods. A throw turns that feature off for this panel: its text shows as plain markdown, the error is logged once, and a notice offers "Reload view". The editor keeps working. Over `tandemMarkdown.maxRichFileSizeKb` every feature draws nothing and a notice says so. For files under `BACKGROUND_PARSE_LIMIT`, parsing is finished in idle time, so block features further down the file are drawn without scrolling there first.

### Line heights

CodeMirror estimates the height of every line it has not drawn from one sample: the first short line in view that holds nothing but plain text (`measureTextSize` in `@codemirror/view` 6.43). When the sample's height moves by more than 0.3 px, it drops every measured height in the document and estimates them all again. Lines here are drawn at many heights (code, a code block's padded first line, a table's source, a line with a gap above it), so the sample would follow whatever is in view, and in a long document the page would grow or shrink by thousands of pixels as the cursor moved, for instance into and out of a long code block. So the framework puts every drawn line's text in one mark (`unsampledLines` in `render/framework.ts`, class `tm-line-text`): no line is ever the sample, and CodeMirror measures a line of body text of its own, which keeps one height. `render.spec.mjs` walks the cursor through a long code block and checks that it moves one line a key.

### Where styles live

`theme/panel.css` holds the tokens (`--tm-*`), the page skeleton and the line classes features share. A widget's or a control's own styles live beside the code that builds it, through `EditorView.baseTheme` with selectors prefixed `& .cm-content` so they outrank CodeMirror's own; class names start with `tm-`. The toolbar sits outside the editor element, so its styles go in through a global `StyleModule` mounted with the page's nonce. Colors come from VS Code's theme variables; measurements follow GitHub's markdown stylesheet.

Indent and gaps are CSS variables on each line (`--tm-ld` for list depth, `--tm-qd` and `--tm-qx` for quotes, `--tm-xpad` for a block's own padding, giving `--tm-indent`). The gap above a line is a transparent top border, so a line's background must use `background-clip: padding-box`. The selection is drawn behind the text, so line backgrounds must be translucent.

### Our syntax nodes

| Construct | Nodes |
|---|---|
| Front matter | `Frontmatter`, a top-level block from the file's start to the end of the closing line, with two `FrontmatterMark` children (none for a bare JSON object); its first line says its form (`frontmatterForm`) |
| Wikilink | `Wikilink`, or `Embed` with `!`; children `WikilinkMark`, `WikilinkTarget` (heading included) and `WikilinkAlias` (left out when empty), the target before the bar or after it as the setting says. Read a link with `wikilinkOf` (`links/read.ts`), not from its text |
| Highlight | `Highlight` with two `HighlightMark` (each a run of exactly two `=`) |
| Footnote | `FootnoteRef` (`[^id]`); `FootnoteDef`, a container block whose first child is `FootnoteLabel`; `InlineFootnote` (`^[text]`) holding an `InlineFootnoteMark` at either end and its inline content |
| One tilde | GFM's `Strikethrough` and `StrikethroughMark` for `~text~`; `Subscript` and `Superscript`, each holding two marks (`SubscriptMark`, `SuperscriptMark`) and an `Escape` for each escape inside: `markdown/tilde.ts`'s under `both`, @lezer/markdown's under `subscript` (see "One tilde") |
| Comment | `PercentComment` (`%%text%%` in a paragraph) and `PercentCommentBlock`, a top-level block, each holding a `PercentCommentMark` at either end (one only, for a block never closed) |
| Task with another mark | `MarkedTask`, a list item's first paragraph, holding `MarkedTaskMarker` (`[?]`) and its inline content |
| Tag | `Tag` (`#name`) holding `TagMark` (the `#`) |
| Emoji code | `EmojiCode` (`:name:`, any name of its shape; only names on GitHub's list are drawn) holding two `EmojiMark` |
| Math | `InlineMath` (`$…$`, and GitHub's `` $`…`$ ``) and `DisplayMath` (`$$…$$`), each holding a `MathMark` at either end and the `MathText` between. A paragraph that is one `DisplayMath` is a math block; a ```` ```math ```` block is a `FencedCode` the math feature reads. LaTeX's delimiters (`\(…\)`, `\[…\]`) give the same nodes; an environment (`\begin{align}`…) is a `DisplayMath` holding only its `MathText` |
| Picture sizes | `ImageAttributes` (Pandoc's braces) and `LogseqImageAttributes`, right after an `Image`; Azure's `![alt](pic.png =500x250)` as an `Image` whose `ImageSize` child holds ` =500x250` |
| Box | `Box`, a container block (`:::`, `!!!`, `???`, `===`, `>>>`); on its first line a `BoxMark`, a `BoxName` or `Attributes`, and a `BoxTitle` with inline content, between two `BoxMark`s when bracketed or quoted; a fenced box's closing line is a `BoxMark`. `::: mermaid` is a `FencedCode` |
| Attributes | `Attributes` (`{#id .class key=value}`): the last child of an ATX heading, inside a `Span`, or a box's name. Read them with `readAttributes` (`src/core/attributes.ts`) |
| Styled span | `Span` holding a `SpanMark` for each bracket, the inline content, and its `Attributes` |
| Definition list | `DefinitionList`, a container block holding the term (a `Paragraph`) and its `Definition`s, each a container block whose first child is a `DefinitionMark` |
| Grid table | `GridTable`, a leaf block; its cells are read from the text (`readGridTable`) |
| Git's conflict | `ConflictBlock`, a leaf block from a line that opens with seven or more `<` to the line of as many `>` that closes it, holding a `ConflictMark` for each marker line; nothing in it is markdown (`markdown/conflictMarkers.ts`) |
| Abbreviation | `Abbreviation`, a leaf block holding `AbbreviationLabel` and `AbbreviationTitle` |
| Tracked change | `CriticAddition`, `CriticDeletion`, `CriticSubstitution` (with a `CriticArrow`), `CriticHighlight`, `CriticComment`, each between two `CriticMark` |

The markers of a quote's later lines (`QuoteMark`) sit inside the blocks they cross, not as children of the `Blockquote`. lang-markdown's own editing helpers (its Enter and Backspace keys, HTML tag completion, pasting an address as a link) are off: `commands/typing.ts` and the paste feature do these.

Hard line breaks are read by our own inline parser (`markdown/hardBreak.ts`), which gives Lezer's tree but looks along a run of spaces once. The base language is lang-markdown's `commonmarkLanguage` with GFM, not its `markdownLanguage`, which also reads Pandoc subscript, superscript and emoji that GitHub does not.

### Pitfalls

- **CodeMirror draws only the viewport.** A check for something far down must scroll there first. Headless, a fresh state is parsed only a few thousand characters in: use `withFullTree(state)`.
- **Lezer reuses old nodes after an edit.** A construct that depends on a line further down goes stale unless its parser drops the reusable pieces over its range. The base parse wrapper (`markdown/reparse.ts`) does this for the front matter, for the two lines above every change, so a term finds a definition typed below it past a blank line, and back to the line that may open a git conflict above a change that may close, divide or split one (its text has a marker line, or it starts on a conflict of the old tree), however far up. A syntax that looks further ahead needs the same care, and one that looks back at a block before it must be a container that starts at that block, as a definition list starts at its term.
- **Lezer's parse wrappers run in reverse order within one `configure` call**, so front matter and the base parse wrapper are configured into the base parser on their own.
- **Text from outside is hostile.** A document line or the clipboard's HTML can be anything. Code that reads it must look at each character a bounded number of times: no pattern that can scan to the end again from each start position (`[\s\S]*?` up to an end mark that never comes, `[^>]*` over HTML with many `<`, a run of spaces before an anchor). Search forward with `indexOf`, stop character classes at the next delimiter, cap the length looked at, and walk nested structures with a loop rather than recursion.
- **The syntax highlighter colors code only** (`theme/highlight.ts`): the text of code blocks, in their languages, and of HTML blocks, whose source the page shows as code. Markdown's own nodes (an escape, an entity, a link's title, a comment) and inline HTML take no color from it, whatever their highlight tags: the features draw them, so a line and a table's cell draw them alike.

## Editing

Every editing command is a pure function from an editor state to a transaction, or null when it does not apply, and is tested without a browser. What commands share is in `commands/base.ts`: how a state command becomes a panel command, and the user event its transaction carries. A command runs only when `canEdit` (`modes.ts`) allows, which follows `state.readOnly` and so the resync lock; it reads the syntax tree through `treeFor` and asks `codeAt` whether a position is inside code (both in `markdown/tree.ts`).

**User events matter to sync.** A command's transaction carries `input.format`, which is not typing, so the change is sent to the document at once and is one undo step there. Paste is `input.paste`, a drop `input.drop`, a table cell's commit `input.table`, a replace `input.replace`. Only `input.type` and single-character deletions wait for a word to end.

- **Inline formatting** (bold, italic, strikethrough, inline code, highlight, link): with a selection, wrap it, or unwrap it when it is already exactly wrapped; marks go inside leading and trailing spaces; a selection across paragraphs is wrapped paragraph by paragraph. With no selection: on a word, apply to the word; otherwise insert the pair with the cursor between, and delete an empty pair when the cursor leaves it. New marks are `**` and `*`.
- **Blocks**: heading level up and down (a Setext heading is rewritten as `#` when its level changes); quote, bullet, numbered and task lists toggled on every selected line, new bullets using the marker of the nearest list; a code block fenced longer than any backtick run inside it; rule, table and image inserted at the cursor's line. Commands that work on line starts do nothing when the selected lines take in part of a code or HTML block (`cutsRawBlock`).
- **Typing rules** (`commands/typing.ts`): Enter continues a list item, task or quote, and ends it on an empty one; Backspace at the start of a heading, task, list item or quote deletes that mark first; Tab and Shift+Tab indent and outdent list items with their children, and indent text in a code block, unless Tab Moves Focus is on (`ui/tabFocus.ts`), when they move focus; typing a mark character with text selected wraps the selection; a numbered list is renumbered after an edit only when it was numbered in sequence. None of this applies inside code or front matter, or to changes from the host.
- **Paste** (`paste/`) takes the first rule that applies: inside code, front matter or HTML, or text copied from this editor, the plain text; image data, saved by the host and linked; a single web address over a selection, a link; tab-separated text of at least two rows and columns, a table; HTML that is more than a wrapper of its text, converted to markdown with turndown in a detached document; otherwise the plain text. The ordered rules are the doc comment of `choosePaste`. Ctrl+Shift+V pastes plain text. Turndown and the HTML renderer used for copy load on first use (`onDemand`): an HTML paste that arrives before its converter has loaded is held at its place (`paste/held.ts`), kept in step with every edit made meanwhile, and inserted when the converter arrives, and a pasted image waits the same way for the host to save it.
- **Copy** puts the markdown on the clipboard as text and the drawn form as HTML. A clipboard event must be answered before it returns, so the renderer starts loading as soon as text is selected or Ctrl or Cmd is pressed; a copy made before it has loaded carries the text only.
- **A block of markdown** (a pasted table, converted HTML, Insert Table, and what the block commands and the insert menu's blocks write) goes in through `commands/placeBlock.ts`, as its own block inside the quote or list item it lands in: in place of the selection (`placeBlock`), at the cursor's line (`blockAtLine`), or as a line of its own below it (`lineOfItsOwn`). Every new line starts with `containerPrefix` (`commands/lineInfo.ts`): each list item's indent to its content column and each quote's mark, as CommonMark reads them. A blank line goes between the block and a neighboring line with text, except in a list item around one closed fenced code block, or a rule that cannot underline a heading (`***`), which nothing runs into: there a blank line would make a tight list loose (`takesBlankLines`).

The toolbar runs the same commands through `runCommand`. Its buttons never take focus from the editor; Alt+F10 moves focus to the bar, and the arrow keys move along it.

## Tables, links, images and front matter

**Tables.** A table is found from the parser's `Table` node; anything the parser does not take as a table stays text. `src/core/tableModel.ts` parses and writes GFM tables, finding cells as `@lezer/markdown` does, so a cell's span is the span the panel sees. The grid is a block widget; a cell draws what a line draws: its content is the inline drawing of its `TableCell` node (see "Inline features"). A link or a tag in a cell follows with the keys it follows with in a line, through `openLink` with the place in the source the click was on. In Rich editor a click makes a cell a text field holding the cell's source text (`tables/cellEdit.ts`), with the cursor where the click landed: each drawn piece of a cell records where it starts in the source, so `sourceOffsetAt` (`tables/grid.ts`) maps a click on a character to that character's place in the source, inside bold, a link or code too, and a click in the cell's padding to the nearer end of its text. A cell opened from the keyboard puts the cursor at the end. Enter, Tab, Shift+Tab or leaving commits, Escape cancels. A commit is one change to that cell's span. Before writing, the table is read again from the current document, and the commit goes ahead only when no change has touched the cell and its span is still exactly one cell's; otherwise the field is dropped with a notice showing what was typed. A `|` typed in a cell is written `\|`, a line break `<br>`. The bar above an active table inserts, deletes and moves rows and columns and sets alignment, each as one change that rewrites the table. A selection landing inside the table's lines shows them as source.

**Links.** Inline, reference, autolinks and bare web addresses draw as links, read from the tree by `links/read.ts`. A plain click opens one in Rich view, Ctrl+click in Rich editor; a hover card shows the address and "Open", and for a note, the start of the note. Opening is the host's (see "The host").

A reference link and a footnote work wherever their definitions are, though CodeMirror parses a long note only so far past the screen. `links/farDefinitions.ts` reads the text past the stored parse with the same block parsers and no inline syntax (about a tenth of the cost of a whole parse), from the line where the stored tree's last top-level block starts: a top-level block does not depend on the text before it, so the two readings agree wherever both exist, and the definitions field and the footnote index take the stored tree's definitions before that line and the reading's after it. What draws a reference link looks its label up (`definitionLookup`): among the stored tree's definitions first, and among the reading's only when it is not there, so a note whose links on screen are inline ones, or defined in what the editor has parsed, makes no reading for its first frame. The reading is made when first asked for, or before that when the page is idle; an edit before it moves it, any other change leaves it stale until the page is next idle, when it is read again from the pieces the change left and the features that draw definitions draw again. Following a link or a footnote reads it again at once.

**Footnotes** are links followed in the panel itself. `links/footnotes.ts` keeps the file's references and definitions, built the first time a footnote is drawn and then read again only over the blocks an edit damages (`docDamage`), and numbers the notes as GitHub does (the definitions past the stored parse are read only to number or follow a note, so a table or a task with none in it makes no reading): by the order of each label's first reference, notes written in place (`^[text]`) in the same sequence. A reference to a label the file does not define is text. `linkAt` gives a footnote target (`kind: 'footnote'`) for a reference, which goes to its note's text, a definition's label, which goes back to the first reference (one past the stored parse is found by parsing as far as it, as a command does), and a note written in place; `openTarget` follows it with `goToFootnote`, and the hover card shows the note's text. The keys are a link's: a plain click in Rich view, Ctrl+click in Rich editor, Alt+Enter, and Tab and Enter in Rich view.

**Wikilinks.** `[[Target]]`, `[[Folder/Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, `![[image.png]]`. Matching, in `src/core/wikilinks.ts`: case-insensitive; the target, without a `.md` or `.markdown` ending, must equal a markdown file's whole workspace path without its extension, or the end of it at a folder boundary; a target naming another extension matches a file's full name the same way. With several matches the closest to the linking note wins (longest shared folder path, then fewest path segments, then alphabetical) and the link is marked ambiguous. A target starting with `/` must match the whole workspace-relative path; one starting with `./` or `../` is relative to the note's folder. Bear writes a link to a heading as `[[Note/Heading]]` (`[[/Heading]]` in the same note), which the rule reads as a note in a folder: `LinkIndex.resolveLink` takes that reading when a file answers it, and otherwise the heading after the last `/` in the note the part before names, when that note has the heading, giving the resolution a `heading`. The host's `wikilinkResolver` (`src/host/links/notePreview.ts`) is the one place targets are resolved for the page, the hover card, opening and embeds; it reads a note's headings at most once per request. The panel draws such a link as `Note > Heading`. None: drawn dashed. Typing `[[` offers files, and choosing one inserts the shortest target that names it alone. `tandemMarkdown.syntax.wikilinks` reads the target before the bar (`noteFirst`, Obsidian's order) or after it (`textFirst`, Dendron's and GitLab's); the parser places `WikilinkTarget` and `WikilinkAlias` accordingly, so everything that reads a link through `wikilinkOf` follows the setting, and what the panel sends the host is the target alone. GitLab's and Azure DevOps' `[[_TOC_]]` and `[[_TOSP_]]` are not links (`isContentsMarker`). In a table cell, a picture's size after `\|` is its size, not text to show.

**Images.** `![alt](path)` and `![[file]]` draw in place, and the source shows when the cursor touches it. Paths are relative to the note, or from the workspace root with `/`; `https:` is shown while the setting allows it; a PNG, JPEG, GIF or WebP stored in the file as a `data:` address is drawn by the panel itself, nothing fetched, up to `MAX_STORED_PICTURE` (`html/storedPicture.ts`); anything else is not loaded, and the widget says why. An image's size is remembered so the page does not jump the next time it opens (a stored picture's by its length and its last characters). Sizes other programs write are applied (`render/images.ts`): an embed's alias as Obsidian and Foam read it, and under their settings a size after the alt text, in braces after the picture, or after the address (`markdown/pictureSize.ts`); a size is pixels or a CSS length. An address ending in `#gh-dark-mode-only` or `#only-dark` (or `light`) gets a class that the stylesheet hides in the other theme, by the theme's kind VS Code puts on `<body>`. Under `tandemMarkdown.syntax.media` a video or sound file written as a picture or embedded is a player instead, loaded by the same answers, never set to play by itself. A pasted or dropped image is saved by the host (to `markdown.copyFiles.destination` when that is set, otherwise beside the note, named from the note and the time), and the link is inserted.

**Front matter.** A block whose first line is exactly `---`, running to the next line that is exactly `---` or `...`, is front matter, and so is one between `+++` lines, in TOML, as Hugo writes it (`src/core/frontmatter.ts`: the panel's parser, the outline and the word count use the one rule). Behind a setting the panel also reads JSON between `;;;` lines (GitLab) or a bare object that starts the file (Hugo). It draws as a table of names and values; the data is parsed for display only and never written back: YAML by a parser that loads when the first file with YAML front matter is drawn, TOML by `render/toml.ts`, which keeps each value as written, JSON by the browser. Data that does not parse shows as source. A value's wikilinks (`"[[Name]]"`, as Obsidian writes them) are links, opened with a link's keys (`render/frontmatterLinks.ts`). The pencil, or the cursor entering the block, shows the source. `tandemMarkdown.frontmatter.display` chooses table, source or hidden.

## VS Code's features in the rich views

The panel edits VS Code's own document, so what VS Code and other extensions know of it applies to the rich views too: problems (a spell checker's, a linter's, the markdown link check's) and their quick fixes, rename, suggestions for a link's address, and git's committed text. The host asks VS Code through its public commands and interfaces, and the panel shows the answers; the panel never applies an edit VS Code returns. VS Code applies it, and the panel sees it as an ordinary change.

**Places across the border.** Both ways a place is an LF offset.

- A panel's request names a place in its own text and sends that text's stamp (`expect`). The host has that panel send what is unsent (`flushPanels`), then goes ahead only when the document's LF text has that stamp (`textForRequest` in `panelText.ts`); otherwise it answers `stale` and does nothing. Sending first is what lets VS Code see the characters just typed, which suggestions need.
- What the host sends of its own accord (`diagnostics`, `changeMarks`) is in the coordinator's text at its log version (`syncedText`), the text every panel is synced to; the document can be a step ahead of it while an edit is applied. The panel places the set with `hostRanges.ts`: at its synced version, over its unsent changes; for a version it has not reached (its updates are queued, as during IME composition), held and placed by the transaction that reaches it, over the updates after that version; for a version it has passed, dropped. Placed items move with every change after. A set can be placed by a transaction that changes no text (one that only confirms the panel's own updates), so what draws them reads the field itself. Every `init` starts a fresh state, so the host sends both again to each panel that becomes live.

**Problems** (`diagnostics.ts`, `render/diagnostics.ts`, `ui/problemCard.ts`). Every diagnostic `languages.getDiagnostics` holds for the document goes to its panels when they change (gathered for `DIAGNOSTICS_PAUSE_MS`), at most `MAX_DIAGNOSTICS`, the most severe kept, each range held inside the text and an empty one widened to its word (`model/diagnosticItems.ts`). The panel draws them as marks from its field in both views: CodeMirror puts in the page only those near the window, and a keystroke costs one pass over the held items. Pointing at one shows its card; the card asks for the range's quick fixes (`codeActions`: `vscode.executeCodeActionProvider` with the quick fix kind) and offers each as a button. Quick Fix (`quickFix`, Ctrl+.) opens the card at the cursor with the focus on the first fix. `applyCodeAction` applies a fix the panel was offered, only while the document is at the version the fixes were listed for: its edit with `workspace.applyEdit`, then its command. Whether an extension reports on a document open only in a custom editor is the extension's choice: one that follows VS Code's open documents does, as the suite's helper does.

**Rename** (`rename.ts`, `ui/rename.ts`). F2 asks `vscode.prepareRename` what a rename at the cursor would rename; the box opens under that text with VS Code's placeholder. Enter asks `vscode.executeDocumentRenameProvider` for the edit, and the host applies it with `workspace.applyEdit` as a refactoring, to every file it touches, unless the document changed while the edit was worked out.

**Suggestions** (`completions.ts`, `complete/vscode.ts`). In Rich editor, where a link's or picture's address, a reference or an HTML `src` or `href` is being typed, the panel asks `vscode.executeCompletionItemProvider` at its start, after `/`, `#` or `.`, and on Ctrl+Space; typing within one part of a path filters the list in place. The source sits in the one `autocompletion` of `[[` completion, since CodeMirror takes one list of sources. VS Code's own snippets, items that would also change text elsewhere and items that start on another line are left out (`model/suggestions.ts`); a snippet item is inserted as its text with the cursor at its first tab stop, and a folder asks again.

**Broken links** are the markdown link check's diagnostics (`markdown.validate.enabled`), drawn as problems. VS Code's markdown extension asks for a file's diagnostics only while a tab shows the file, and its language client counts a custom editor's tab (`TabInputCustom`) only from VS Code 1.146 of the versions tried (1.123 and 1.120 count text and diff tabs alone): on those, a file open only in a rich view is not checked, and its warnings show while Source also shows it.

**Change marks** (`changeMarks.ts`, `gitApi.ts`, `render/changeMarks.ts`). For a document in a git repository, the host reads the file's text at the last commit through the built-in git extension's interface (`vscode.git`, version 1: `Repository.show` at HEAD's commit, kept per commit). `CHANGE_MARKS_PAUSE_MS` after the document last changed, it compares lines with the project's own sequence diff (`model/lineChanges.ts`), within `MARKS_WORK`, and sends the marks. They compare with the last commit, not with what is staged. A commit, checkout or reset moves HEAD and sends them again. Nothing is sent for a file in no repository, not in the last commit, or over `MAX_MARKED_CHARS`, or while `tandemMarkdown.changeMarks` is off. The panel draws them in a layer beside the text column, in Rich editor only, so no line's height or class changes.

**Edits the user asked for.** A rename's or a fix's edit is applied through `documents.applyUserEdit`, so its change events, which arrive before `applyEdit` resolves (see "What VS Code is assumed to do", 2), are not labeled `outside` and are not outlined.

**Untitled and `.txt` files.** The rich views are offered (`model/richOffered.ts`, and the same rule in the `when` clauses of the view commands) for markdown, `.txt` files and untitled documents in markdown or plain text, never as their default: the custom editor's selector names `.txt` with priority `option`, and Show Rich View, Show Rich Editor and Switch View act on those tabs. A `.txt` file shown in our editor has a reconciler, as a markdown file has. An untitled document is not on disk: another program's changes, the remembered base, change marks and Verify File do not apply, a picture or link by a path relative to the note has no folder to start from (a picture says "Save the note to show pictures beside it"), and a pasted image is refused until the note is saved.

## What a screen reader is told

When another program's change lands in a note, a rich tab tells a screen reader in one sentence, in the words of `src/panel/announce/words.ts`, through the editor's polite live region (`EditorView.announce`): a screen reader speaks it once it has finished what it is saying, and nothing on the screen changes. VS Code gives an extension no quiet way to speak outside its own page, so Source tells nothing. `tandemMarkdown.outsideChanges.announce` turns it off.

- **What is gathered** (`announce/news.ts`, `newsField`). Each update with reason `outside` or `merge` (`outsideChanges.ts`, which the outline reads too) is read against the host's text at the version it was made on, which the field follows from each init through every update the tab applies: lines it put in whole are added, lines it took out whole are taken out, any other line it touched is changed, and each line break it took out beyond those it put in is a line taken out (two lines joined are one changed and one taken out), each line counted once (`announce/landed.ts`). Each is kept where it now stands, with its update's version, until it is told.
- **Where** (`announce/places.ts`): the nearest heading above, as the outline names it (`buildOutline`), and for an empty heading or one the change added, the nearest heading with words beside it ("the empty heading after the heading Route"); above the first heading; in a note with none, a third of the note, with the first words of a line the change is at, quoted as the note holds them so that Find reaches them (the first line it changed or added, or, where it only took lines out, the line just after them, or at the note's end just before them). Blank lines say nothing of the place where the change touched lines with words. The front matter and a table, pipe or grid, come from the tree, a table counted by its rows: each line of a pipe table is a row, a grid table's row spans its lines, and neither a pipe table's line of dashes nor a grid table's border is a row; lines taken out of a grid table are counted as lines, since which rows they were is gone with them. Any other block drawn as a picture comes from the widget drawn for it (`drawingName`, each `DrawnKind`'s `sentenceName`), so a block the cursor has opened counts as lines.
- **When** (`announce/index.ts`). Once `QUIET_MS` has passed since a change last landed and since the person's last key in the tab or last change made elsewhere (Source, another tab, undo), while the tab is shown and its page visible. A tab behind another tells what it gathered once it is shown.
- **What the host says** (`src/host/announce.ts`, called from `notices.ts`). `outsideNotice` as each core notice arrives: a message speaks for the latest change from outside at or before the log version it names, which is then not told; or a notice with no message may give a warning in the Problems list (`coming`, then `warning` or `none` once its part is written), and the tab waits up to `WARNING_WAIT_MS` for that and names the warning only once it is shown. `outsidePressed`: the versions a press of a message's button or of a warning's quick fix made, which are not told. `unsavedChanges`: VS Code's dirty flag, once a tab is live and at each flip. A word naming a version the tab has not reached waits until it has.
- **Told once.** Before it tells, a tab asks the host (`tellOutside`). Where another tab of the note is the active one and shown, that one tells and this one waits; otherwise the host answers the version up to which the note was told, and tells the note's other tabs (`outsideTold`), which drop what they gathered up to it.
- **The line the cursor is on.** In the Rich editor with focus, a change to the cursor's line is told first, and a second sentence says what stayed as the person left it, only where that is so: no change from outside since the last telling touched the selection or a span the person changed since the note was last saved (in the tab, in Source or another tab; `unsavedChanges` false clears them, but for what the tab has not sent). The second sentence is one of three: "Your cursor and your unsaved typing are as you left them" where there are such spans and the tab knows them all; "Your cursor is where you left it, and you had no unsaved typing" where the tab knows there are none; and, where the note held unsaved changes when the tab started, which the tab cannot see, "Your cursor is where you left it. This tab can't tell whether the change reached unsaved typing you did before it opened." Where the change's other lines are not all where the cursor's line is, the sentence names that line's own place too ("the line you are on, under the heading Questions, and 4 more lines under the headings Route and Weather"); where they are, it says "all" of them are there. A change that gave a warning in the Problems list is told in the ordinary sentence.

## Optional syntax

Everything the panel reads beyond CommonMark and GFM (tables, task lists, strikethrough, autolinks) is optional syntax: wikilinks, highlight and its colors, footnotes, tags, emoji codes, callouts, math, the sizes other programs give pictures, players, pictures for one theme, one tilde, comments, tasks with other marks, Mermaid diagrams, contents lists, embedded notes and block ids, and what document tools and site builders write (see "Boxes"). Each can misread ordinary text (two prices read as math, a color code read as a tag), so each has a setting, `tandemMarkdown.syntax.<id>`, and with it off its text is read as CommonMark reads it. However a file is drawn, the file is the same. YAML front matter is not in the table (TOML and JSON front matter are): `tandemMarkdown.frontmatter.display` already shows it as typed, and its parser must stay in the base parser (see "Pitfalls").

`src/panel/syntax/` holds the table: one file of entries per family of syntax, joined in `index.ts`, so that work on one family touches one file. Each entry switches three things: its parser extensions (the language is rebuilt with the extensions of the syntax that is on), the features listed in its `draw` (the framework draws nothing for them while it is off), and the code-block languages in its `fences` (the code feature leaves those blocks to the syntax's feature). An entry marked `codeLanguage` changes how a code block's language is found (`markdown/index.ts`), so turning it builds the language again too. Most entries are a boolean setting. An entry with `choices` is a string setting that chooses between readings of one thing, each value with its own parser extensions and features; its value `off` reads and draws nothing (one tilde: `both`, `strikethrough`, `subscript` or `off`; wikilinks: `noteFirst`, `textFirst` or `off`). `syntaxOn` says whether a syntax is on (any value but `off`), `syntaxValue` which value is chosen.

### Adding a syntax

1. **Recognize it** in a parser extension in `src/panel/markdown/` (`tag.ts` is the smallest). An extension only names ranges; it never alters the text. Recognition is strict where ordinary text could be mistaken (a price, a color code, a time, a `#` before a number), and looks at each character a bounded number of times (see "Pitfalls"). A syntax drawn from nodes CommonMark already gives needs none: a callout is a quote.
2. **Draw it** in a feature in `src/panel/render/`: an inline feature for what sits in a line (the same build draws it in a table's cells; name in `reads` anything it reads beyond the text it draws), a block feature for whole lines, a drawn block for a block that becomes a drawing. Its marks hide unless a selection touches it, as bold's do. A library it needs loads on demand (see "Libraries loaded on demand"), and HTML from the file goes through the door.
3. **Enter it in the table**, in its family's file under `src/panel/syntax/`: its id, its default, a one-line description in markdown, its parser extensions (`parse`), the features that draw it alone (`draw`) and any code-block language it draws (`fences`); or, for a setting with choices, its values (`choices`), each with its description, `parse` and `draw`, one of them `off`. Declare its setting in `package.json` (`markdownDescription` with the same text, `scope: resource`, the next `order`; for choices `type: string`, `enum` and `markdownEnumDescriptions`) and run `npm run syntax-reference` once its case is marked (step 4), which gives it its entry under "Settings" in `SYNTAX.md`; `test/panel/syntax/table.test.ts` fails until the table and `package.json` agree. The host needs nothing.
4. **Add its cases** to its family's file under `test/panel/syntax/cases/` (every `.json` file there is read): an example of each form from the program that writes it, the setting (and, for a setting with choices, the `value` the case is read under), the parser's nodes, the text Rich view shows and how many of each kind it draws (the kinds, in a reader's words, are in `src/panel/syntax/kinds.ts`, with how the page draws each; a drawing new to the page adds its kind there), the piece whose source the cursor shows, and the text with the setting off where that is not the example as typed. Add the ordinary text that must stay text. `test/panel/syntax/cases.test.ts` parses each case with its syntax on and off; `harness/tests/syntax.spec.mjs` opens each in Chrome, its syntax on, and checks what Rich view shows, that the cursor inside shows the source, and that the document is unchanged, and for one case of each setting (each value, for a setting with choices) that turning the setting off in the open view shows it as typed. Mark one case for each entry, and for each value of a setting with choices, with a `reference` field (its group, title, what it becomes and which programs write it), then run `npm run syntax-reference`: the marked cases are the examples in `SYNTAX.md`, and a test fails while an entry has none.
5. Show it in its family's sample, `harness/samples/syntax-<family>.md`, name its nodes in "Our syntax nodes", and extend the starting text of `test/panel/render/incremental.test.ts` with it when it draws blocks.

### Boxes

`:::` blocks, `!!!` and `???` admonitions, and behind their own settings MkDocs' content tabs (`=== "Tab"`) and GitLab's `>>>` quotes are one container block, `Box` (`markdown/boxes.ts`), read by one rule for the dialects that write them:

- **Opening.** At most three spaces in: three or more colons, then a name, a word starting with a letter (`::: note`, `:::note`) or attributes in braces whose first class names it (`::: {.callout-note}`). Then nothing; or a space and the rest of the line, the title (VitePress's `::: danger STOP`), less a closing run of three or more colons after a space (Pandoc's `::: Warning :::`); or, straight after a word, a title in brackets and nothing more (Docusaurus's `:::note[Title]`). Anything else after the name means the line is text, so `:::12:30` and `::: 10:30` stay text. `!!!` and `???` (`???+`) stand where their container's text starts and are followed by one type word, or by type words and a quoted title (`!!! danger highlight "Careful"`); `??? "Title"` needs no type, and `??? no idea` is a sentence.
- **Inside**, the text is ordinary markdown. An admonition's or a tab's body is indented four spaces, and ends at the first line indented less, as a list item's does.
- **Closing.** A line of three or more colons and nothing else (for a `>>>` quote, `>>>` alone) closes the innermost fenced box that the line reaches at that box's own level: not inside a quote or a list item within it. Its length does not matter, so VitePress's nesting with longer outer fences and Pandoc's with equal ones both read right. A box never closed runs to the end of what holds it, as an unclosed code fence does (markdown-it-container and remark-directive agree; Pandoc alone would read it as text), which keeps every line's reading local, so Lezer's reuse of old nodes stays sound.
- **Looks** (`render/boxes.ts`). A name a callout has (`note`, `tip`, `warning`, `danger`, Obsidian's types and aliases; Quarto's `callout-note` without its prefix) takes that callout's look, icon and default title (`render/callouts.ts`); an admonition of an unknown type takes the note's, as Material does, and reads `important` as a tip and `caution` as a warning, as Material does. Any other `:::` name is a plain box labeled with the name. `details` folds closed, as VitePress's does; Quarto's `collapse` and `title` attributes are followed, and a heading that opens a Quarto callout is its title. A box is drawn as a level of quote (`QUOTE_LEVELS`), so its bar, its nesting and its indent come from `render/quotes.ts`; its opening line is the head, its closing line a gap.
- `::: mermaid` is read as a fenced code block in the `mermaid` language (its `CodeMark`s are the colon lines), so what draws Mermaid fences draws it and nothing else needs to know.

The neighbors of boxes in the same family follow the same habits. One reader of attributes in braces (`src/core/attributes.ts`) serves headings, spans, box names and code fences (`markdown/fenceInfo.ts`). A fence's whole info string chooses both the language its code is colored in (`codeLanguage` in `markdown/index.ts`, which nests the languages itself because lang-markdown hands its `codeLanguages` only the first word) and the language the drawn blocks look for (`fenceLanguage` in `render/code.ts`), so `{#id .haskell}` is Haskell and ```` ```{mermaid} ```` a diagram. A definition list is a container that opens at its term, which looks down past at most one blank line for its definition (see "Pitfalls"). A grid table is a drawn block whose cells are read-only: a grid table's columns are kept by padding every line of a row, so a cell edit would rewrite the row, which breaks the promise of one cell's change. A cell's markdown is read by an editor state of its own that holds that part of the file (see "Inline features"), its paragraphs and lists drawn and its inline content drawn as a line draws it, so the text the drawing is made from begins with a key of what the cells read: `inlineKey`, the table's `placeKey`, the other features' marks over it and the indent of what holds it; the state the build saw goes to the drawing beside the text (`drawBlock`'s `given`). Abbreviations are read from the top-level blocks into a state field kept across edits that touch none, as link definitions are, and past the stored parse from the reading of definitions (`links/farDefinitions.ts`) once it has been made; they never make it, since any word may be one and every note would pay for it, and are drawn again when it is made (`madeFarDefinitions`). Math in LaTeX's delimiters (`markdown/latexMath.ts`) gives the math nodes, so the math feature draws it, and only while `math` is on.

### One tilde

GitHub strikes `~text~` through; Pandoc, Quarto, Typora and Joplin read `H~2~O` and `x^2^` as subscript and superscript. Their writing can be told apart, so `tandemMarkdown.syntax.tilde` reads both by default (`TildeAndCaret` in `markdown/tilde.ts`), by this rule:

- **A pair** is a single tilde (or caret), not touching another one, straight after a letter, a digit or a closing bracket (`)`, `]`, `}`) on the same line, then one or more characters, then the next single tilde (or caret). Between the two there is no white space, line break or backtick, so a pair never reaches into a code span; a space escaped with a backslash counts as none (Pandoc's `P~a\ cat~`, Typora's `X~long\ text~`), and an escaped tilde is part of the text between. A pair of tildes is subscript, of carets superscript. Nothing inside a pair is read as markdown but its escapes.
- **Any other single tilde** is GitHub's: it opens a strike when it is left-flanking and closes one when it is right-flanking, and closes only a strike one tilde opened (`OneTildeStrike`'s rule). So `~5 to ~10` stays text (a tilde after a space never closes), and `A ~gone~ word` is struck through. A caret that is not a pair is text.
- **What stays text:** an escaped tilde or caret (`\~`), anything in code, a run of two or more (`~~` is GFM's strike, always on; `~~~not~~~` and Logseq's `^^text^^` are text, and a run of three or more tildes is taken whole as text by `TildeRuns`, always on, since @lezer/markdown's strike would read a `~~` from inside it), and a tilde or caret in a link's address or a bare address, which their own parsers take first. A pair in a link's text or a table cell is read as anywhere.
- **Where the text cannot tell them apart**, Pandoc's reading is taken: `plan~was~` is subscript though GitHub would strike it. Every program also misreads text that has a pair's shape by chance: a Windows short path (`C:\PROGRA~1\MICROS~1\`) and a `sed` command with `~` as its separator (`s~a~b~`) read as subscript. `^C^C` in a sentence and a regular expression such as `^a|^b` stay text, since each caret follows a space or a sign; Pandoc's reading alone takes `^C^` as superscript.

The other values read one way only: `strikethrough` is GitHub's rule for every tilde, and `subscript` is @lezer/markdown's `Subscript` and `Superscript`, Pandoc's rule, any pair with no space inside wherever it stands.

### HTML through one door

`src/panel/html/door.ts` is the only place HTML from a file becomes nodes on the page. Lint holds it so: `dompurify` may be imported there alone, and nothing in the panel may assign `innerHTML`, `outerHTML` or `srcdoc`, call `insertAdjacentHTML` or `createContextualFragment`, or `document.write`.

- **Parsing.** The HTML is parsed into a detached document, where nothing runs or loads. That document takes the page's content policy, which blocks inline styles and inline event handlers and reports each one it meets while parsing, so `renameInline.ts` first renames `style` and `on...` attributes and `style` elements. It reads the text as the HTML tokenizer does, and where the tokenizer's reading depends on where it stands in the tree (a CDATA section, or a `<title>` or `<style>` inside SVG or MathML, which holds tags), it follows both readings.
- **Cleaning.** DOMPurify keeps GitHub's allow-list (`html/elements.ts`: the elements and attributes of html-pipeline's sanitization filter, which GitHub publishes, with `picture` and `source`), less `accesskey` and `tabindex`, which would let a file move the page's keys and focus. `id` is dropped and `name` is kept with `user-content-` before it, as GitHub does. A link may use http, https, mailto, xmpp, irc or a relative address; a picture may come from a relative address, from https while `tandemMarkdown.images.allowRemote` is on, or from a PNG, JPEG, GIF or WebP stored in the file. What a relative address becomes is the caller's (`DoorOptions.address`). The result comes back as nodes, never as markup to be parsed again.
- **What counts as HTML.** Only the elements of the HTML standard (`isHtmlElement`): `use <name> here` is text, shown as typed, though CommonMark reads `<name>` as a tag and a browser shows nothing for it.
- **Trust.** In a workspace VS Code does not trust, no HTML is drawn: every tag shows as typed, faded.
- **Links.** The door keeps a link's address; a drawing that shows one must handle its click as links elsewhere are handled (`openTarget` in `render/links.ts`), so the page itself never follows it.

Inline HTML is drawn as bold and italic are (`render/html.ts`): an element GitHub keeps for text (`<kbd>`, `<sub>`, `<sup>`, `<u>`, `<mark>`, `<span>` and the rest of `INLINE`), opened and closed in one paragraph, has its tags hidden and its content styled, and its tags show, faded, while a selection touches it; `<br>` breaks the line; `<img>` draws the picture from the attributes the door leaves; an anchor with no address is hidden, and one with an address the door would keep is a link (`htmlLinksIn` in `html/links.ts`), found by `linkAt` and Rich view's Tab like any link; a `<picture>`, `<video>` or `<audio>` on one line is drawn whole. A table cell draws them as a line does, and a list written as HTML in a cell (`<ul>`, `<ol>`, `<li>`) as a list.

`harness/tests/attacks.spec.mjs` runs `harness/attacks/corpus.json` (the OWASP filter-evasion cheat sheet, DOMPurify's test vectors, payloads from KaTeX's and Mermaid's advisories, and markdown written for it with the addresses and syntax the panel reads beyond CommonMark) through the door, with players kept and without, and through the panel, each HTML snippet in a document and alone, and requires that no script runs, nothing is requested from outside, the policy reports nothing, no player is set to play by itself, and nothing that runs or loads is left in the page.

### HTML blocks

`render/htmlBlocks.ts` draws every HTML block (comments and processing instructions are `render/html.ts`'s). `readHtmlBlock` (`html/blocks.ts`) reads a block's tags without a DOM, each character a bounded number of times, and says what it is:

| Kind | What it is | Drawn as |
|---|---|---|
| opener | the opening tag of a wrapper (`<details>`, `<div>`, `<p>`, `<center>`, or any element marked `markdown`), with only that tag (and a `<details>`' summary) or more; a `<details>` holding more is code | paired: its tag lines hidden, a `<details>` as its summary, one holding more as a drawing of it; unpaired: code, or a drawing when it holds more |
| closer | one end tag alone | paired: hidden; unpaired: code |
| drawing | HTML a browser shows, complete in itself | a drawn block of the door's nodes |
| invisible | nothing a browser shows (`<a name>`, empty elements) | removed in Rich view, code in Rich editor |
| text | tag-shaped text that names no element | as typed |
| code | HTML that leaves elements open for later blocks | code |

A wrapper pairs an opener with the next closer of its name among the blocks beside it (`pairWrappers`), the parse tree left as CommonMark makes it: by CommonMark's own rule a blank line ends an HTML block, so what lies between is already markdown. Pairs among top-level blocks are kept in a state field updated from `docDamage` and named to the framework as linked runs (see "Block features"); pairs inside a list item or quote are found in the build. The lines between take an alignment class from the innermost wrapper that has one. A `<details>` folds what follows its summary as its `open` says, and the user's folding is kept per opener on the page, never in the file. Hidden tag lines are a zero-height widget the cursor steps onto with Up and Down, which shows them. The feature comes early in the features list, so a folded `<details>` hides what other features draw inside it.

A drawing's pictures and players are taken off before the nodes reach the page and loaded through the host's answers (`bringToLife` in `render/htmlDrawing.ts`), so the door keeps https addresses and the host's rule, which follows `tandemMarkdown.images.allowRemote` as it changes, is the one switch. A `<picture>` becomes its picture for the dark theme and for the light one, the stylesheet showing the one in use. Links open as markdown links do and are Tab stops in Rich view. In a workspace VS Code does not trust, every HTML block shows as code. A block holding a player shows as code while `tandemMarkdown.syntax.media` is off; with it on the door keeps `<video>` and `<audio>`, never `autoplay`, and the page's policy has `media-src` for the extension's files and https.

### Libraries loaded on demand

A library a syntax needs loads the first time a file shows that syntax, through `onDemand` (`src/panel/onDemand.ts`), so the bundle the panel starts with does not grow. A build that meets something only such a library draws shows it as typed and calls `d.drawWhenLoaded(module)`, which loads the module once per panel and then draws again every feature that asked for it meanwhile: the inline feature itself for a line, and the feature that shows content outside the lines (a table) for an inline drawing.

A load that fails is never silent: it is logged, and where a drawing would stand the page says so (a drawn block's message, a formula's source marked with the reason); what needs the library otherwise stays as typed. A stylesheet that does not load fails the library's load, as does a page with no `tm-assets`. Anything the page's content policy refuses is logged too (`src/panel/boot.ts`), so the host's log shows why a drawing never came.

- **KaTeX** (`render/katex.ts`) runs with `trust` off, its expansion limit (`MAX_EXPANSIONS`), sizes capped (`MAX_SIZE_EM`) and errors thrown, so a mistake is a message, never markup. It builds its output as nodes and sets styles through the style object; two of its MathML builders set a `style` attribute, which the page's policy reports, so a formula is built from KaTeX's own tree with those styles moved to the style object. Its stylesheet and WOFF2 fonts are copied into `dist/panel/katex/` (`COPIED_PACKAGES` in `esbuild.mjs`) and linked when it loads (`addStylesheet` in `assets.ts`).
- **The emoji list** is gemoji's, which GitHub's emoji codes come from; `esbuild.mjs` builds its module with each name and its emoji only, in the panel's bundle and in the host's. The host imports it the first time a heading or a note it reads as plain text shows a code (`hostEmojiNames` in `host/model/notePreviewText.ts`), for the outline view and a link's card.
- **DOMPurify** is the door's, which loads the first time a file has HTML to draw through it (`html/load.ts`).
- **Mermaid** runs in a frame of its own (see "Diagrams"), and its code is not in the panel's bundle at all: `esbuild.mjs` builds it, with what drives it, into one script, `dist/panel/diagram-frame.js`, a module whose default export is the script's text (`frameOptions`, `asTextModule`), which the page imports (`loadAsset` in `assets.ts`) the first time a file has a diagram.

### Diagrams

A ```` ```mermaid ```` block, or ```` ```{mermaid} ```` as Quarto writes it, is a drawn block (`render/diagrams.ts`). Under the page's policy Mermaid cannot draw: at its strict level it puts a `style` element and `style` attributes into the page as it measures a diagram, and its output carries both. A diagram can also be made to hang it. So it draws in a frame, and the page shows what it draws as a picture.

- **The frame** (`render/diagramFrame.ts`): one per page, hidden, `<iframe sandbox="allow-scripts">` with no same-origin, so its origin is opaque: it cannot reach the page, its storage or its cookies, open a window, or navigate the page, and Chromium may run it in a process of its own. Its document is `srcdoc`, the panel's own fixed markup (lint allows `srcdoc` in that one file): a frame loaded from the extension's files is not served inside VS Code's webview, which serves a page's resources only to the page. A `srcdoc` frame keeps the page's policy and adds its own, `default-src 'none'; script-src 'nonce-…'` with the page's nonce, so nothing in it loads or is fetched; the page's policy needs no frame source. The frame's bootstrap takes the code by message and runs it as a script with the nonce.
- **Inside the frame** (`render/frame/main.ts`): Mermaid at its strict security level, its error diagram turned off so a mistake is a message, one diagram at a time. Before Mermaid's code runs, `render/frame/realm.ts` changes the frame's own realm so that Mermaid draws under the policy with nothing refused or reported: `setAttribute('style')` sets the style object; a created `style` element is a stand-in whose CSS goes into a constructed stylesheet; markup parsed into the document (`innerHTML`, `DOMParser`, as Mermaid's DOMPurify does) has its styles moved to the style object, handlers and `style` elements dropped (`html/renameInline.ts` renames them first); picture addresses and CSS `url(...)` that are not `#...` are dropped. `render/frame/picture.ts` makes Mermaid's SVG, which it writes as HTML, into a well-formed SVG document with its CSS in one `style` element and its size from the view box.
- **In the page**: the picture is an `<img>` with a `data:image/svg+xml` address (the page's policy already allows `data:` pictures), so the page never parses Mermaid's markup: a picture runs no script and loads nothing, Mermaid's styles apply as Mermaid wrote them, and the drawn block's clicks, pencil and keys work as for any drawing. Links in a diagram do nothing, as on GitHub. Pictures are kept by text and theme. The theme follows the editor's (`EditorView.darkTheme`): Mermaid's dark theme on a dark page, its default on a light one.
- **A diagram that throws** shows Mermaid's message, its first line and its last, in place of the drawing (or under the last good one). **One that takes longer than `DRAW_TIMEOUT_MS`** (20 seconds) shows "Not drawn: drawing it took longer than 20 seconds."; its frame is removed, which ends whatever was running there, and the next diagram is drawn in a new frame. While the frame is busy the editor stays usable when the browser runs the frame in another process, as Chrome does with a sandboxed frame; if it does not, the session mark (see "Drawn blocks") holds the diagram back after a reload.
- `::: mermaid` is read by the boxes parser as a fenced code block in the `mermaid` language (see "Boxes"), so this feature draws it with nothing more.
- **Opened large** (`ui/diagramView.ts`): a drawn diagram's button opens its picture, the one already drawn, over the whole panel, where it is zoomed and moved by its buttons, keys, a drag or the wheel. It is a dialog inside the panel's root, outside the editor, and touches no text. While it is open the editor is read-only, as while a resync is pending, and focus in it counts as a field's (`focus.ts`), so neither the editor's keys nor VS Code's undo reach the note; the view goes when the editor's state is replaced, and before Find or Replace opens the search bar, whose matches are in the note it hides (`closeDiagramView`).

### Contents lists

`[TOC]`, `[toc]`, `[[_TOC_]]` or VitePress's `[[toc]]` (any letter case) as a top-level paragraph of its own is a drawn block (`render/contents.ts`) listing the file's headings as nested links; `[TOC]` that is a defined reference link stays a link, and so does `[[toc]]` once the host says a note answers it as a wikilink (until it has answered, it is a list; its answer draws the feature again). The headings are the outline's (`src/core/outline.ts`), each read as plain text (`plainText` in `src/core/plainText.ts`: the marked text without its marks, an entity as its character, a comment gone, emoji codes and math as typed), kept in `headingsField` with their positions mapped through every edit. A file of at most `READ_AT_ONCE` (100,000) characters has them read as its state is made; after that, and in a longer file, they are read `DRAW_PAUSE_MS` after typing stops by a parse of the outline's own (`startOutlineParse`), advanced a slice at a time while the page is idle and reusing the last parse where the text did not change, so neither the keystroke nor the editor's own tree pays for it. A change draws the feature again with `redrawFeatureEffect`, since a list depends on headings anywhere in the file. A link follows as links do (a click in Rich view, Ctrl+click in Rich editor, Enter when it has focus) and runs `revealHeadingSpec`. The links are `tm-stop` controls, so Tab reaches them in Rich view: controls in one drawing share its position, and the page's order decides among them (`nextControl` in `ui/viewKeys.ts`).

### Embedded notes and block ids

`![[Note]]`, `![[Note#Heading]]` or `![[Note#^id]]` alone in its paragraph is a drawn block (`render/embeds.ts`). The host reads the note (`embedNotes`; see "Links and images on the host") and answers with the part the embed names, or a sentence saying why there is nothing; the page asks for every embed in it through its own context, a batch at a time, and asks again on `embedsChanged` and `linksChanged`. The note is drawn by an editor of its own (`innerState`), read-only, in Rich view's mode, with the page's drawing features less those that act on the page's own document, page or host (`LEFT_OUT`; a new feature of that kind belongs there), so file HTML goes through the door and diagrams and math draw as on the page. The embedded editor is freed when its drawing is (`Drawing.dispose`). An embed `MAX_EMBED_DEPTH` (3) notes deep, or of a note already shown around it, is a sentence instead. The header names the note and has a button that opens it, asked by the editor the embed is written in. Every request an embedded note's editor makes names that note (`note`, its workspace path), and the host reads the request's addresses from it (`requestNote` in `src/host/links/location.ts`, which takes only a markdown file inside the workspace folder of the panel's note), so the links, pictures and embeds of an embedded note are read from its own folder at any depth, and its `#heading` links open it there. The page keeps the answers about embeds per note they are written in.

A block id (`src/core/blockId.ts`: `^quote-1` after a space at the end of a paragraph's last line, or a line of its own) is faded in Rich editor and hidden in Rich view (`render/blockIds.ts`). The host finds the block an embed or a link names by the same rule (`src/host/model/noteSection.ts`); a link to a block (`[[Note#^quote-1]]`) previews that block in its hover card.

## Testing

| Check | Command | What it guards |
|---|---|---|
| Unit tests | `npm test` | Everything that runs without a browser or VS Code: the core, the host's model, the panel's commands and drawing over a headless state |
| The simulation | part of `npm test` (`test/sync/`) | That no interleaving of panels, VS Code and outside writers loses or misplaces text |
| Browser specs | `node harness/tests/<name>.spec.mjs` | The real panel in Chrome: drawing, tables, editing, find and paste, links, sync, the outline on lines changed from outside and what a screen reader is told of them, the optional syntax and drawn blocks (`syntax`), HTML blocks and what other programs write as HTML or pictures (`html`), diagrams, contents lists, embedded notes and block ids (`drawn`), VS Code's features in the rich views against stand-in answers (`vscode`), and the attack corpus under the page's policy (`attacks`) |
| In-VS-Code suite | `npm run itest` | The extension in a real VS Code: the promises about the document (`document.test.ts`), the faults the simulation cannot reach (`faults.test.ts`), what VS Code is assumed to do (`vscodeAssumptions.test.ts`), and the features |

`npm run check` runs the core checks: the formatting, lint, the type check, the core unit tests (the simulation included) and the two generated files. They run on every commit; the panel's unit tests and the browser specs run when the files they cover change, as `scripts/areas.mjs` lists them, and the in-VS-Code suite when the host or the core changes, and every check runs on every system and version before a release. `CONTRIBUTING.md`, "Where each check runs", gives the rules and the table.

### The simulation

`test/sync/` pairs the real `DocumentCoordinator` with deterministic stand-ins (`test/sync/world.ts`, `test/sync/fakes/`) calibrated to measured VS Code timings (`T1` through `T11`): `FakeDocument` (dirty-late flag, clean reload, save lifecycle, `DocumentGate` version checks), `FakeDisk` (empty-first writes, locks, raw bytes, backups), `FakeClock`, and `HeadlessPanel` running real `PanelSync`.

- `test/sync/scenarios.test.ts` runs 20 explicit real-world sync scenarios (clean follow, dirty-late first keystroke, disjoint merge, `keepMine` / `keepTheirs` clash + Undo, both-sides-insert, auto-save bursts, `willSave` race, post-`didSave` revert, Save without Formatting, transient and persistent truncation, restart recovery, git checkout, `typingAtClose` + `putBack`, locks, non-UTF / undecodable bytes, backup failure fallback, multi-tab EOL flip, close with pending, clean reload followed immediately by panel typing, and Source typing during a clean save).
- `test/sync/simulation.test.ts` runs seeded randomized workflows (`2,000` seeds on every `npm run check`; `SIM_FIRST`, `SIM_RUNS`, and `SIM_TRACE=1` customize the sweep) asserting three invariants on every run:
  1. No silent loss of unsaved user typing (present in final file, explicitly undone, or preserved in backup/notice).
  2. No silent loss of settled outside writes outside the save-write gap or Save without Formatting.
  3. No doubled markers, zero `DocumentGate` / error-log violations, and full panel/document/session/disk convergence.

### The merge oracle

`test/core/merge3.test.ts` generates edits where each side's changes are known line by line, so the right merge is known: a merge without conflicts must hold both sides' edits, each exactly once. A conflict is always allowed; a clean wrong answer is not. Every merge must also keep each word and non-blank line that the base and both sides each hold exactly once, under either preference. `MERGE3_ORACLE_RUNS` sets how many cases run. The diff's own property is that applying `diffChanges(a, b)` to `a` gives exactly `b`, over random texts and realistic markdown.

### The browser harness

`harness/` is a web page where the real panel runs against the real document core and a stand-in for VS Code, with the document and the file shown beside it (`npm run harness`, then `http://127.0.0.1:5177/harness/`). `harness/lab.html` is the editor with every drawing feature and no host: it answers only for embedded notes and pictures, at once, from the made-up workspace in `harness/fakes/`, and fetches nothing from outside. The specs in `harness/tests/` each build the harness into a folder of their own (`serveOwnBuild` in `harness/serve.mjs`, so specs can run side by side), serve it on a free port and drive the installed Chrome, headless, through `playwright-core`; their checks and verdict are `harness/checks.mjs`'s, and the exit code is the verdict. The page exposes `window.__harness` and `window.__lab` for scripts. The stand-in's inits say test mode, so the specs can read the panel through the same test hook (`host.runInPanel`). A feature's stand-in host answers go in `harness/fakes/`.

### The in-VS-Code suite

`npm run itest` builds everything and runs `itest/suite` in a separate copy of VS Code, downloaded once into `.vscode-test`, with no other extension but the test helper (`itest/helper`, built to `out/itest/helper`, which reports problems on markdown documents and offers quick fixes, as a spell checker does) and its own user data, extensions folder and workspace (a fresh copy of `itest/fixtures`) under the system's temporary folder, or `TM_ITEST_DIR`. `VSCODE_TEST_VERSION` chooses the version (a number or `stable`). It opens a real window, and fails if another window takes focus. `npm run itest -- links` runs only the files whose names contain that word. The suite reaches the extension only through the test hook (`api()` in `itest/suite/helpers.ts`; see "The host", "The test hook"). Tests of VS Code's own Markdown Editor (`otherEditor.test.ts`) skip themselves on a version that does not contribute it, as read from the built-in markdown extension's manifest. Before the first test the suite writes a probe file until VS Code reports it (`watcherReady.ts`): VS Code starts watching the workspace some seconds after its window opens, and a file written before then is never reported. A test writes as another program does with `writeFile` or `writeFileAt`, which try a write again a bounded number of times while Windows refuses it because VS Code's Local History is copying the note just saved. Files whose names start with `facts` establish facts about VS Code and other extensions, measured once, and run only when a word given to the runner starts with `facts` (`itest/suite/facts.ts`).

`scripts/parser-sweep.mjs` reads a folder of markdown files read-only and reports any file the editor does not load back unchanged, any feature that throws while drawing it, and every line where the parser's block structure differs from markdown-it's.

## Decisions

- **The text is the only copy.** CodeMirror edits the document's own text, not a rich tree. Losslessness and exact sync come with it; the cost is that marks show at the cursor.
- **VS Code keeps the document** (`CustomTextEditorProvider`). An editor that keeps its own copy has to reconcile two copies, and that is where such editors lose text.
- **`@codemirror/collab` for sync**, not hand-written replay: it is CodeMirror's own answer to one authority and several editors.
- **Typing is pushed in word-sized steps**, so VS Code's undo has sensible steps. The delay it adds is covered by the same replay.
- **Outside changes are merged by content, against a base**, not by positions: the other writers (git, scripts, AI tools) hand over whole files. Merging by word inside a line, because a paragraph is one line.
- **A clean change is not taken for a reload.** VS Code reports a first edit exactly as it reports a reload, so the core reads the disk and decides from what it reads.
- **On a real conflict the user's typing is kept** and the other program's version goes to a backup and is offered. Taking its version would replace words under the cursor; asking would block a save. The setting reverses it: its words are used and a copy of the user's text goes to a backup, with Undo, except where its version cannot be merged safely.
- **Saving over a newer file without asking, for markdown**, because the newer file has already been merged in.
- **A merge is applied as an ordinary edit inside the save step**, not returned as the step's text edits, which carry no version check.
- **The decisions about text live in pure code behind three ports**, so refused edits, races with saves and half-written files can be simulated. They are interleavings that cannot be produced on demand inside a real VS Code.
- **Source is VS Code's text editor**, reached by reopening the tab, not a source mode inside the panel. Everything else a user runs on markdown keeps working there.
- **Rich view and Rich editor are one engine**, so nothing moves when switching between them.
- **Display parsing uses CodeMirror's parser** (checked against markdown-it's block structure by the sweep script): only it gives exact positions for every mark and parses again only what changed.
- **Table cells are not re-padded on edit by default.** One cell edit shows as one cell changed in a diff.
- **Keys follow Markdown All in One where it has them** (Ctrl+B, Ctrl+I, Alt+S, Alt+C, Ctrl+Shift+] and [).
- **Colors from the VS Code theme, measurements from GitHub's stylesheet.**

## Not in this version

What is drawn today and what shows as typed is in `SYNTAX.md`, the syntax reference. What is planned, what is being considered and what is not planned, each with its reason, is in `ROADMAP.md`. Two rules govern any syntax added: one that is neither CommonMark nor GitHub's gets a setting, and how a file is drawn never changes the file.
