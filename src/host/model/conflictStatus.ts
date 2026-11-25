// The words that count open parts: the status bar item and its tooltip, the list a click opens,
// and the prompt "Copy Prompt for Agent" copies.

import * as W from './conflictFile';
import { fill } from './templates';

export interface FileCount {
  /** The note, by name (status bar) or by its path from the workspace folder (prompt). */
  note: string;
  /** Its conflict file, the same way. */
  conflictFile: string;
  /** Its open parts. */
  changes: number;
}

const FILES_NAMED = 5;

function total(files: readonly FileCount[]): number {
  return files.reduce((n, f) => n + f.changes, 0);
}

/** "1 change", "3 changes": in the item's text, its tooltip and each row of the list a click opens. */
export function countWords(count: number): string {
  return count === 1 ? W.CHANGES_ONE : fill(W.CHANGES_MANY, { count });
}

/** Status bar text for the dedicated waiting-message item, or null when none wait. */
export function waitingText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '$(comment-unresolved) 1 message for you' : `$(comment-unresolved) ${count} messages for you`;
}

/** Tooltip for the waiting-message status bar item: note name and oldest waiting sentence. */
export function waitingTooltip(fileName: string, text: string): string {
  return `${fileName}: ${text}`;
}

/** The status bar item's text, or null when nothing is open (the item is hidden). */
export function statusText(files: readonly FileCount[]): string | null {
  const changes = total(files);
  return changes === 0 ? null : fill(W.STATUS, { changes: countWords(changes) });
}

/** The status bar item's tooltip: which file tells the agent about how many changes, up to five. */
export function statusTooltip(files: readonly FileCount[]): string {
  if (files.length === 1) {
    const { note, conflictFile, changes } = files[0]!;
    return fill(W.STATUS_TIP_ONE, { conflictFile, changes: countWords(changes), note });
  }
  const lines = files
    .slice(0, FILES_NAMED)
    .map((f) => fill(W.STATUS_TIP_FILE, { conflictFile: f.conflictFile, changes: countWords(f.changes) }));
  if (files.length > FILES_NAMED) lines.push(fill(W.STATUS_TIP_MORE, { count: files.length - FILES_NAMED }));
  return [fill(W.STATUS_TIP_MANY, { count: files.length, changes: countWords(total(files)) }), ...lines].join('\n');
}

/** The prompt for an agent, or null when no conflict file is open. */
export function promptFor(files: readonly FileCount[]): string | null {
  if (total(files) === 0) return null;
  if (files.length === 1) return fill(W.PROMPT_ONE, { note: files[0]!.note, conflictFile: files[0]!.conflictFile });
  return fill(W.PROMPT_MANY, { notes: files.length, files: files.map((f) => `"${f.conflictFile}"`).join(', ') });
}
