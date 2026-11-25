// Markdown as HTML for the clipboard, so a copy pastes formatted into other programs. Loaded
// when a copy becomes likely (paste/copy.ts), so markdown-it is not part of what the panel loads
// to start.

import MarkdownIt from 'markdown-it';

let renderer: InstanceType<typeof MarkdownIt> | null = null;

/** Markdown as HTML for other programs. Raw HTML in it is escaped (markdown-it's `html: false`). */
export function markdownToHtml(markdown: string): string {
  renderer ??= new MarkdownIt({ html: false, linkify: true, typographer: false });
  return renderer.render(markdown);
}
