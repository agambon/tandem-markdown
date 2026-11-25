// The buttons and concise wording of every user-facing message (messages.ts and notices.ts).
// Core notices carry structured facts only; all English prose lives here on the host side.

import type { CoreNotice } from '../../core/reconcile/types';

export type Does =
  'compare' | 'undo' | 'putTypingBack' | 'dismiss' | 'addInstructions' | 'copyInstructions' | 'dontAskAgain' | 'reload';

type Settles = 'always' | 'done' | 'never';

export interface FormButton {
  does: Does;
  label: string;
  settles: Settles;
}

export interface MessageForm {
  text: string;
  buttons: readonly FormButton[];
  severity: 'warning' | 'information';
  /** Stays in a strip at the top of its note's rich tabs until settled; else pop-up only. */
  strip: boolean;
}

export const SEE_DIFF = 'See Diff';
export const DISMISS = 'Dismiss';
const UNDO = 'Undo';
const PUT_TEXT_BACK = 'Put My Text Back';
export const PUT_TYPING_BACK = 'Put My Typing Back';
const RELOAD_WINDOW = 'Reload Window';
const UPDATE_AGENTS = 'Update AGENTS.md';
export const COPY_INSTRUCTIONS = 'Copy instructions';
const DONT_ASK_AGAIN = "Don't ask again";
export const OPEN_AGENTS = 'Open AGENTS.md';

/** Diff title-bar button labels (must match package.json shortTitle). */
export const USE_CHANGE_FROM_DISK = 'Use Change from Disk';
export const REPLACE_MY_VIEW = 'Replace My View';

const INSTRUCTIONS_OFFER = 'Update AGENTS.md so your agent knows how to work with Tandem Markdown?';

export function moreWords(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? '1 more message after this one' : `${count} more messages after this one`;
}

type MessageOf =
  | { kind: 'withDiff'; text: string }
  | { kind: 'told'; text: string }
  | { kind: 'withUndo'; text: string }
  | { kind: 'reloaded'; text: string }
  | { kind: 'typingAtClose'; text: string }
  | { kind: 'saveCheckOff'; text: string }
  | { kind: 'instructionsOffer' };

const button = (does: Does, label: string, settles: Settles): FormButton => ({ does, label, settles });
const seeDiff = button('compare', SEE_DIFF, 'never');
const dismiss = button('dismiss', DISMISS, 'always');

export function messageForm(m: MessageOf): MessageForm {
  switch (m.kind) {
    case 'withDiff':
      return { text: m.text, buttons: [seeDiff, dismiss], severity: 'warning', strip: false };
    case 'told':
      return { text: m.text, buttons: [dismiss], severity: 'warning', strip: false };
    case 'withUndo':
      return {
        text: m.text,
        buttons: [button('undo', UNDO, 'done'), seeDiff, dismiss],
        severity: 'warning',
        strip: true,
      };
    case 'reloaded':
      return {
        text: m.text,
        buttons: [button('undo', PUT_TEXT_BACK, 'done'), seeDiff, dismiss],
        severity: 'warning',
        strip: true,
      };
    case 'typingAtClose':
      return {
        text: m.text,
        buttons: [button('putTypingBack', PUT_TYPING_BACK, 'done'), seeDiff, dismiss],
        severity: 'warning',
        strip: true,
      };
    case 'saveCheckOff':
      return {
        text: m.text,
        buttons: [button('reload', RELOAD_WINDOW, 'always'), dismiss],
        severity: 'warning',
        strip: false,
      };
    case 'instructionsOffer':
      return {
        text: INSTRUCTIONS_OFFER,
        buttons: [
          button('addInstructions', UPDATE_AGENTS, 'always'),
          button('copyInstructions', COPY_INSTRUCTIONS, 'always'),
          button('dontAskAgain', DONT_ASK_AGAIN, 'always'),
        ],
        severity: 'information',
        strip: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Single-sentence wording for each CoreNotice

export function conflictText(file: string, notice: Extract<CoreNotice, { kind: 'conflict' }>): string {
  switch (notice.reason) {
    case 'clash':
      return notice.restMerged
        ? `Both you and another program edited ${file}; your words were kept at the clash and the rest merged.`
        : `Both you and another program edited ${file}; your words were kept.`;
    case 'noBase':
      return `${file} changed on disk while you had unsaved changes from an earlier session; your text was kept.`;
    case 'truncated':
      return `${file} on disk looks cut short while you have unsaved changes; your text was kept.`;
    case 'encoding':
      return `${file} changed on disk in an encoding Tandem Markdown couldn't merge; your text was kept.`;
    case 'handoff':
      return `${file} changed on disk and couldn't be merged automatically; your text was kept.`;
  }
}

export function appliedText(file: string, notice: Extract<CoreNotice, { kind: 'applied' }>): string {
  switch (notice.how) {
    case 'setting':
      return `Another program's changes replaced yours in ${file}.`;
    case 'useChoice':
      return `${file} now has the change from disk.`;
    case 'replaceChoice':
      return `${file} was replaced with the version from disk.`;
    case 'reloaded':
      return `VS Code reloaded ${file} from disk over your text.`;
  }
}

export function actionRejectedText(file: string, notice: Extract<CoreNotice, { kind: 'actionRejected' }>): string {
  if (notice.reason === 'closed') return `Nothing was changed because ${file} is closed.`;
  if (notice.reason === 'missingBackup') return `Nothing was changed because the backup for ${file} couldn't be read.`;
  if (notice.reason === 'changed') {
    return notice.action === 'undo'
      ? `Nothing was changed because you edited ${file} where those changes landed.`
      : `Nothing was changed because that choice for ${file} is no longer available.`;
  }
  return `VS Code didn't apply that change to ${file}; try again in a moment.`;
}

export function closedWithPendingText(file: string, hasBackup: boolean): string {
  return hasBackup
    ? `${file} closed before an external change could merge; a backup was saved.`
    : `${file} closed before an external change could merge; the disk version is open in an unsaved tab.`;
}

export function readFailedTooltip(file: string, error?: 'busy' | 'failed'): string {
  return error === 'busy'
    ? `Another program is locking ${file}; Tandem Markdown will retry automatically.`
    : `Tandem Markdown couldn't read ${file} from disk; it will retry automatically.`;
}

export function saveCheckOffText(): string {
  return "VS Code stopped running Tandem Markdown's pre-save check; reload the window to restore merge-on-save.";
}

export function typingAtCloseText(file: string, lines: number, backedUp: boolean): string {
  const span = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  return backedUp
    ? `Your last typing on ${span} of ${file} hadn't reached VS Code when the tab closed; a backup was saved.`
    : `Your last typing on ${span} of ${file} hadn't reached VS Code when the tab closed; a copy is open in an unsaved tab.`;
}

export function typingNotBackText(file: string, why: 'changed' | 'refused'): string {
  return why === 'changed'
    ? `Nothing was changed because ${file} changed after it closed.`
    : `VS Code couldn't reopen ${file} to put your typing back; try again in a moment.`;
}

/** One-line summary of any CoreNotice, used by logs and the browser test harness. */
export function summarizeNotice(file: string, notice: CoreNotice): string {
  switch (notice.kind) {
    case 'conflict':
      return conflictText(file, notice);
    case 'truncatedFollow':
      return `${file} on disk looks cut short; your earlier version was backed up.`;
    case 'applied':
      return appliedText(file, notice);
    case 'actionRejected':
      return actionRejectedText(file, notice);
    case 'closedWithPending':
      return closedWithPendingText(file, notice.backupPath !== null);
    case 'readStatus':
      return notice.ok ? `${file} can be read again.` : readFailedTooltip(file, notice.error);
    case 'saveCheckOff':
      return saveCheckOffText();
    case 'typingAtClose':
      return typingAtCloseText(file, notice.linesChanged, notice.backupPath !== null);
  }
}
