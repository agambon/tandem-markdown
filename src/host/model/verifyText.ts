// Verify File's comparisons and its one message. verify.ts gathers the texts and shows what
// this says. A message that something differs says only what differs.

import { diffChanges } from '../../core/diff';
import { fill } from './templates';

/**
 * The words of Verify File's message, by what was compared and how it came out, and of the button
 * it adds where the tab differs. «name» is the note's name, as the tab shows it. Where the file on
 * disk was not compared, `tabShows` comes before the reason when Verify File ran from a rich tab.
 */
export const VERIFY_WORDS = {
  bothMatch: 'This tab shows your text exactly, and the file on disk matches it.',
  fileMatches: 'Your text matches the file on disk exactly.',
  tabShows: 'This tab shows your text exactly.',
  tabDiffers: "This tab doesn't show your text exactly. Source does, and that is what will be saved.",
  fileDiffers: "The file on disk doesn't match your text, though you have no unsaved changes.",
  bothDiffer:
    "This tab doesn't show your text exactly, and the file on disk doesn't match it either. Source shows what will be saved.",
  notCompared: {
    unsaved: "You have unsaved changes, so the file on disk wasn't compared.",
    noFile: '«name» has never been saved, so there is no file on disk to compare.',
    unreadable: "Tandem Markdown can't read «name» on disk, so it wasn't compared.",
    encoding: "The file on disk isn't readable as UTF-8 or UTF-16, so it wasn't compared.",
  },
  reloadTab: 'Reload tab',
} as const;

/** Two texts compared: the same, or how many characters differ (for the log). */
export type Compared = { kind: 'same' } | { kind: 'differ'; characters: number };

/** Why the file on disk was not compared. */
export type FileSkipped = 'unsaved' | 'noFile' | 'unreadable' | 'encoding';

interface VerifyFacts {
  /** The note's name, as the tab shows it. */
  name: string;
  /** The rich tab Verify File ran from against your text; null when it ran from Source. */
  tab: Compared | null;
  /** Your text against the file on disk, or why the file was not compared. */
  file: Compared | FileSkipped;
}

/** What Verify File says, and what it offers. */
export interface VerifyMessage {
  /** Everything that was compared agreed (a comparison that could not be made is not a disagreement). */
  agree: boolean;
  text: string;
  /** The rich tab does not show your text. */
  tabDiffers: boolean;
  /** The file on disk does not hold your text. */
  fileDiffers: boolean;
}

/**
 * The two LF texts compared. "How many characters differ" is the size of each changed stretch
 * (the longer of what one side has there and what the other has), added up: a typo is one
 * character, a missing word its length.
 */
export function compareTexts(a: string, b: string): Compared {
  if (a === b) return { kind: 'same' };
  let characters = 0;
  for (const c of diffChanges(a, b)) characters += Math.max(c.to - c.from, c.insert.length);
  return { kind: 'differ', characters: Math.max(1, characters) };
}

/** The message Verify File shows. "This tab" opens a sentence only when it ran from a rich tab. */
export function verifyMessage(facts: VerifyFacts): VerifyMessage {
  const { name, tab, file } = facts;
  const tabDiffers = tab !== null && tab.kind === 'differ';
  const fileDiffers = typeof file === 'object' && file.kind === 'differ';
  const result = (text: string): VerifyMessage => ({
    agree: !tabDiffers && !fileDiffers,
    text,
    tabDiffers,
    fileDiffers,
  });

  if (tabDiffers && fileDiffers) return result(VERIFY_WORDS.bothDiffer);
  if (tabDiffers) return result(VERIFY_WORDS.tabDiffers);
  if (fileDiffers) return result(VERIFY_WORDS.fileDiffers);
  if (typeof file === 'object') return result(tab ? VERIFY_WORDS.bothMatch : VERIFY_WORDS.fileMatches);
  const why = fill(VERIFY_WORDS.notCompared[file], { name });
  return result(tab ? `${VERIFY_WORDS.tabShows} ${why}` : why);
}
