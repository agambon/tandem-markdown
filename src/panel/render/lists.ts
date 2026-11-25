// Lists and tasks.
//
// Every line of a list item gets `tm-li` and a depth class `tm-ld<n>` (n from the tree: how
// many list items contain the line, never from counting spaces). The stylesheet turns the
// depth into a left padding, and the item's first line (`tm-li-first`) hangs its marker into
// that padding, so wrapped lines line up with the item's text. Indentation in the source is
// hidden; what the depth draws replaces it.
//
// Markers sit in a fixed-width box (`tm-list-marker`). Bullets draw as a disc, circle or square
// by depth; numbers show as written. A task's `[ ]` or `[x]` becomes a checkbox named by the
// task's text as a line draws it, and another mark (`[?]`) a box showing it, which a click
// does not check. In Rich editor a bullet or task marker shows as typed while the cursor touches it.

import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isSpaceOrTab } from '../../core/markdownText';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { CODE_GREATER_THAN } from '../markdown/chars';
import { resyncPending } from '../sync';
import { blockFeature, inlineDrawing, inlineKey, posOf, RichWidget, type BlockDraw } from './framework';
import { inlineText } from './inlineDom';
import { hideIndent, markerWidthClass, MAX_LIST_DEPTH } from './layout';
import type { BlockEntry } from './lines';
import { LruCache } from './lruCache';

/**
 * Where a line's own indentation starts, as an index into its text: the line start, or,
 * inside a quote, just after the `> ` that the quotes feature hides (a quote marker hides
 * itself and one space). `before` is the index the indentation runs up to.
 */
function indentStart(text: string, before: number): number {
  let i = before;
  while (i > 0 && isSpaceOrTab(text.charCodeAt(i - 1))) i--;
  if (i === 0) return 0;
  if (text.charCodeAt(i - 1) === CODE_GREATER_THAN) return Math.min(before, i + 1);
  return before;
}

/**
 * Flips the task marker `[ ]`/`[x]` that starts at `pos`, as a click on its checkbox does in
 * either view (in Rich view Tab can give a checkbox focus, ui/viewKeys.ts, and Space checks
 * it). The change carries the user event `input.toggle`, not typing. False when there is no
 * marker, the document is read-only, or the view is waiting to be reloaded (sync.ts).
 */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const ctx = view.state.facet(panelContext);
  if (ctx?.doc.readOnly || resyncPending(view.state)) return false;
  const marker = view.state.doc.sliceString(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
    userEvent: 'input.toggle',
  });
  return true;
}

/** What a checkbox is called when its task has no text. */
const UNNAMED_TASK = 'Task';

/** Task names kept. */
const CACHE_SIZE = 2000;
/**
 * Tasks' names by their text, what they read of where they stand (`placeKey`) and the
 * `inlineKey` they were read under, so a box drawn again, or after a keystroke, reads nothing.
 */
const taskNameCache = new LruCache<string, string>(CACHE_SIZE);

/**
 * A task's name: its text after the marker as a line draws it, read as plain text when its box
 * is first drawn, from the state the list was drawn in, so a list drawn whole reads only the
 * names of the boxes on screen. `key` says what it is read from, so two names with one key are
 * the same.
 */
class TaskName {
  private name: string | null = null;

  constructor(
    readonly key: string,
    private readonly state: EditorState,
    private readonly task: SyntaxNode,
  ) {}

  /** The name, or what a box is called when its task has no text. */
  get text(): string {
    this.name ??= taskNameCache.get(this.key) ?? this.read();
    return this.name || UNNAMED_TASK;
  }

  private read(): string {
    const { state, task } = this;
    const from = task.firstChild?.to ?? task.from;
    const drawing = inlineDrawing(state, 'lists', [task]);
    const name = inlineText(drawing, state.doc, from, task.to).replace(/\s+/g, ' ').trim();
    taskNameCache.set(this.key, name);
    return name;
  }
}

/** The name of `task`, a list item's task, to be read when its box asks for it. */
function taskName(d: BlockDraw, task: SyntaxNode, inline: string): TaskName {
  return new TaskName(
    `${inline}\u0000${d.placeKey(task)}\u0000${d.doc.sliceString(task.from, task.to)}`,
    d.state,
    task,
  );
}

class TaskBox extends RichWidget {
  constructor(
    source: string,
    readonly readOnly: boolean,
    /** The task's name, which names the checkbox for assistive technology. */
    readonly name: TaskName,
  ) {
    super(source);
  }

  override sameAs(other: TaskBox): boolean {
    return other.readOnly === this.readOnly && other.name.key === this.name.key;
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const box = doc.createElement('span');
    box.className = 'tm-list-marker tm-task-box';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.className = 'tm-task';
    input.tabIndex = -1;
    input.checked = this.source[1] !== ' ';
    input.disabled = this.readOnly;
    input.setAttribute('aria-label', this.name.text);
    // Keep the focus and the selection where they are.
    input.addEventListener('mousedown', (event) => event.preventDefault());
    // The browser has checked the box when this runs; the document follows, and `redraw` keeps
    // the box as the document says. (Canceling the click would make the browser put the old
    // state back after `redraw` has drawn the new one.)
    input.addEventListener('click', () => {
      const at = posOf(view, box);
      if (at === null || !toggleTaskAt(view, at)) input.checked = !input.checked;
    });
    box.appendChild(input);
    return box;
  }

  /** Checked or not, in place: a checkbox that has focus (Rich view, by Tab) keeps it when Space checks it. */
  override redraw(dom: HTMLElement): boolean {
    const input = dom.querySelector<HTMLInputElement>('input.tm-task');
    if (!input) return false;
    input.checked = this.source[1] !== ' ';
    input.disabled = this.readOnly;
    input.setAttribute('aria-label', this.name.text);
    return true;
  }

  override ignores(): boolean {
    return true;
  }
}

/**
 * A task box holding another mark (`[?]`, `[-]`, markdown/taskMark.ts): the mark in a box the
 * size of a checkbox. It is no checkbox and cannot be checked; a click puts the cursor there.
 */
class MarkBox extends RichWidget {
  constructor(
    source: string,
    /** The task's name, which names the box for assistive technology with its mark. */
    readonly name: TaskName,
  ) {
    super(source);
  }

  override sameAs(other: MarkBox): boolean {
    return other.name.key === this.name.key;
  }

  draw(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const box = doc.createElement('span');
    box.className = 'tm-list-marker tm-task-box';
    const mark = doc.createElement('span');
    mark.className = 'tm-task-mark';
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', `${this.name.text}, marked ${this.source[1]}`);
    const char = doc.createElement('span');
    char.className = 'tm-task-mark-char';
    char.textContent = this.source[1] ?? '';
    mark.appendChild(char);
    box.appendChild(mark);
    return box;
  }

  override ignores(): boolean {
    return false;
  }
}

/** Characters from a list item's marker to its text (`1000. ` is 6), or 0 when it has none on its first line. */
function markerChars(d: BlockDraw, item: SyntaxNode): number {
  const mark = item.firstChild;
  if (!mark || mark.name !== 'ListMark') return 0;
  const line = d.lines.numberAt(mark.from);
  const lineFrom = d.lines.start(line);
  const text = d.lines.text(line);
  let textAt = mark.to - lineFrom;
  while (textAt < text.length && isSpaceOrTab(text.charCodeAt(textAt))) textAt++;
  return textAt - (mark.from - lineFrom);
}

/** The widest number box in a numbered list, in characters. */
function widestNumber(d: BlockDraw, list: SyntaxNode): number {
  let widest = 0;
  for (let item = list.firstChild; item; item = item.nextSibling)
    if (item.name === 'ListItem') widest = Math.max(widest, markerChars(d, item));
  return widest;
}

/**
 * Draws an item's marker. Returns the item's content column (counted from its indentation
 * start) and, when the marker shows as typed (revealed), how many characters that is.
 */
function drawMarker(
  d: BlockDraw,
  item: BlockEntry,
  readOnly: boolean,
  inline: () => string,
): { column: number; raw: number } {
  const mark = item.node.firstChild;
  const lineFrom = d.lines.start(item.firstLine);
  const text = d.lines.text(item.firstLine);
  if (!mark || mark.name !== 'ListMark' || mark.from > lineFrom + text.length) return { column: 0, raw: 0 };
  const markAt = mark.from - lineFrom;
  const indent = indentStart(text, markAt);
  d.hide(lineFrom + indent, mark.from);
  let textAt = mark.to - lineFrom;
  while (textAt < text.length && isSpaceOrTab(text.charCodeAt(textAt))) textAt++;
  const textStart = lineFrom + textAt;
  const contentColumn = textAt - indent;

  const task = mark.nextSibling;
  const marked = task?.name === 'MarkedTask';
  const marker = task?.name === 'Task' || marked ? task.firstChild : null;
  if (
    task &&
    marker &&
    (marker.name === 'TaskMarker' || marker.name === 'MarkedTaskMarker') &&
    marker.from <= lineFrom + text.length
  ) {
    let taskTextAt = marker.to - lineFrom;
    while (taskTextAt < text.length && isSpaceOrTab(text.charCodeAt(taskTextAt))) taskTextAt++;
    const taskTextStart = lineFrom + taskTextAt;
    if (d.revealed(mark.from, marker.to)) {
      d.mark(mark.from, taskTextStart, 'tm-list-marker tm-list-raw');
      return { column: contentColumn, raw: taskTextStart - mark.from };
    }
    const name = taskName(d, task, inline());
    const source = text.slice(marker.from - lineFrom, marker.to - lineFrom);
    d.hide(mark.from, marker.from);
    d.replace(marker.from, marker.to, marked ? new MarkBox(source, name) : new TaskBox(source, readOnly, name));
    d.hide(marker.to, taskTextStart);
    return { column: contentColumn, raw: 0 };
  }

  if (item.node.parent?.name === 'OrderedList') {
    d.mark(mark.from, textStart, 'tm-list-marker tm-ordered');
  } else if (d.revealed(mark.from, mark.to)) {
    d.mark(mark.from, textStart, 'tm-list-marker tm-list-raw');
    return { column: contentColumn, raw: textStart - mark.from };
  } else {
    d.mark(mark.from, textStart, `tm-list-marker tm-bullet tm-bullet-${Math.min(item.listDepth, 3)}`);
  }
  return { column: contentColumn, raw: 0 };
}

const theme = EditorView.baseTheme({
  '& .cm-content .tm-task-box': { textAlign: 'right', paddingRight: '0.45em' },
  '& .cm-content .tm-task': {
    width: '0.95em',
    height: '0.95em',
    margin: '0',
    verticalAlign: '-0.12em',
    accentColor: 'var(--tm-link)',
    cursor: 'pointer',
  },
  '& .cm-content .tm-task:disabled': { cursor: 'default' },
  // A box with another mark: a checkbox's size and place, the mark small inside it.
  '& .cm-content .tm-task-mark': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: '0.95em',
    height: '0.95em',
    verticalAlign: '-0.12em',
    border: '1px solid var(--tm-faded)',
    borderRadius: '3px',
    textIndent: '0',
  },
  '& .cm-content .tm-task-mark-char': { fontSize: '0.7em', lineHeight: '1', fontWeight: '600' },
});

export const lists: Feature = {
  id: 'lists',
  extension: (ctx) => [
    blockFeature(
      'lists',
      (d) => {
        const readOnly = ctx.doc.readOnly;
        let depthOfLine: Uint8Array | null = null;
        const items: BlockEntry[] = [];
        const ranges: [number, number][] = [];
        d.blocks((block) => {
          if ((block.name === 'BulletList' || block.name === 'OrderedList') && block.listDepth === 0) {
            ranges.push([block.firstLine, block.lastLine]);
          }
          if (block.name !== 'ListItem') return;
          depthOfLine ??= new Uint8Array(d.lines.count + 1);
          const depth = Math.min(block.listDepth, MAX_LIST_DEPTH);
          for (let n = block.firstLine; n <= block.lastLine; n++) depthOfLine[n] = depth;
          items.push(block);
        });
        if (!depthOfLine) return;
        const depths: Uint8Array = depthOfLine;
        const columns = new Uint16Array(d.lines.count + 1);
        /** Each item's first line, with the width in characters its marker box needs. */
        const firstLines = new Map<number, number>();
        /** The widest number of each numbered list, by the list's start. */
        const widest = new Map<number, number>();

        let key: string | null = null;
        const inline = () => (key ??= inlineKey(d.state));
        for (const item of items) {
          const { column, raw } = drawMarker(d, item, readOnly, inline);
          const list = item.node.parent;
          let chars = raw;
          if (list?.name === 'OrderedList') {
            let w = widest.get(list.from);
            if (w === undefined) widest.set(list.from, (w = widestNumber(d, list)));
            chars = Math.max(chars, w);
          }
          // Two items can start on one line (`1. - a`): the line takes the wider box.
          firstLines.set(item.firstLine, Math.max(firstLines.get(item.firstLine) ?? 0, chars));
          const depth = Math.min(item.listDepth, MAX_LIST_DEPTH);
          for (let n = item.firstLine + 1; n <= item.lastLine; n++) if (depths[n] === depth) columns[n] = column;
        }

        for (const [first, last] of ranges) {
          for (let n = first; n <= last; n++) {
            const depth = depths[n];
            if (!depth) continue;
            const lineFrom = d.lines.start(n);
            const chars = firstLines.get(n);
            if (chars !== undefined) {
              const width = markerWidthClass(chars);
              d.line(lineFrom, `tm-li tm-li-first tm-ld${depth}${width ? ` ${width}` : ''}`);
              continue;
            }
            d.line(lineFrom, `tm-li tm-ld${depth}`);
            const text = d.lines.text(n);
            if (columns[n] === 0 || text.length === 0) continue;
            let firstText = 0;
            while (firstText < text.length && isSpaceOrTab(text.charCodeAt(firstText))) firstText++;
            if (firstText < text.length) hideIndent(d, lineFrom, text, indentStart(text, firstText), columns[n]!);
          }
        }
      },
      // A checkbox's name is what its task's text draws, which can read beyond the item.
      { inline: true },
    ),
    theme,
  ],
};
