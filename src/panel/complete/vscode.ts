// Suggestions from VS Code's completion providers for the document (for markdown, VS Code's
// own: paths in links and pictures, headings after `#`, reference names), in the list that
// `[[` completion shows. Asked for only where a link's address, a reference or an HTML `src` or
// `href` is being typed: at its start, after `/`, `#` or `.`, or with Ctrl+Space anywhere in
// it. Typing within one part of a path filters the list in place; a `/`, `#` or `.` asks again.

import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { SuggestionItem } from '../../core/featureProtocol';
import { stampOf } from '../../core/hash';
import { panelContext } from '../context';
import { codeAt, treeForLine } from '../markdown/tree';
import { getMode } from '../modes';

/** How much of the line before the cursor is looked at. */
const MAX_LOOK = 500;
/** How long the list waits for VS Code's answer. */
const SUGGESTIONS_WAIT_MS = 3000;
/** The characters that ask VS Code again, as its markdown suggestions do. */
const TRIGGERS = new Set(['/', '#', '.']);
/** What may be typed while the list filters in place: anything but the characters that start a new part. */
const SAME_PART = /^[^\s/#.\\()[\]<>"'`|]*$/;

/**
 * The places VS Code's markdown suggestions answer for, each with the part typed so far: a
 * link's or picture's address (in angle brackets, where it may hold spaces, or bare), a
 * reference definition's address, a reference link's label, an HTML `src` or `href`.
 */
const PLACES = [
  /\]\(\s*<([^<>]*)$/,
  /\]\(\s*([^\s()<>]*)$/,
  /^ {0,3}\[[^\]]+\]:[ \t]*<([^<>]*)$/,
  /^ {0,3}\[[^\]]+\]:[ \t]*([^\s<>]*)$/,
  /\]\[([^\]]*)$/,
  /\b(?:src|href)\s*=\s*["']([^"'\s]*)$/i,
];

/** The part of an address being typed at the end of `lineBefore`, or null when it ends in none of PLACES. */
export function typedPart(lineBefore: string): string | null {
  const text = lineBefore.slice(-MAX_LOOK);
  for (const place of PLACES) {
    const m = place.exec(text);
    if (m) return m[1] ?? '';
  }
  return null;
}

function readItems(value: unknown): { from: number; items: SuggestionItem[] } | null {
  const v = value as { from?: unknown; items?: unknown } | null;
  if (!v || !Number.isInteger(v.from) || !Array.isArray(v.items)) return null;
  const items: SuggestionItem[] = [];
  for (const raw of v.items) {
    const i = raw as Partial<SuggestionItem> | null;
    if (!i || typeof i.label !== 'string' || typeof i.insert !== 'string' || !Number.isInteger(i.cursor)) continue;
    items.push({
      label: i.label,
      filter: typeof i.filter === 'string' ? i.filter : i.label,
      detail: typeof i.detail === 'string' ? i.detail : '',
      insert: i.insert,
      cursor: Math.max(0, Math.min(i.cursor!, i.insert.length)),
      again: i.again === true,
    });
  }
  return { from: v.from as number, items };
}

/** The highest boost CodeMirror takes: VS Code's order is kept among items that match equally well. */
const MAX_BOOST = 99;

function option(item: SuggestionItem, rank: number): Completion {
  return {
    label: item.filter,
    displayLabel: item.label,
    detail: item.detail,
    boost: Math.max(-MAX_BOOST, MAX_BOOST - rank),
    apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: item.insert },
        selection: { anchor: from + item.cursor },
        userEvent: 'input.complete',
        scrollIntoView: true,
      });
      if (item.again) startCompletion(view);
    },
  };
}

/** The completion source: VS Code's suggestions where a link's address is being typed. */
export async function vscodeSuggestions(context: CompletionContext): Promise<CompletionResult | null> {
  const state = context.state;
  if (getMode(state) !== 'edit' || state.readOnly) return null;
  const line = state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const part = typedPart(before);
  if (part === null) return null;
  const last = before.slice(-1);
  if (!context.explicit && part !== '' && !TRIGGERS.has(last)) return null;
  if (codeAt(treeForLine(state, context.pos), context.pos)) return null;
  const ctx = state.facet(panelContext);
  if (!ctx) return null;
  let answer: ReturnType<typeof readItems>;
  try {
    answer = readItems(
      await ctx.request(
        {
          type: 'completions',
          at: context.pos,
          expect: stampOf(state.doc),
          ...(TRIGGERS.has(last) ? { trigger: last } : {}),
        },
        { timeoutMs: SUGGESTIONS_WAIT_MS },
      ),
    );
  } catch (error) {
    ctx.log('warn', 'VS Code did not send suggestions', error);
    return null;
  }
  if (context.aborted || !answer || answer.items.length === 0) return null;
  if (answer.from < line.from || answer.from > context.pos) return null;
  return {
    from: answer.from,
    options: answer.items.map(option),
    validFor: SAME_PART,
  };
}
