# Roadmap

What Tandem Markdown is working toward for **1.0**, what is being considered afterward, and what is not planned, each with the reason. What it draws today is in the [syntax reference](SYNTAX.md), and what it does is in the [README](README.md). Nothing here has a date.

Two rules hold for everything below. Every syntax beyond standard markdown and GitHub's gets a setting, because each can misfire on ordinary text (two prices read as math, a color code read as a tag). And how a file is drawn never changes the file: a misreading is only ever on screen.

## Completed in 0.1

- **Three views in one tab:** Source, Rich editor, and Rich view (read-only), switching with `Alt+M` (`Ctrl+Cmd+M` on Mac) while keeping cursor, scroll position, and shared undo history.
- **Live outside-change merging and agent handoff:** automatic three-way merges over unsaved typing, outside-change line outlines, tab-top undo/recovery strip with a dedicated waiting-message indicator, diff title-bar choices (`Use Change from Disk`, `Replace My View`), 30-day automatic backups, and `.conflict` handoff files with one-click agent instructions for `AGENTS.md` and Claude Code.
- **Broad native markdown support:** CommonMark, GitHub Flavored Markdown, Obsidian wikilinks/callouts/embeds/comments/tags, KaTeX math, zoomable Mermaid diagrams, Pandoc/MkDocs boxes and grid tables (with interactive checkboxes), HTML blocks and folding `<details>`, and git merge conflict markers.
- **Daily-driver writing and VS Code integration:** `/` insert menu, cell-by-cell table editing, rich copy/paste, heading section folding, Explorer outline with drag-to-reorder, interactive click-to-peek/revert git change marks, spell-check and lint diagnostics with quick fixes, `F2` rename, scroll sync, remembered scroll positions, `Copy Diagnostics`, and `hideBuiltInPreviewButtons`.

## Toward 1.0

- **Cross-platform verification on macOS, Linux, WSL, and Remote SSH:** full real-world validation of keybindings, case-sensitive filesystems, OS file-watcher timing, remote latency, and backup paths, backed by automated multi-OS CI tracking weekly VS Code releases.
- **Real-world soak testing across agents and sync tools:** sustained live editing alongside Claude Code, Codex, Cursor, Copilot, git workflows, and file sync tools (such as Dropbox, Syncthing, or OneDrive), plus real-world copy/paste verification from Google Docs and Microsoft Word.
- **Wider spell-check and lint extension testing:** Code Spell Checker is verified in rich-only tabs; additional popular extensions (such as LTeX, LanguageTool, and markdownlint) will be tested, with any gaps closed or documented.
- **Opening search results and line links at the requested line:** VS Code does not yet pass a requested line number to custom editors (Microsoft issue 289785). An API for this has been in testing since VS Code 1.142; Tandem Markdown will adopt it as soon as it is available to published extensions.
- **Dev Containers and Live Share verification:** smoke-tested for remote authority paths and shared sessions.

## Post-1.0 / Being Considered

- **Optional Vim mode in the rich views (`tandemMarkdown.vimMode`).** VS Code's Vim extension cannot reach inside a webview; CodeMirror provides a native Vim mode (`@replit/codemirror-vim`) that can be offered behind an off-by-default setting after 1.0.
- **Live co-editing with a person, as in Google Docs.** Today a colleague's changes arrive when their copy of the file reaches yours through git, a sync tool, or a shared folder. Keystroke-by-keystroke co-editing requires a live session protocol between editors rather than file sync.
- **VS Code for the Web** (`vscode.dev`, `github.dev`). The host layer targets desktop VS Code; a web build is a separate host target.
- **Graphviz, WaveDrom, and Vega diagrams.** Each runs in a browser, but carries a large library for a niche need.

## Not Planned

- **Export and print.** Other tools already turn markdown into PDF and HTML.
- **Joining hard-wrapped lines into flowing paragraphs.** The display would no longer be faithful to the file's own lines, which is what this editor edits.
- **Citations** (`[@smith2020]`). They need a bibliography file and a citation processor.
- **Diagram languages that need Java or a server** (PlantUML, Kroki, D2). A view of a file should not depend on another program or a network service.
- **Template tags, shortcodes, MDX components, and code that runs** (`{{ page.title }}`, `{{< figure >}}`, code cells). They are instructions to another program and are shown as written, where they stay readable and editable.
- **Queries over a folder of notes** (Dataview, Obsidian's `query` blocks, Logseq's queries). Each is a small program in its tool's own language.
- **Including other files** (`@import`, `::include`, `--8<--`). The text is copied in when a site is built; showing it would show a page that is not in the file.
- **Look-ups in a host's database** (issue numbers, mentions, Joplin's attachment ids, `[[_TOSP_]]`). A file on disk does not hold the answers.
- **Embedded PDFs shown in place** (`![[doc.pdf#page=3]]`, Obsidian). The embed stays a link to the file rather than bundling a multi-megabyte PDF engine.
- **Maps and 3D models** (GitHub's `geojson`, `topojson`, and `stl` blocks). They need map tiles from a server or a 3D engine.
- **A spell checker of its own.** Spell-check extensions already check the document, and their diagnostics show in the rich views.
- **A menu that pops up over selected text.** The toolbar stays in view and every format has a shortcut, so it would duplicate the same actions.
- **Git blame.** VS Code's own blame and extensions such as GitLens show it in Source.
- **Color themes of its own.** The rich views inherit VS Code's theme colors; font family, size, line height, and column width have settings.
- **VS Code's own snippets in the rich views.** VS Code offers extensions no API to read the user's snippets.
- **Agent comments, an editable rich diff, and VS Code's own Outline view and breadcrumbs.** They rest on interfaces VS Code reserves for built-in extensions. Tandem Markdown provides its own Explorer outline, native text diffs, and `Review in Source`.
- **A companion plugin for AI agents.** Handoff stays file-based (`.conflict` files, `AGENTS.md`, and `.claude/rules/tandem-markdown.md`).
