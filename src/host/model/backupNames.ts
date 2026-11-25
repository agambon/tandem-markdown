// The names of backup files, which say whose text each one holds, so that the user or an agent
// looking in the folder can find both texts of a choice and tell them apart. backups.ts writes
// and lists the files.
//
//   <note name> (<what it holds>) <yyyy-MM-dd HH.mm.ss> <hex of a hash of the note's address>.md
//
// with " 2", " 3" ... before `.md` when two are written for one note in the same second. A long
// note name is cut to keep the whole name within BACKUP_NAME_MAX, under the 255 characters NTFS
// and most other file systems allow.

import type { BackupLabel } from '../../core/reconcile/types';
import { localTime } from './timestamp';

export const BACKUP_NAME_MAX = 200;

/** How many names are tried for one backup, its number counting up from 1, before giving up. */
export const NAMES_TRIED = 1000;

/**
 * What a backup holds: the other program's version, a copy of the user's text, an older text
 * a program put back, a cut version, or a copy of the file on disk (no program is known: the note
 * opened with unsaved text).
 */
export type BackupKind = 'theirs' | 'yours' | 'older' | 'cut' | 'disk';

/** Each kind as its name and the list say it, as the messages say it. */
export const KIND_WORDS: Record<BackupKind, string> = {
  theirs: "other program's version",
  yours: 'copy of your text',
  older: 'older text',
  cut: 'cut version',
  disk: 'file on disk',
};

/**
 * What a backup holds, from the label the core gives when it asks for one: `yours` is the
 * user's text, and so is `beforeRemoval`, the copy kept quietly before a change that deleted
 * saved text went in with nothing said; `older` a text the file held before one of their saves
 * that a program put back, `cut` the file found cut short at a save, `unknownBase` the file on
 * disk when the note opened with unsaved text, `fileOnDisk` the file on disk whose text an Undo
 * deletes after VS Code reloaded it; every other label, another program's version.
 */
export function kindOfLabel(label: BackupLabel | undefined): BackupKind {
  switch (label) {
    case 'yours':
    case 'beforeRemoval':
      return 'yours';
    case 'cut':
      return 'cut';
    case 'unknownBase':
    case 'fileOnDisk':
      return 'disk';
    default:
      return 'theirs';
  }
}

/**
 * A backup kept with nothing said: listed with the others, but never showing the backups button,
 * since no message told the user of it.
 */
export function isQuietLabel(label: BackupLabel | undefined): boolean {
  return label === 'beforeRemoval';
}

/** `yyyy-MM-dd HH.mm.ss` in local time: the time a backup's name gives. */
export function backupStamp(date: Date): string {
  const t = localTime(date);
  return `${t.year}-${t.month}-${t.day} ${t.hours}.${t.minutes}.${t.seconds}`;
}

/** The length of a backup's tag: hex characters of a hash of the note's address (backups.ts, `pathTag`). */
export const TAG_LENGTH = 6;

const LONGEST_KIND = Object.values(KIND_WORDS).reduce((a, b) => (b.length > a.length ? b : a));
const LAST_NUMBER = NAMES_TRIED - 1;
/** The longest suffix a name adds after the note stem: ` (<longest kind>) <stamp> <tag> <LAST_NUMBER>.md`. */
const SUFFIX_MAX = ` (${LONGEST_KIND}) ${backupStamp(new Date(0))} ${'0'.repeat(TAG_LENGTH)} ${LAST_NUMBER}.md`.length;

/** The backup's file name. `stamp` is from backupStamp; `n` is 1 for the first try in a second, then 2, 3 ... */
export function backupName(fileName: string, kind: BackupKind, tag: string, stamp: string, n: number): string {
  const stem = `${shortName(safeName(fileName), BACKUP_NAME_MAX - SUFFIX_MAX)} (${KIND_WORDS[kind]}) ${stamp} ${tag}`;
  return n === 1 ? `${stem}.md` : `${stem} ${n}.md`;
}

export interface BackupNameParts {
  note: string;
  kind: BackupKind;
  tag: string;
}

const KIND_OF_WORDS = new Map(Object.entries(KIND_WORDS).map(([kind, words]) => [words, kind as BackupKind]));
const NAMED = new RegExp(
  String.raw`^(.+) \(([^()]+)\) (\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d) ([0-9a-f]{${TAG_LENGTH}})(?: (\d+))?\.md$`,
);

function readWholeName(name: string): (BackupNameParts & { stamp: string; n: number }) | null {
  const named = NAMED.exec(name);
  const kind = named ? KIND_OF_WORDS.get(named[2]!) : undefined;
  if (!named || !kind) return null;
  return { note: named[1]!, kind, tag: named[4]!, stamp: named[3]!, n: named[5] ? Number(named[5]) : 1 };
}

export function readBackupName(name: string): BackupNameParts | null {
  const whole = readWholeName(name);
  return whole && { note: whole.note, kind: whole.kind, tag: whole.tag };
}

/**
 * The name the backup named `name` takes once its note is `fileName`, at the address whose tag
 * is `tag`: the same kind and time, and number `n`, its own when not given. Null for a file not
 * named as a backup.
 */
export function renamedBackupName(name: string, fileName: string, tag: string, n?: number): string | null {
  const whole = readWholeName(name);
  return whole && backupName(fileName, whole.kind, tag, whole.stamp, n ?? whole.n);
}

/** A file name safe on every file system (the name comes from the document, which can be anything). */
function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'untitled';
}

/** At most `max` UTF-16 code units, never cutting a character in two, and not ending in a dot or a space (Windows drops those). */
function shortName(name: string, max: number): string {
  if (name.length <= max) return name;
  let end = max;
  const last = name.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // the first half of a pair: leave the pair out
  return name.slice(0, end).replace(/[. ]+$/, '') || 'untitled';
}
