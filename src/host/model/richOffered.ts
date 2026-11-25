// Which documents the rich views are offered for: markdown (by its language, or by a `.md` or
// `.markdown` name), `.txt` files, and untitled documents in markdown or plain text; never a
// conflict file (model/conflictName.ts), whatever its language. Each opens
// in Source unless the user asks for a rich view: the custom editor's priority is "option".
// The `when` clauses of the view commands in package.json say the same, which
// test/host/model/richOffered.test.ts holds them to.

import { isMarkdownPath } from '../../core/fileKinds';
import { isConflictName } from './conflictName';

const TEXT_EXT = /\.txt$/i;

/** A `.txt` file's name. */
export function isTextFileName(path: string): boolean {
  return TEXT_EXT.test(path);
}

/** What `richOffered` reads of a document: its uri's scheme and path, and its language when it is open. */
interface DocumentKind {
  scheme: string;
  path: string;
  languageId?: string | undefined;
}

export function richOffered(d: DocumentKind): boolean {
  if (isConflictName(d.path)) return false;
  if (d.languageId === 'markdown' || isMarkdownPath(d.path) || isTextFileName(d.path)) return true;
  return d.scheme === 'untitled' && d.languageId === 'plaintext';
}
