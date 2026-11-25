// What a screen reader has yet to be told: each line another program added or changed and each
// stretch of lines it took out since the last telling, where it now stands, the host's log version
// of the update it came in and that update's shape. Beside it, what decides whether the person's
// cursor and unsaved typing are as they left them: what the person changed since the note was
// last saved, in this tab or elsewhere, and whether a change from outside has touched that or the
// selection since the last telling. The host's text at the synced version is followed, so each
// update is read against the text it was made on (landed.ts).

import {
  MapMode,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Text,
  type Transaction,
} from '@codemirror/state';
import { panelContext } from '../context';
import { unsent } from '../hostRanges';
import { receivedChanges, type ReceivedChange } from '../outsideChanges';
import type { Span } from '../render/lines';
import { landedLines } from './landed';
import type { Shape } from './words';

/** A line another program added or changed, by where it starts. */
export interface NewsLine {
  from: number;
  added: boolean;
  version: number;
  shape: Shape;
}

/** Lines another program took out, by the point where they stood. */
export interface NewsGone {
  at: number;
  count: number;
  version: number;
  shape: Shape;
}

export interface News {
  lines: readonly NewsLine[];
  gone: readonly NewsGone[];
  /** The versions of the latest updates from outside, oldest first, at most RECENT_OUTSIDE. */
  recent: readonly number[];
  /** Updates up to this version are told, here or by another tab of the note, and are not gathered again. */
  toldUpTo: number;
  /** A change from outside touched the selection or the person's unsaved changes since the last telling. */
  touched: boolean;
  /** Where the person changed the note since it was last saved: what they put in, and points where they took text out. */
  typing: readonly Span[];
  /** Every unsaved change in the note is in `typing`: false while the host has not said, or the note held some when this tab started. */
  typingKnown: boolean;
  /** Counts that a quiet wait starts again at: changes landed from outside, and the person's changes arriving from elsewhere. */
  landings: number;
  typedElsewhere: number;
  /** The host's text at the synced version; null once an update did not fit it. */
  hostText: Text | null;
}

/** How many versions of updates from outside are kept, for a notice that names the latest one at or before its own. */
const RECENT_OUTSIDE = 50;

/** Drops what came in the updates whose version the function picks: a message tells of them. */
export const dropNews = StateEffect.define<(version: number) => boolean>();
/** What came in updates up to this version has been told. */
export const toldNews = StateEffect.define<number>();
/** The host's word on whether the note holds unsaved changes; `first` for its first word to this tab. */
export const unsavedNews = StateEffect.define<{ held: boolean; first: boolean }>();

function announcing(state: EditorState): boolean {
  return state.facet(panelContext)?.settings.outsideAnnounce !== false;
}

/** Spans sorted, with those that overlap or touch made one. */
function joined(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

function mapSpans(spans: readonly Span[], changes: ChangeDesc): Span[] {
  return spans.map((s) => {
    const from = changes.mapPos(s.from, 1);
    return { from, to: Math.max(from, changes.mapPos(s.to, -1)) };
  });
}

/** What `u` changed, as spans of the panel's text after the transaction: what it put in, and points where it took text out. */
function changedSpans(u: ReceivedChange): Span[] {
  const out: Span[] = [];
  u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = u.toPanel(fromB, -1);
    out.push({ from, to: Math.max(from, u.toPanel(toB, 1)) });
  });
  return out;
}

/** This tab's unsent changes, as spans of its text: they are unsaved whatever the host says of the note. */
function unsentSpans(state: EditorState): Span[] {
  const local = unsent(state);
  const out: Span[] = [];
  local.forEach((u, k) =>
    u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      let from = fromB;
      let to = toB;
      for (const later of local.slice(k + 1)) {
        from = later.changes.mapPos(from, 1);
        to = later.changes.mapPos(to, -1);
      }
      out.push({ from, to: Math.max(from, to) });
    }),
  );
  return joined(out);
}

function touch(a: readonly Span[], b: readonly Span[]): boolean {
  return a.some((x) => b.some((y) => x.from <= y.to && y.from <= x.to));
}

function withoutTold(news: News, keep: (version: number) => boolean): News {
  const lines = news.lines.filter((l) => keep(l.version));
  const gone = news.gone.filter((g) => keep(g.version));
  const none = lines.length === 0 && gone.length === 0;
  return { ...news, lines, gone, touched: none ? false : news.touched };
}

/** Reads the updates `tr` applies from the host into `news`, and the person's changes among them. */
function received(news: News, tr: Transaction, updates: readonly ReceivedChange[]): News {
  let { lines, gone, recent, touched, typing, landings, typedElsewhere, hostText } = news;
  const selection = [{ from: tr.state.selection.main.from, to: tr.state.selection.main.to }];
  const gather = announcing(tr.state);
  const lineOf = (pos: number) => tr.state.doc.lineAt(Math.min(pos, tr.state.doc.length)).from;
  for (const u of updates) {
    const before = hostText;
    hostText = before && u.changes.length === before.length ? u.changes.apply(before) : null;
    const spans = changedSpans(u);
    if (!u.outside) {
      // The person's own change: typed in Source or another tab, VS Code's undo or redo, or this tab's own, confirmed.
      typing = joined([...typing, ...spans]);
      typedElsewhere++;
      continue;
    }
    recent = [...recent, u.version].slice(-RECENT_OUTSIDE);
    if (u.changes.empty) continue;
    landings++;
    if (touch(spans, typing) || touch(spans, selection)) touched = true;
    // The person's own press of a notice's button: it counts as a landing, and is no news.
    if (!gather || u.pressed || u.version <= news.toldUpTo || !before || !hostText) continue;
    const landed = landedLines(before, hostText, u.changes);
    const shape = landed.shape;
    if (!shape) continue;
    const at = (pos: number) => lineOf(u.toPanel(pos, 1));
    lines = [
      ...lines,
      ...landed.added.map((from) => ({ from: at(from), added: true, version: u.version, shape })),
      ...landed.changed.map((from) => ({ from: at(from), added: false, version: u.version, shape })),
    ];
    gone = [
      ...gone,
      ...landed.removed.map((r) => ({ at: u.toPanel(r.at, -1), count: r.count, version: u.version, shape })),
    ];
  }
  return { ...news, lines, gone, recent, touched, typing, landings, typedElsewhere, hostText };
}

export const newsField = StateField.define<News>({
  create: (state) => ({
    lines: [],
    gone: [],
    recent: [],
    toldUpTo: -1,
    touched: false,
    typing: [],
    typingKnown: false,
    landings: 0,
    typedElsewhere: 0,
    // A state is made from an init, whose text is the host's at its version, with nothing unsent.
    hostText: state.doc,
  }),
  update(value, tr) {
    let news = value;
    if (tr.docChanged) {
      const { changes } = tr;
      news = {
        ...news,
        lines: news.lines.flatMap((l) => {
          const pos = changes.mapPos(l.from, -1, MapMode.TrackDel);
          return pos === null ? [] : [{ ...l, from: tr.state.doc.lineAt(pos).from }];
        }),
        gone: news.gone.map((g) => ({ ...g, at: changes.mapPos(g.at, -1) })),
        typing: mapSpans(news.typing, changes),
      };
    }
    const updates = receivedChanges(tr);
    if (updates.length > 0) news = received(news, tr, updates);
    else if (tr.docChanged) {
      // A change made in this tab is the person's.
      const made: Span[] = [];
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => made.push({ from: fromB, to: toB }));
      news = { ...news, typing: joined([...news.typing, ...made]) };
    }
    for (const e of tr.effects) {
      if (e.is(dropNews)) news = withoutTold(news, (version) => !e.value(version));
      else if (e.is(toldNews)) {
        const upTo = Math.max(news.toldUpTo, e.value);
        news = { ...withoutTold(news, (version) => version > upTo), toldUpTo: upTo };
      } else if (e.is(unsavedNews)) {
        if (!e.value.held) news = { ...news, typing: unsentSpans(tr.state), typingKnown: true };
        else if (e.value.first) news = { ...news, typingKnown: false };
      }
    }
    return news;
  },
});
