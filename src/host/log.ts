// The "Tandem Markdown" log channel. One per extension host, created in activate.
//
// Levels follow the core's: info, warn, error, plus trace for the reconciler's every decision
// (shown when the channel's level is set to Trace in the Output view).

import * as vscode from 'vscode';
import type { LogLevel } from '../core/protocol';

/** The core's levels, and `trace`. */
type HostLogLevel = LogLevel | 'trace';

export interface LogLine {
  level: HostLogLevel;
  message: string;
  detail?: string | undefined;
  at: number;
}

let channel: vscode.LogOutputChannel | null = null;
/** Lines kept for the test hook (only filled in test mode). */
let kept: LogLine[] | null = null;
/** Recent lines always kept in memory for Copy Diagnostics (oldest dropped first). */
let recent: LogLine[] = [];
/** How many lines have been kept for the test hook, those dropped since included. */
let logged = 0;
/** The most lines kept for the test hook; the oldest go first. */
export const KEPT_LINES_MAX = 2000;
/** The most recent lines kept for Copy Diagnostics. */
export const RECENT_LINES_MAX = 100;

/** Opens the log's output channel; disposing the result closes it, and later lines go to the console. */
export function createLog(keepForTests: boolean): vscode.Disposable {
  const created = vscode.window.createOutputChannel('Tandem Markdown', { log: true });
  channel = created;
  kept = keepForTests ? [] : null;
  recent = [];
  logged = 0;
  return new vscode.Disposable(() => {
    if (channel === created) channel = null;
    created.dispose();
  });
}

/** Turns a detail of any kind into one line of text for the log. */
function describeDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function log(level: HostLogLevel, message: string, detail?: unknown): void {
  const text = describeDetail(detail);
  const line = text === undefined ? message : `${message} ${text}`;
  const entry: LogLine = { level, message, detail: text, at: Date.now() };
  recent.push(entry);
  if (recent.length > RECENT_LINES_MAX) recent.splice(0, recent.length - RECENT_LINES_MAX);
  if (kept) {
    kept.push(entry);
    logged++;
    if (kept.length > KEPT_LINES_MAX) kept.splice(0, kept.length - KEPT_LINES_MAX);
  }
  if (!channel) {
    // Before activation finished (or after deactivation): the console is all there is.
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`Tandem Markdown: ${line}`);
    return;
  }
  switch (level) {
    case 'trace':
      channel.trace(line);
      break;
    case 'info':
      channel.info(line);
      break;
    case 'warn':
      channel.warn(line);
      break;
    case 'error':
      channel.error(line);
      break;
  }
}

export function showLog(): void {
  channel?.show(true);
}

/** Test mode only: how many lines have been logged so far, those dropped since included; a mark for `linesAfter`. */
export function loggedCount(): number {
  return logged;
}

/** Test mode only: the lines logged after the first `mark` (a `loggedCount`), as many of them as are still kept. */
export function linesAfter(mark: number): LogLine[] {
  if (!kept) return [];
  return kept.slice(Math.max(0, mark - (logged - kept.length)));
}

/** Recent log lines kept in memory for Copy Diagnostics, oldest first. */
export function recentLogLines(): readonly LogLine[] {
  return [...recent];
}
