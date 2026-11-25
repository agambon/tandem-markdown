# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on this repository's Security tab, choose "Report a vulnerability". Include what an attacker controls (a file's content, a file name, a workspace setting, the clipboard), what they gain, and the steps to reproduce it with the smallest file that shows it.

Only the latest release is supported.

## Scope

The panel that draws Rich view and Rich editor is a webview under a content policy with `default-src 'none'`: scripts and styles load only with a nonce made for each page or from the webview's own resource origin, which serves the extension, the workspace folders and the note's folder; images load from that origin, `https:` and `data:`, and video and sound from that origin and `https:`. There is no `unsafe-inline`. HTML in a document reaches the page through one sanitizer only (DOMPurify, held to GitHub's allow-list): it is parsed in a detached document and inserted as nodes, and in a workspace VS Code does not trust it is shown as text. Nothing from the clipboard is inserted into the page as HTML. Mermaid draws diagrams in a sandboxed frame with no access to the page, and the page shows each diagram as a picture.

The extension host reads a workspace file at a panel's request only after path checks: a note shown in a preview or embedded in another must be a markdown file inside a workspace folder, reached through no symbolic link or junction, and a picture, video or sound file must lie inside a workspace folder or the note's own folder. Links to network shares and links with any scheme but `http`, `https`, `mailto` and `file` are not opened.

The extension writes only these files: backups of outside versions, in its own storage folder; a conflict file beside a note (the note's name with `.conflict` added) while `tandemMarkdown.conflictFiles` is on; pasted images, beside the note or where `markdown.copyFiles.destination` says; the record of a fault, in its own log folder; and, when the user presses the button of Add Agent Instructions, `AGENTS.md` and `.claude/rules/tandem-markdown.md`. Two commands, "Use Tandem Markdown by Default" and "Use Source by Default", write the user's `workbench.editorAssociations` and `workbench.diffEditorAssociations` settings after asking. It runs no code from the workspace, which is why it is allowed in Restricted Mode.
