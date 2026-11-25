// The open parts of one note's conflict file, and how each event changes them, without VS Code:
// conflictFiles.ts keeps one of these per note, conflictFileWriter.ts writes the file from it and
// conflictViews.ts shows its warnings and count.

import type { Part, PartFacts, ProblemSpot } from './conflictFile';

export interface StoredPart {
  part: Part;
  noticeId: string | null;
  problems: ProblemSpot[];
  /** Backup path named in the part (never pruned while this part stays open). */
  backup?: string | null;
}

export interface NoteFile {
  note: string;
  nextNumber: number;
  parts: StoredPart[];
  closedAt: string | null;
}

export function samePart(a: StoredPart, b: StoredPart): boolean {
  return a.noticeId === b.noticeId && a.part.n === b.part.n;
}

export type NotWritten = 'notAFile' | 'conflictFile' | 'settingOff' | 'noFolder';

export function notWritten(note: {
  scheme: string;
  isConflictFile: boolean;
  enabled: boolean;
  inFolder: boolean;
}): NotWritten | null {
  if (note.scheme !== 'file') return 'notAFile';
  if (note.isConflictFile) return 'conflictFile';
  if (!note.enabled) return 'settingOff';
  if (!note.inFolder) return 'noFolder';
  return null;
}

export function withPart(
  file: NoteFile | undefined,
  note: string,
  add: { noticeId: string | null; facts: PartFacts; problems: ProblemSpot[]; backup?: string | null },
  time: string,
  noteClosed: boolean,
): NoteFile {
  const now = file ?? { note, nextNumber: 1, parts: [], closedAt: null };
  const stored: StoredPart = {
    part: { n: now.nextNumber, time, facts: add.facts },
    noticeId: add.noticeId,
    problems: add.problems,
    ...(add.backup ? { backup: add.backup } : {}),
  };
  return {
    ...now,
    nextNumber: now.nextNumber + 1,
    parts: [...now.parts, stored],
    closedAt: noteClosed ? (now.closedAt ?? time) : now.closedAt,
  };
}

export function withPartAgain(file: NoteFile | undefined, note: string, stored: StoredPart): NoteFile {
  const now = file ?? { note, nextNumber: 1, parts: [], closedAt: null };
  return {
    ...now,
    nextNumber: now.nextNumber + 1,
    parts: [...now.parts, { ...stored, part: { ...stored.part, n: now.nextNumber } }],
  };
}

export function settled(file: NoteFile, noticeId: string): { next: NoteFile | null; stored: StoredPart } | null {
  const stored = file.parts.find((p) => p.noticeId === noticeId);
  if (!stored) return null;
  const parts = file.parts.filter((p) => !samePart(p, stored));
  return { next: parts.length === 0 ? null : { ...file, parts }, stored };
}

export function closed(file: NoteFile, time: string): NoteFile {
  return { ...file, closedAt: time };
}

export function reopened(file: NoteFile): NoteFile {
  return { ...file, closedAt: null };
}
