# Contributing to Tandem Markdown

Thank you for helping. This extension edits people's files, so the bar for a change is that it cannot lose or misplace text. This guide says how to set up, which checks prove what and where each one runs, and how the code is written. `docs/ARCHITECTURE.md` explains how the code is put together; read its first three sections before a change of any size.

## Setting up

You need Node 22 (`.nvmrc` names it) and npm.

```
npm ci
npm run build
```

Press F5 in VS Code ("Run Extension") to start a window with the extension loaded from `dist/`. `npm run watch` rebuilds on every change; reload that window to pick a rebuild up. `npm run harness` serves a web page where the real panel runs against a stand-in for VS Code, which needs no VS Code at all.

To install your own build, `npm run package` writes `tandem-markdown-<version>.vsix`; install it with "Extensions: Install from VSIX..." in the Command Palette.

## Commands and what each proves

| Command | What it does | What a pass proves |
|---|---|---|
| `npm run build` | Builds the extension host bundle and the panel bundle into `dist/` | It compiles and bundles |
| `npm run check` | The core checks: formatting, lint, type check, the core unit tests, the two generated files | Everything that runs on every commit holds (see "Where each check runs") |
| `npm test` | Every unit test (vitest, in Node): both projects below | The core, the host's pure modules, and the panel's commands and reading of markdown over a headless editor state |
| `npm run test:core` | The core unit tests (vitest's `core` project, `vitest.config.ts` lists it) | The document core and the simulation, the host's modules, and the panel's code that writes to the document or decides what reaches it |
| `npm run test:panel` | The panel's unit tests (the `panel` project) | How the panel reads and draws markdown, over a headless editor state |
| `npm run lint` | ESLint, type-aware | No floating promises, no layering violations, no `innerHTML` in the panel; in the core, the panel, the host, their tests, the simulation, the harness, the in-VS-Code suite, the scripts and `esbuild.mjs`, imports in order: node's own modules, packages, `../` paths, then `./` paths, each by path |
| `npm run format:check` | Prettier, checking only | The formatting is Prettier's (`npm run format` writes it) |
| `node harness/tests/<name>.spec.mjs` | One browser spec: builds the harness, serves it on a free port, drives Chrome headless | The real panel draws, edits, pastes and syncs as the spec says |
| `npm run specs` | The panel's unit tests and the browser specs that cover what changed since `main`, committed or not, one after another (`node scripts/areas.mjs` only names them) | Every area the change touches still keeps its promises |
| `npm run itest` | The in-VS-Code suite, in a separate test copy of VS Code | The extension keeps its promises inside a real VS Code |
| `npm run release-checks` | The checks run once before a release, on this machine (below) | The release set holds here |
| `npm run notices` | Writes `THIRD_PARTY_NOTICES.md` from the production build | The notices list every bundled package and its license |
| `npm run package` | Builds for production and writes the `.vsix` | The package can be made |

Each case in `test/panel/syntax/cases/` says what a reader sees: the text Rich view shows (`view`) and, by kind, what it draws (`drawn`), as in `{"subscript": 1, "superscript": 1, "strikethrough": 0}`. The kinds are named in a reader's words, and `src/panel/syntax/kinds.ts` holds them with how the page draws each one, so a class renamed or a drawing restructured changes that file and no case. A kind is counted as a reader would count it: a callout over five lines is one callout. `test/panel/syntax/cases.test.ts` checks that every kind a case names is in that file; `harness/tests/syntax.spec.mjs` counts them in Chrome.

`SYNTAX.md`, the syntax reference, is written by `npm run syntax-reference` from the table of optional syntax in `src/panel/syntax/`, the settings in `package.json` and the cases in `test/panel/syntax/cases/` that carry a `reference`, so every example in it is a case the tests run. After changing any of them, run it and commit the new file: CI runs `node scripts/syntax-reference.mjs --check` beside the notices check, and it fails while the file differs. `test/panel/syntax/reference.test.ts` fails until every entry of the table, and every value of a setting with choices, has a marked case.

The browser specs drive the Chrome installed on your machine through `playwright-core`; nothing is downloaded. They are `attacks`, `drawn`, `editing`, `find-paste`, `html`, `links`, `messages`, `outsideMark`, `render`, `sync`, `syntax`, `tables`, and `vscode`. Each exits 0 when every check passes. They press the keys of Windows and Linux (`Control+A`, `Control+End`), which do something else in CodeMirror on a Mac, so run them on Windows or Linux.

The in-VS-Code suite downloads a copy of VS Code into `.vscode-test` the first time. It opens a real window and fails if another window takes the focus, so leave the machine alone while it runs. `npm run itest -- links` runs only the files whose names contain that word. `VSCODE_TEST_VERSION` chooses the version (a number such as `1.120.0`, or `stable`); `TM_ITEST_DIR` chooses where the copy keeps its user data and workspace (the system's temporary folder by default). `TM_ITEST_EXTENSIONS`, a comma-separated list of `.vsix` files or Marketplace ids, installs those into the test copy's own extensions folder first, never into yours. On Linux, run it under `xvfb-run -a`. The run's output is also written to `last-run.log` in that folder, among a good deal of VS Code's own chat and agent logging (lines starting `[AgentHost` or `[ChatModelSelection]`). Before its first test the suite waits until VS Code reports a change in the workspace, which takes some seconds after the window opens.

Beside the extension, the test copy loads a small helper extension, `itest/helper`, which stands in for what other extensions do: it reports problems in markdown documents and offers quick fixes for them, as a spell checker does, declares a stand-in editor whose priority is an object, and declares a notebook that opens some markdown files by itself. The facts files, `itest/suite/facts*.test.ts`, establish what VS Code and other extensions do, such as which editor is active or whether a spell checker reports on a note shown only in a rich view. They are measured once, by hand, and skipped in a run of the whole suite: they run only when a word given to the runner starts with `facts` (`npm run itest -- facts`), and each prints what it saw. `factsSpellChecker.test.ts` needs Code Spell Checker installed through `TM_ITEST_EXTENSIONS`.

## Where each check runs

A check costs something each time it runs and each time it breaks for nothing, so each one runs in one place: the latest and cheapest place that still catches what it guards.

A check runs on every commit only when all three of these hold:

1. **It breaks silently.** A person using the editor would not notice the fault soon: text lost or put in the wrong place, a save that writes the wrong bytes, a build that does not compile.
2. **It is likely to break again.** The code under it changes often, or much else leans on it.
3. **Breaking costs something real.** Lost or misplaced text, a crash, a broken build or package.

Every other check has a later home:

| Home | When it runs | What runs there |
|---|---|---|
| Core | Every commit (`npm run check`), and every push to `main` and every pull request (`.github/workflows/ci.yml`, on Linux) | Formatting, lint, the type check, the core unit tests (20 sync scenarios, 2,000 calibrated simulation seeds, and the merge oracle's seeded cases among them; `vitest.config.ts` lists what else and why), and the checks that `THIRD_PARTY_NOTICES.md` and `SYNTAX.md` match the code |
| Area | When the files a check covers change (`.github/workflows/area.yml`; `npm run specs` while you work) | The panel's unit tests, for a change to `src/panel`, `src/core` or `test/panel`; each browser spec, for the files the table below gives it; the in-VS-Code suite on Linux in the current VS Code, for a change to `src/host`, `src/core`, `src/panel/sync.ts`, `src/panel/testHook.ts`, `src/panel/vscodeBridge.ts` or `itest` |
| Weekly | Every Monday morning UTC (`.github/workflows/weekly-vscode.yml`, or by hand) | The in-VS-Code suite against the current stable VS Code release on Linux, Windows and macOS, to catch upstream VS Code behavior changes early |
| Before a release | By hand, and on a version tag (`.github/workflows/release.yml`, or `npm run release-checks` on one machine) | The unit tests on Linux, Windows and macOS; the in-VS-Code suite on all three, in VS Code 1.120.0 (the floor `engines.vscode` claims) and the current release; the simulation over 20,000 fresh seeds; the merge oracle over 200,000 cases a property from a fresh seed; every browser spec; the package and the list of files it holds |
| Measured once | When the change its row names happens ("Measured once", below) | What was proven in real VS Code windows by driven scripts, and the speed of the panel and the core |
| Nowhere | Never | How the page looks, where a person using the editor would see a fault at once: a color, a size, a line's height, where a mark sits, the order of the toolbar's buttons |

Measured once: the core checks take under a minute the first time, and about 30 s once Prettier's cache holds the files (formatting 2 s then; lint 17 s; the type check 1 s; the core unit tests 9 s for about 1,245 tests, most of it the merge's and the simulation's property runs; the generated files 1 s). In the area home the panel's unit tests take 7 s for about 1,170 tests, and the specs from 9 s to 8 minutes: `links` 9 s, `editing` 10 s, `find-paste` 11 s, `vscode` 12 s, `tables` and `render` 14 s, `html` 23 s, `outsideMark` 32 s, `drawn` 48 s, `sync` 88 s, `attacks` 2.5 minutes, `syntax` 8 minutes. Measure again after a change that adds many checks to a home, or moves one.

A check states the promise a person relies on, never the drawing that keeps it: what the reader sees and what the file holds, not a class name, a count of elements, an exact size or color, or which element sits where. A size the file itself gives is a promise. The syntax cases name what the reader sees by kind, and one module knows how the page draws each kind (above). Nothing is timed: a time is measured once and recorded. A pause waits on the thing it names; a fixed one stays only where the promise is that nothing happens in that time, and its name says so.

A new permanent check is rarely needed: a look from a scratch file usually answers the question, and the look stays in the scratch file. A check added to the core says in its commit message which of the three tests it meets. When a check fails, ask first whether a person using the editor would notice or be harmed. If so, the fault is in the code: fix it and keep the check. If not, the check is in the wrong home or states the drawing: move it, loosen it to its promise, or delete it, in its own commit with the reason. A check of what can lose or misplace text (the simulation, the merge and its oracle, the reconciler's and the save step's scenarios, the session's alignment, the encodings) is never loosened to make it pass. A suite shrinks about as often as it grows: a check whose promise a cheaper check already states, or whose feature is gone, goes.

### Which specs cover which files

`scripts/areas.mjs` holds this table as paths, and the area workflow asks it which checks a change needs. Every spec also runs for a change to its own file, to `harness/checks.mjs`, `harness/pages.mjs` or `harness/serve.mjs`, to the panel's own files (those directly in `src/panel`, `src/panel/render/framework.ts`, `lines.ts`, `damage.ts` and `faults.ts`, and `src/panel/theme`), or to `src/core/protocol.ts` and `featureProtocol.ts`. Every spec and the in-VS-Code suite run for a change to `package.json`, `package-lock.json`, `esbuild.mjs`, `tsconfig.json` or `scripts/areas.mjs`. "The render lab" is `harness/lab.ts` and `lab.html` with the stand-ins they read (`harness/fakes/notes.ts`, `workspace.ts`) and what both pages share: the list of samples they offer (`harness/sampleList.ts`), the theme they are shown in (`harness/theme.ts`), the VS Code theme colors it reads (`harness/themes/themes.json`) and the select their bars are built from (`harness/barSelect.ts`); "the harness page" is `harness/harness.ts`, `index.html`, `fakeHost.ts`, `harness/fakes` and those four.

| Spec | What it checks | Runs for a change to |
|---|---|---|
| `syntax` | Every case in `test/panel/syntax/cases/`; what footnotes, front matter links, task marks, comments, formulas and drawn blocks do | What reads and draws markdown: `src/panel/markdown`, `syntax`, `render`, `html`, `links` and `tables`, and the core's readers (`attributes.ts`, `blockId.ts`, `emojiCodes.ts`, `fileKinds.ts`, `formulas.ts`, `frontmatter.ts`, `htmlElements.ts`, `markdownText.ts`, `outline.ts`, `plainText.ts`, `tableModel.ts`, `wikilinks.ts`, `wordChars.ts`, `words.ts`); the cases; the render lab |
| `render` | Checkboxes, walking through a long code block, a feature that throws | The same as `syntax`, and the lab's samples |
| `attacks` | The attack corpus under the page's content policy | The same as `syntax`, `harness/attacks`, `harness/pictures.mjs`, and the host's policy (`src/host/provider.ts`) |
| `html` | HTML blocks and wrappers, links and pictures written as HTML, picture sizes, players | `src/panel/html`, `src/panel/markdown`, the drawing of HTML, pictures and drawn blocks (`html.ts`, `htmlBlocks.ts`, `htmlDrawing.ts`, `images.ts`, `drawnBlock.ts`, `frame/` in `src/panel/render`), `src/core/htmlElements.ts` and `fileKinds.ts`, `src/host/model/linkAddress.ts`, the kinds (`src/panel/syntax/kinds.ts`), the render lab |
| `drawn` | Diagrams, their frame and their large view, contents lists, embedded notes and git's conflicts, under the page's content policy | `src/panel/markdown`, the drawing of drawn blocks, diagrams, contents lists, embeds, block ids and conflicts, a diagram's large view (`src/panel/ui/diagramView.ts`), `src/core/blockId.ts` and `outline.ts`, `src/host/model`, `src/host/provider.ts`, the kinds, the render lab, the harness page |
| `tables` | Tables and front matter | `src/panel/tables`, `src/panel/markdown`, the drawing of front matter and grid tables, `src/core/frontmatter.ts` and `tableModel.ts`, the kinds, the render lab |
| `links` | Links, wikilinks and pictures opened, followed and reached by key | `src/panel/links`, `complete`, `ui` and `markdown`, the drawing of links, wikilinks, pictures and lists, `src/core/fileKinds.ts`, `wikilinks.ts` and `outline.ts`, `src/host/model`, the harness page |
| `editing` | The commands, the typing rules and the toolbar, each edit read back from the document | `src/panel/commands` and `ui`, the document core, the render lab, the harness page |
| `find-paste` | Find and replace, paste and copy, going to a heading | `src/panel/paste` and `ui`, what writes markdown and places a block (`src/panel/markdown/writing.ts`, `src/panel/commands/placeBlock.ts` and `lineInfo.ts`), `src/core/listText.ts`, `test/panel/paste/fixtures`, the render lab |
| `vscode` | VS Code's problems, quick fixes, rename, suggestions and change marks in the rich views | `src/panel/complete` and `ui`, the drawing of problems and change marks, `src/host/model`, the harness page |
| `messages` | Tab-top message strip rendering, button clicks, keyboard navigation, queue count, and screen-reader announcements | The harness page and `src/panel/ui/messages.ts` |
| `sync` | The real panel against the real core: typing, outside writes, saves and storms, with nothing lost | The document core (in `src/core`: `alignDiff`, `coordinator`, `diff`, `documentGate`, `encoding`, `eol`, `errors`, `hash`, `merge3`, `noticeText`, `positions`, `reconcile`, `safeMerge`, `sequenceDiff`, `session`, `textLines`, `wordChars`), the simulation's stand-ins the page borrows (`test/sync/world.ts`, `test/sync/fakes`), the harness page |
| `outsideMark` | The lines another program changed are the lines marked, and a screen reader is told of them once | The same as `sync`, `src/panel/render/outsideMark.ts`, `src/panel/announce`, and `src/core/fill.ts` and `listText.ts` |

Before you open a pull request, run `npm run check` and `npm run specs`, and `npm run itest` when the change touches the host, the core or a contribution in `package.json`. After a change to the dependencies, `npm run notices` writes the new `THIRD_PARTY_NOTICES.md`: commit it, since the core checks fail while it differs.

## The simulation

`test/sync/scenarios.test.ts` covers 20 explicit real-world sync scenarios, and `test/sync/simulation.test.ts` runs the real document core against stand-ins for VS Code's document, the disk, and panels (`test/sync/world.ts`, `test/sync/fakes/`) calibrated to measured VS Code timings. Every run verifies three invariants: no silent loss of unsaved user typing, no silent loss of settled outside writes outside the save-write gap, and no doubled text or panel/document/disk divergence. `npm test` runs 2,000 seeds. To run more, or trace a specific seed:

```
SIM_FIRST=1 SIM_RUNS=20000 npx vitest run test/sync/simulation.test.ts
SIM_FIRST=2254 SIM_RUNS=1 SIM_TRACE=1 npx vitest run test/sync/simulation.test.ts
```

(In PowerShell, set `$env:SIM_FIRST`, `$env:SIM_RUNS`, and optionally `$env:SIM_TRACE='1'` first.)

When a seed fails, inspect its trace with `SIM_TRACE=1`, fix the root cause in `src/core/reconcile/`, and add a focused scenario to `test/sync/scenarios.test.ts` or `test/core/reconcile/` so it stays guarded cleanly.

The merge has an oracle of its own in `test/core/merge3.test.ts`; `MERGE3_ORACLE_RUNS` sets how many generated cases it runs. Every test that draws cases at random (fast-check) runs from a fixed seed, so `npm test` draws the same cases every time; for a long sweep ask for a fresh one, as in `TEST_SEED=random MERGE3_ORACLE_RUNS=1000000 npx vitest run test/core/merge3.test.ts`. A failure prints its seed and path, and `TEST_SEED=<seed>:<path>`, with `-t` naming the failing test, replays that case at once (`test/random.ts`).

## Measured once

What a standing check would report the same way every time, and what needs real VS Code windows and a real mouse, is measured by hand and recorded here instead of run on every change. When a change could move a row, measure again and update the row.

### Proven in real VS Code windows

Scripts drove a test copy of VS Code on one Windows machine, with the operating system's own pointer and keys, the screen unlocked and the machine otherwise left alone. They are not in the repository: they reach VS Code through fixed paths on that machine, and the pointer through Windows alone.

| What | Result | Measured | Measure again after |
|---|---|---|---|
| The busy file: auto-save every second, eight words typed in bursts into a paragraph while another program appends a line to the file every 0.9 s; the bar is every typed word in its place, every added line once in the document and in the file, and the document saved and equal to the file | Tandem Markdown's editor: 5 of 5 runs met the bar, 80 of 80 lines. VS Code's text editor, the extension installed: 5 of 5, 80 of 80. VS Code's own Markdown Editor, the extension installed: 14 of 20, 338 of 342 lines, the 4 lost all written between VS Code's will-save and its write (`docs/ARCHITECTURE.md`, "Limits"); in two later blocks of that editor alone, 26 of 30 runs, 502 of 510 lines | 2026-11-15, VS Code 1.146.0, Windows (pre-release soak runs) | A change to the save step (`src/core/documentGate.ts`, `reconcile/reconciler.ts`, `reconcile/saveWatch.ts`), to how the host reads the disk or holds an outside change (`src/host/model/outsideHold.ts`), or a VS Code release that changes how it saves |
| The last word: a word typed in the Rich editor, then its tab closed by a real mouse click 100 ms after the last key, inside the typing pause, VS Code's question to save answered Save; twenty times, each in a fresh file | 20 of 20 words reached the file, in VS Code 1.146.0 and in 1.120.0 | 2026-11-15, Windows | A change to when the panel sends its typing (`src/panel/sync.ts`) or to closing (`docs/ARCHITECTURE.md`, "Closing"), or a VS Code release that changes how a webview is closed |

### Speed

A time taken on a busy or slow machine varies too much to fail a build on, so speed is measured, never checked. The scripts are in `scripts/speed/`; each builds what it needs and works on made-up notes from `scripts/speed/note.mjs`, with every default syntax on. When a change could move a number, run its script and update the row.

Every result below was measured on a machine busy with other jobs, so it is higher than the same code measures on an idle one. To tell a slower change from a busier machine, measure the commit before the change beside it, in turns. Where a bar is a number, a result over it is a fault, brought to the maintainer with its measurement; no bar is loosened to let a change pass.

| What | Script | Result | Bar | Measure again after |
|---|---|---|---|---|
| A typed letter, from the key to the frame that shows it, in the middle of a note (the harness page in headless Chrome, whose own status line adds about 2.5 ms a letter at 1 MB) | `typing.mjs` | 100 KB: 19.5 ms median, 29 ms at the 95th percentile. 1 MB: 27.1 ms median, 85 ms at the 95th percentile | From the key to the frame: at 100 KB, 19.5 ms median and 29 ms at the 95th percentile; at 1 MB, 27.1 ms and 85 ms. The panel's own update for a letter under 16 ms, so the letter shows in the next frame or the one after; it is 6.5 ms at 100 KB and 13.0 ms at 1 MB | A change to what runs on every keystroke in the panel: a drawing feature, `src/panel/render/framework.ts`, `lines.ts` or `damage.ts`, the parser's extensions, the toolbar, `src/panel/sync.ts` |
| Enter at the end of a 2 MB note that ends in a list, from the key to the frame that shows the new item, pressed a while after the cursor reaches the end (the harness page in headless Chrome) | `enter.mjs` | At once: 1,364 ms, of which 368 ms applying and drawing the edit (block features 223 to 249 ms: tables 83, lists 49, front matter 26, the rest under 15 each). After 1 s: 899 ms. After 2 s: 453 ms. After 4 s: 64 ms. The second Enter, at once: 89 ms | The list goes on every time, whatever the wait; pressed at once, 1.4 s; once the parse has reached the cursor, under 100 ms | A change to `treeFor` or to what a command parses, the parser's extensions, `src/panel/render/framework.ts`, `lines.ts` or `damage.ts`, `src/panel/render/lists.ts` |
| A rich view scrolled through a 1 MB note, 40 px a frame for 300 frames: alone, linked with nothing following, and with a second rich view following it | `follow.mjs` | 16.7 ms median frame all three ways; frames over 25 ms: 6 to 9 of 300 alone and linked, 13 to 15 with a follower in a second browser process; scroll handling 0.5 ms an event alone and linked, 1.1 to 1.3 ms with a follower | A median frame of 16.7 ms, one screen refresh, alone, linked and with a follower; the leader scrolls as smoothly linked as alone; nothing is posted and no page listens while no note is linked and visible twice | A change to `src/host/scrollSync.ts`, `src/panel/scrollFollow.ts` or what a page does on scroll |
| Opening a 2 MB note with a thousand reference links at the top and their definitions at the end, and a letter typed among the links; with `--inline`, a thousand inline links and one definition at the end (the harness page in headless Chrome) | `definitions.mjs` | Reference links: drawn as links in the first frame, 465 to 488 ms after the open began; a typed letter 20.6 ms median from the key to the frame, the panel's own update 7.2 ms. Inline links: the first frame at 252 to 263 ms; a typed letter 18.0 ms median, the panel's own update 5.8 ms | Links drawn as links in the first frame; no reading past the parse for a first frame whose links need none; a typed letter as in a note whose definitions are parsed | A change to `src/panel/links/farDefinitions.ts`, `read.ts` or `footnotes.ts`, or to the parser's block extensions, or to what reads definitions in `src/panel/render/` (links, images, contents, footnotes, abbreviations) |
| Checking a push of one typed character, 2 MB note (`preparePush`) | `core.mjs` | 0.047 ms of CPU (0.027 ms median) | Under 1 ms | A change to `src/core/session.ts` or `src/core/hash.ts` |
| One typed character from the panel's push to the panel holding the confirmed text, 2 MB note, the panel's side included | `core.mjs` | 28.8 ms of CPU (27.1 ms median) | Under 50 ms of CPU, the length a browser calls a long task | A change to the core's handling of a push, the stamp, or `src/panel/sync.ts` |
| One line written by another program, merged into an unsaved 2 MB note | `core.mjs` | 107 ms of CPU (95 ms median) | Under 150 ms of CPU on an idle machine | A change to `src/core/merge3.ts`, `safeMerge.ts`, `reconcile/decide.ts`, or `reconcile/reconciler.ts` |
| A note opening in a rich view in VS Code, to its first text on screen: a long note (100 KB) and a very long one (1 MB) | By hand, in VS Code | 0.50 and 0.47 s for the long note; 0.63 s for the very long one, one opening each | 0.5 s for the long note; 0.63 s for the very long one | A change to the panel's start (`src/panel/boot.ts`, `main.ts`), to what draws the first frame, or to what the host sends a new panel |
| Another program's change appearing in a rich view of a small note with nothing unsaved, from the write to the frame | By hand, in VS Code | About 0.13 s | 0.13 s | A change to how the host watches and reads the file (`src/core/reconcile/reconciler.ts`, `disk.ts`), or to how a note with nothing unsaved follows it |
| Script the page loads before the panel can take a document | `bundle.mjs` | 999,884 bytes in 14 chunks; 1,201,911 bytes with the stylesheets and the icon font | No library that only some notes need | A new import on the panel's start path, a new drawing feature, a new dependency |
| What loads only when a note needs it | `bundle.mjs` | KaTeX 268,443 bytes of script, and up to 284,585 bytes of its stylesheet and fonts; DOMPurify 35,193; `yaml` 103,782; Mermaid's frame 5,385,683; code block grammars and smaller parts, 118 imports, 1,214,591 | Each loads on the first note that needs it, never at start | The same |

## How the code is laid out

- **Layers.** `src/core` imports nothing outside itself: no `vscode`, no DOM. `src/host` and `src/panel` import the core, never each other. `src/panel` never imports `vscode`. `src/host/model` holds the host's modules that do not need VS Code, and must not import it. Nothing in `src` imports from `test`, `itest` or `harness`. `npm run lint` enforces all of it.
- **Text.** Everything in the core and the panel works on LF text and LF offsets. Never compute a VS Code position by counting in `document.getText()`, which may hold `\r\n`.
- **Edits.** Nothing in the host edits a document except through the core (`docs/ARCHITECTURE.md`, "The document core").
- **The panel.** Build DOM with `createElement` and `textContent`, never `innerHTML`, and never set a `style` attribute: the page runs under a strict content policy, and text from a document or the clipboard can be anything.
- **Adding a drawing feature.** One new file in `src/panel/render`, exporting a `Feature`, listed in `src/panel/features.ts`. `docs/ARCHITECTURE.md`, "Drawing", has a worked example of each kind of feature and the rule a block feature must keep. A panel command belongs to the feature that provides it, in its `commands`.
- **Tests** mirror the source: `test/core` for `src/core`, `test/host` for `src/host`, `test/panel` for `src/panel`, `test/sync` for the simulation. Code that needs a browser is tested through `harness/`, and code that needs VS Code in `itest/`.

## Comments

Comments are part of the code and are reviewed as such. The standard:

1. A comment says what the code does or why it must be so, in the present tense. It never says how the code came to be: no history, dates, names, ticket numbers, no "found by", "now", "no longer", "used to", "previously", "after the fix".
2. A file starts with a header of at most 12 lines (a license notice not counted): what the file holds, and what a reader must know before changing it. Anything longer goes in `docs/ARCHITECTURE.md`, and the header names the section.
3. An exported function, class or type gets a doc comment when its name and signature do not already say it. One to three lines. State the contract (units, coordinates, what null means, what must never happen), not the steps.
4. An inline comment is for what the code cannot say: an invariant, an ordering that matters, a quirk of the platform (name the product and version: "VS Code 1.146 reports..."), a deliberate omission. Never the line below it in other words.
5. Never write a number that a named constant holds. Name the constant. The reason for the number goes on the constant, once.
6. Refer to code by identifier and to files by path. Never refer to a document that is not in the repository.
7. One divider style: a line of 75 dashes, then `// Title`. Never inside a function.
8. Third-party code carries its license notice where it is used, and one sentence saying what was taken. It also gets an entry in `ADAPTED` in `scripts/third-party.mjs`, so `THIRD_PARTY_NOTICES.md` lists it.
9. A test title is one sentence that states what is promised, under 100 characters, with no ids. The reason a case exists goes in a comment above it only if the title cannot carry it.
10. Use the standard word where one exists: "the user", "insert", "delete", "retry". A word the project coins (base, candidate, reveal, push, resync) is defined once, in the glossary of `docs/ARCHITECTURE.md`.

Do not add `@param` or `@returns` tags: a sentence says more.

## Reporting a bug

Use the bug report form. Start by running **"Tandem Markdown: Copy Diagnostics"** from the Command Palette (copies VS Code, OS, and extension versions, active settings, and redacted log entries with no note text). A report about text that was lost, doubled or put in the wrong place is the most important kind, and it can only be worked on with specifics:

- the output of "Tandem Markdown: Copy Diagnostics";
- the file's line endings and encoding (both in the status bar while the file is open in Source);
- which view you were in, and whether the file was open in more than one tab;
- whether another program was writing the file (git, a sync tool, another editor, an AI tool), and roughly when;
- what "Tandem Markdown: Verify File" says;
- the steps, as exactly as you can give them, and what you expected.

Security problems go through the private route in `SECURITY.md`, not an issue.

## Pull requests

Keep a pull request to one change. Say what it changes and why, which checks you ran, and whether it touches `src/core`. Format with `npm run format`. New dependencies need a reason: everything the panel imports ships in the bundle.
