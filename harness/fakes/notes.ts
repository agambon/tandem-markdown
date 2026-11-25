// Made-up notes for embeds, with the answers the host would give an `embedNotes` request for
// them, by the host's own rules for what part of a note an embed shows
// (src/host/model/noteSection.ts) and for its title. Used by the harness page's fake host
// (harness/fakes/embeds.ts) and by the render lab, which has no host.

import { buildOutline } from '../../src/core/outline';
import { parseWikilink } from '../../src/core/wikilinks';
import { FolderIndex } from '../../src/host/model/folderIndex';
import { outlineHas } from '../../src/host/model/headingAnchors';
import { notePreviewOf } from '../../src/host/model/notePreviewText';
import { notePart } from '../../src/host/model/noteSection';

/** The made-up notes an embed can show, by folder-relative path. */
export const NOTES = new Map<string, string>([
  [
    'notes/Other note.md',
    [
      '---',
      'title: Other',
      '---',
      '# Other note',
      '',
      'The first paragraph of the other note, with [a link](https://example.com/).',
      '',
      '## Part two',
      '',
      'A line to quote. ^quote-1',
      '',
      '- one',
      '- two ^item-2',
      '',
      '## Part three',
      '',
      'The end of the other note.',
      '',
    ].join('\n'),
  ],
  // A note beside the folder of the same name, with a heading named as a note in that folder is.
  ['notes/Folder.md', '# Folder\n\n## Topic\n\nThe topic, as a heading of this note.\n'],
  [
    'notes/Folder/Topic.md',
    '# Topic\n\nKeys <kbd>Ctrl</kbd> and math $x^2$ in the topic.\n\n![[Other note#Part two]]\n',
  ],
  // Notes embedded in each other in folders of their own, each with a picture addressed from its own folder.
  ['notes/deep/Deep one.md', '# Deep one\n\n![](img/one.png)\n\n![[Deep two]]\n'],
  ['notes/deep/two/Deep two.md', '# Deep two\n\n![](../img/one.png)\n\n![[Deep three]]\n'],
  ['notes/deep/two/three/Deep three.md', '# Deep three\n\n![](three.png) and [[Other note#Part two]]\n'],
  ['notes/Chain 1.md', '# Chain 1\n\n![[Chain 2]]\n'],
  ['notes/Chain 2.md', '# Chain 2\n\n![[Chain 3]]\n'],
  ['notes/Chain 3.md', '# Chain 3\n\n![[Chain 4]]\n'],
  ['notes/Chain 4.md', '# Chain 4\n\nThe bottom of the chain.\n'],
  ['notes/Self.md', '# Self\n\nA note that embeds itself.\n\n![[Self]]\n'],
]);

let index = new FolderIndex([...NOTES.keys()]);

/** Changes, adds or (with null) removes a note. */
export function changeNote(path: string, text: string | null): void {
  if (text === null) NOTES.delete(path);
  else NOTES.set(path, text);
  index = new FolderIndex([...NOTES.keys()]);
}

/** Whether the made-up note at `path` has the heading a link's `#heading` part names, found as the host finds it. */
export function noteHasHeading(path: string, heading: string): Promise<boolean> {
  const lf = NOTES.get(path);
  return Promise.resolve(lf !== undefined && outlineHas(buildOutline(lf), heading));
}

/** What the host answers about the embed `target` in the note at `from` (folder-relative). */
function embedAnswer(target: string, from: string): unknown {
  const link = parseWikilink(target);
  const name = link.target;
  const path = index.resolve(name, from).path;
  const lf = path ? NOTES.get(path) : undefined;
  if (!path || lf === undefined) return { reason: `No note named “${name}” in this workspace.` };
  const part = notePart(lf, link.heading);
  if ('missing' in part) return { reason: `No ${part.missing} “${link.heading}” in “${name}”.` };
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  return { path, title: notePreviewOf(lf, fileName).title, text: part.text };
}

/** The answers to an `embedNotes` request's `targets`, for the note at `from`. */
export function embedAnswers(targets: unknown, from: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of Array.isArray(targets) ? targets : []) if (typeof t === 'string') out[t] = embedAnswer(t, from);
  return out;
}
