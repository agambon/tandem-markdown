// Scroll sync in a text editor (docs/ARCHITECTURE.md, "Scroll sync"): how the place a text
// editor shows becomes a place for the other tabs and back, and which of its scroll reports
// answer the host's own reveals. Positions are zero-based lines and characters, as VS Code's
// API gives them.
//
// VS Code reports a text editor's visible ranges from its first completely visible line, and
// `revealRange` with `AtTop` puts the line `padding` lines below the top: room VS Code keeps
// for sticky scroll's headings or `editor.cursorSurroundingLines`. So the report that answers a
// reveal starts at, or a few lines above, the line asked for. That is how an answer is told from
// the user's own scroll; no clock is involved.

import { insideAnEdit, lineAfter, type LineEdit } from './lineEdits';

export interface Pos {
  line: number;
  character: number;
}

/** One of a text editor's visible ranges. Hidden (folded) lines fall between two ranges. */
export interface LineRange {
  start: Pos;
  end: Pos;
}

/** What a text editor's report of new visible ranges was. */
export type ReportKind =
  /** The top did not move: only the bottom did, or the text moved under it with an edit. */
  | 'same'
  /** It answers a reveal the host asked for. */
  | 'answer'
  /** The user moved it: the other tabs follow. */
  | 'lead';

/**
 * Reveals kept while their answers are on the way. The host sends one for each scroll of the
 * leading tab, and VS Code answers each within a frame or two, so an older one has had its
 * answer, or did not move the editor and has none.
 */
const MAX_PENDING = 4;

/**
 * The place a text editor shows: its top line plus the share of that line above the top. A
 * wrapped line's share is the share of its characters before the visible part.
 */
export function placeOfTop(top: Pos, lineLength: number): number {
  if (lineLength <= 0) return top.line;
  const character = Math.max(0, Math.min(lineLength - 1, top.character));
  return top.line + character / lineLength;
}

/**
 * Where to reveal a place: its line, and the character the share falls on when the editor wraps
 * lines (a line that is not wrapped has nothing to reveal inside it).
 */
export function revealPosition(
  place: number,
  lineCount: number,
  lineLength: (line: number) => number,
  wraps: boolean,
): Pos {
  const last = Math.max(0, lineCount - 1);
  const whole = Math.floor(Math.max(0, place));
  if (whole > last) return { line: last, character: 0 };
  if (!wraps) return { line: whole, character: 0 };
  const length = lineLength(whole);
  return { line: whole, character: Math.max(0, Math.min(length, Math.round((place - whole) * length))) };
}

function samePos(a: Pos, b: Pos): boolean {
  return a.line === b.line && a.character === b.character;
}

function comparePos(a: Pos, b: Pos): number {
  return a.line - b.line || a.character - b.character;
}

/**
 * Where a position stands after a document change, when the editor keeps its text in place: lines
 * inserted or removed above it move it; a change that runs into its line puts it where that change
 * ends, so that what was at the top stays in view.
 */
export function shiftedBy(pos: Pos, changes: readonly LineEdit[]): Pos {
  const line = lineAfter(pos.line, changes, 'end');
  if (insideAnEdit(pos.line, changes)) return { line, character: 0 };
  return line === pos.line ? pos : { line, character: pos.character };
}

interface PendingReveal {
  target: Pos;
  /** The most lines VS Code leaves above the target. */
  padding: number;
  /** VS Code scrolls there in steps (`editor.smoothScrolling`), reporting each. */
  smooth: boolean;
}

/** Visible lines from `from` up to, not including, `to`, across the ranges. */
function visibleLinesBetween(ranges: readonly LineRange[], from: number, to: number): number {
  let count = 0;
  for (const r of ranges) {
    const a = Math.max(from, r.start.line);
    const b = Math.min(to - 1, r.end.line);
    if (b >= a) count += b - a + 1;
  }
  return count;
}

/**
 * The line a reveal of `line` puts in view: the line itself, or, when it is folded away, the
 * visible line above the fold. Null when neither is in the ranges.
 */
function shownLine(ranges: readonly LineRange[], line: number): number | null {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    if (line >= r.start.line && line <= r.end.line) return line;
    const next = ranges[i + 1];
    if (next && line > r.end.line && line < next.start.line) return r.end.line;
  }
  return null;
}

/**
 * True when the ranges are where a reveal of `p.target` leaves the editor: the target's line in
 * view, the top not past it, and at most `p.padding` visible lines above it, or fewer lines left
 * below than VS Code needs to put it higher (the editor shows the document's last line).
 */
function endsAt(p: PendingReveal, top: Pos, ranges: readonly LineRange[], lineCount: number): boolean {
  const line = shownLine(ranges, p.target.line);
  if (line === null) return false;
  const target = line === p.target.line ? p.target : { line, character: 0 };
  if (comparePos(top, target) > 0) return false;
  if (visibleLinesBetween(ranges, top.line, line) <= p.padding) return true;
  return ranges[ranges.length - 1]!.end.line >= lineCount - 1;
}

/** True when `pos` lies between `from` and `to`, either way round, `to` included. */
function between(from: Pos, pos: Pos, to: Pos): boolean {
  return comparePos(from, pos) * comparePos(pos, to) >= 0 && !samePos(from, pos);
}

/**
 * One text editor that follows and leads. The host tells it each reveal it sends and each change
 * of the document, and asks it what each report of new visible ranges was.
 */
export class EditorFollow {
  private pending: PendingReveal[] = [];
  /** Where the top stands after the edits since the last report, when VS Code keeps the text in place. */
  private shifted: Pos | null = null;
  /** The target of the reveal whose answer is where the editor is now; null once it moves otherwise. */
  private settled: Pos | null = null;

  /** `top`: the start of the editor's first visible range now. */
  constructor(private top: Pos) {}

  /** The start of the first visible range the editor last reported. */
  get reportedTop(): Pos {
    return this.top;
  }

  /**
   * Records a reveal of `target` about to be sent, and returns true; or returns false when the
   * reveal would not move the editor (it is already there), so it is not sent.
   */
  reveal(target: Pos, padding: number, smooth: boolean): boolean {
    if (samePos(target, this.top) || (this.settled !== null && samePos(target, this.settled))) return false;
    this.pending.push({ target, padding, smooth });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return true;
  }

  /** The document changed. VS Code keeps the text in place in some editors and not in others. */
  documentChanged(changes: readonly LineEdit[]): void {
    const shifted = shiftedBy(this.shifted ?? this.top, changes);
    this.shifted = samePos(shifted, this.top) ? null : shifted;
  }

  report(ranges: readonly LineRange[], lineCount: number): ReportKind {
    const first = ranges[0];
    if (!first) return 'same';
    const previous = this.top;
    const top = first.start;
    const shifted = this.shifted;
    this.top = top;
    this.shifted = null;
    if (samePos(top, previous) || (shifted !== null && samePos(top, shifted))) return 'same';
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      const ended = endsAt(p, top, ranges, lineCount);
      if (ended || (p.smooth && between(previous, top, p.target))) {
        // The reveals sent before this one were overtaken by it. A reveal that moves the editor
        // in one step answers once; one that moves it in steps answers until it stops.
        this.pending.splice(0, p.smooth ? i : i + 1);
        this.settled = ended ? p.target : null;
        return 'answer';
      }
    }
    this.pending = [];
    this.settled = null;
    return 'lead';
  }
}
