// What one update from outside did to the host's text, by whole lines: the lines it added, the
// lines it changed, and the lines it took out, each counted once, as the words a screen reader is
// told count them (words.ts). Read from the host's text before and after the update, so a line
// break the update put in or took out is placed exactly.

import type { ChangeSet, Text } from '@codemirror/state';
import { changedLineStarts } from '../outsideChanges';
import type { Shape } from './words';

/** What an update did, with positions in the host's text after it. */
export interface Landed {
  /** The start of each line it added whole. */
  added: number[];
  /** The start of each other line holding text it put in, or that it took text out of. */
  changed: number[];
  /** Lines it took out beyond those it changed: where they stood, and how many. */
  removed: { at: number; count: number }[];
  /** Null for an update that changes nothing. */
  shape: Shape | null;
}

function startsLine(text: Text, pos: number): boolean {
  return pos === 0 || text.sliceString(pos - 1, pos) === '\n';
}

function endsLine(text: Text, pos: number): boolean {
  return pos === text.length || text.sliceString(pos, pos + 1) === '\n';
}

/** How many line breaks `text` holds between `from` and `to`. */
function breaksIn(text: Text, from: number, to: number): number {
  return text.lineAt(to).number - text.lineAt(from).number;
}

/** What `changes`, an update that turns `before` into `after`, did to their lines. */
export function landedLines(before: Text, after: Text, changes: ChangeSet): Landed {
  // Two changes inside one line touch it twice; it is kept once.
  const added = new Set<number>();
  const changed = new Set<number>();
  const removed: Landed['removed'] = [];
  const shapes = new Set<Shape>();
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const puts = inserted.length > 0;
    const takes = toA > fromA;
    if (puts && !takes) {
      // Whole lines: what it puts in ends with a line break at a line's start, or starts with one at its end.
      const whole =
        inserted.lines > 1 &&
        ((startsLine(before, fromA) && inserted.sliceString(inserted.length - 1) === '\n') ||
          (endsLine(before, fromA) && inserted.sliceString(0, 1) === '\n'));
      const lines = changedLineStarts(after, [{ from: fromB, to: toB }]);
      for (const line of lines) (whole ? added : changed).add(line);
      shapes.add(whole ? 'added' : 'changed');
      return;
    }
    if (takes && !puts) {
      const whole =
        breaksIn(before, fromA, toA) > 0 &&
        ((startsLine(before, fromA) && startsLine(before, toA)) || (endsLine(before, fromA) && endsLine(before, toA)));
      if (whole) {
        removed.push({ at: fromB, count: breaksIn(before, fromA, toA) });
        shapes.add('tookOut');
        return;
      }
    }
    // Text put in, taken out or both, inside lines or across them: each line it leaves holding
    // the change is changed, and each line break it took out beyond those it put in is a line
    // taken out (two lines joined are one changed and one taken out).
    const lines = toB > fromB ? changedLineStarts(after, [{ from: fromB, to: toB }]) : [after.lineAt(fromB).from];
    for (const line of lines) changed.add(line);
    const gone = breaksIn(before, fromA, toA) - (inserted.lines - 1);
    if (gone > 0) removed.push({ at: fromB, count: gone });
    shapes.add('changed');
  });
  const shape = shapes.size === 0 ? null : shapes.size === 1 ? [...shapes][0]! : 'changed';
  return { added: [...added], changed: [...changed], removed, shape };
}
