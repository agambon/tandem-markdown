// When git explains another program's write to a note (gitExplains.ts): the file's new text is
// the file at HEAD, and HEAD's commit was made before the write reached the file. An agent that
// writes and then commits its own write is not explained. Git gives a commit's date to the
// second, so a commit in the same second as the write cannot be told to be earlier: it counts as
// later, and the part is written.

import { toLf } from '../../core/eol';

/** HEAD's commit (its date, when git gives one) was made before the write at `writtenAt` (ms). */
export function committedBefore(commitDate: Date | undefined, writtenAt: number): boolean {
  if (commitDate === undefined || Number.isNaN(commitDate.getTime())) return false;
  return Math.floor(commitDate.getTime() / 1000) < Math.floor(writtenAt / 1000);
}

/** The same text, whatever its line endings (git may hold LF where the file has CRLF). */
export function sameText(a: string, b: string): boolean {
  return toLf(a) === toLf(b);
}
