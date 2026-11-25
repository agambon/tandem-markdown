// What a screen reader is told when another program's change lands in the note (words.ts), and
// when: the news gathers (news.ts) until changes have stopped landing and the person has stopped
// typing, here or elsewhere, each for QUIET_MS, while the tab is shown; then the host is asked
// whether this tab tells it, since a note open in two rich tabs is told once, and the sentence
// goes to the editor's polite live region (EditorView.announce), which a screen reader speaks
// once it has finished what it is saying. What the host says of a change comes first: a message
// that speaks for it takes it out, and a warning it gave in the Problems list is named. The
// person's own press of a message's button is no news (news.ts reads its update's reason).
// docs/ARCHITECTURE.md, "What a screen reader is told". `tandemMarkdown.outsideChanges.announce`
// turns it off.

import { BlockType, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { OutsideNoticeMessage, TellOutsideResult } from '../../core/featureProtocol';
import type { HostToPanel } from '../../core/protocol';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { syncedVersion } from '../hostRanges';
import { getMode } from '../modes';
import { drawingName } from '../render/drawnBlock';
import { tabShownField } from '../tabShown';
import { dropNews, newsField, toldNews, unsavedNews, type News } from './news';
import { toldOf, toldOnYourLine, type DrawnAt } from './places';
import { outsideSentence, yourLineSentence, type Kept } from './words';

/** How long changes must stop landing, and the person stop typing, before the news is told. */
const QUIET_MS = 2000;
/** How long the news waits for the host's word on a warning a change may give in the Problems list. */
const WARNING_WAIT_MS = 5000;

/** What the host said of a change from outside, kept until the panel holds the version it names. */
type HostWord =
  | { kind: 'message'; version: number }
  | {
      kind: 'warning';
      notice: string;
      version: number;
      /** The version of the change it is about, once the panel holds `version`. */
      of: number | null;
      state: 'coming' | 'shown' | 'none';
      since: number;
    };

/** The latest version in `recent` at or before `version`, or null. */
function latestAtOrBefore(recent: readonly number[], version: number): number | null {
  let out: number | null = null;
  for (const v of recent) if (v <= version && (out === null || v > out)) out = v;
  return out;
}

/** The drawn block at a position, as the view draws it: a widget that stands in place of lines. */
function drawnAt(view: EditorView): DrawnAt {
  return (pos) => {
    const line = view.lineBlockAt(pos);
    for (const block of Array.isArray(line.type) ? line.type : [line]) {
      if (block.type !== BlockType.WidgetRange || pos < block.from || pos > block.to) continue;
      const name = drawingName(block.widget);
      if (name) return { name, from: block.from };
    }
    return null;
  };
}

const teller = ViewPlugin.fromClass(
  class {
    private readonly words: HostWord[] = [];
    private lastLanding = 0;
    private lastKey = 0;
    private heardUnsaved = false;
    private asking = false;
    /** Set once the view's state is replaced or the view goes: a reply to a question asked before is not acted on. */
    private destroyed = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly stopListening: (() => void) | undefined;
    private readonly keyDown = () => {
      this.lastKey = Date.now();
      this.soon(QUIET_MS);
    };
    private readonly visibility = () => this.soon(0);

    constructor(private readonly view: EditorView) {
      this.stopListening = view.state.facet(panelContext)?.bridge.onMessage((m) => this.heard(m));
      view.dom.addEventListener('keydown', this.keyDown, true);
      view.dom.ownerDocument.addEventListener('visibilitychange', this.visibility);
    }

    update(update: ViewUpdate): void {
      const before = update.startState.field(newsField);
      const now = update.state.field(newsField);
      if (now === before && update.startState.field(tabShownField) === update.state.field(tabShownField)) return;
      if (now.landings !== before.landings) this.lastLanding = Date.now();
      if (now.typedElsewhere !== before.typedElsewhere) this.lastKey = Date.now();
      this.soon(0);
    }

    destroy(): void {
      this.destroyed = true;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.stopListening?.();
      this.view.dom.removeEventListener('keydown', this.keyDown, true);
      this.view.dom.ownerDocument.removeEventListener('visibilitychange', this.visibility);
    }

    /** A message from the host about the note's outside changes or its unsaved changes. */
    private heard(m: HostToPanel): void {
      const message = m as HostToPanel & Record<string, unknown>;
      const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      switch (message.type) {
        case 'unsavedChanges':
          if (typeof message.held !== 'boolean') return;
          this.view.dispatch({ effects: unsavedNews.of({ held: message.held, first: !this.heardUnsaved }) });
          this.heardUnsaved = true;
          return;
        case 'outsideTold': {
          const upTo = number(message.upTo);
          if (upTo !== null) this.view.dispatch({ effects: toldNews.of(upTo) });
          return;
        }
        case 'outsideNotice':
          this.noticeHeard(message as unknown as OutsideNoticeMessage);
          break;
        default:
          return;
      }
      this.soon(0);
    }

    private noticeHeard(m: OutsideNoticeMessage): void {
      if (typeof m.notice !== 'string') return;
      if (m.tells === 'warning' || m.tells === 'none') {
        const word = this.words.find((w) => w.kind === 'warning' && w.notice === m.notice);
        if (word?.kind === 'warning') word.state = m.tells === 'warning' ? 'shown' : 'none';
        return;
      }
      if (typeof m.version !== 'number') return;
      if (m.tells === 'message') this.words.push({ kind: 'message', version: m.version });
      else if (m.tells === 'coming')
        this.words.push({
          kind: 'warning',
          notice: m.notice,
          version: m.version,
          of: null,
          state: 'coming',
          since: Date.now(),
        });
    }

    private soon(ms: number): void {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.check();
      }, ms);
    }

    /**
     * Applies what the host said of changes the panel now holds. False while a word names a
     * version the panel has not reached: it may take out news gathered since.
     */
    private settle(news: News): boolean {
      const synced = syncedVersion(this.view.state);
      const pending = new Set([...news.lines.map((l) => l.version), ...news.gone.map((g) => g.version)]);
      const drop: ((version: number) => boolean)[] = [];
      let waiting = false;
      for (let i = this.words.length - 1; i >= 0; i--) {
        const word = this.words[i]!;
        if (word.kind === 'warning') {
          if (word.of === null && word.version <= synced) word.of = latestAtOrBefore(news.recent, word.version) ?? -1;
          if (word.of === null) waiting = true;
          // About a change told already, or taken out: nothing waits on it.
          else if (!pending.has(word.of)) this.words.splice(i, 1);
          continue;
        }
        if (word.version > synced) {
          waiting = true;
          continue;
        }
        this.words.splice(i, 1);
        const of = latestAtOrBefore(news.recent, word.version);
        if (of !== null) drop.push((v) => v === of);
      }
      if (drop.length > 0) this.view.dispatch({ effects: dropNews.of((v) => drop.some((d) => d(v))) });
      return !waiting;
    }

    private check(): void {
      const { view } = this;
      const ctx = view.state.facet(panelContext);
      let news = view.state.field(newsField);
      if (news.lines.length === 0 && news.gone.length === 0) return;
      if (ctx?.settings.outsideAnnounce === false) {
        view.dispatch({ effects: toldNews.of(syncedVersion(view.state)) });
        return;
      }
      const quietAt = Math.max(this.lastLanding, this.lastKey) + QUIET_MS;
      const now = Date.now();
      if (now < quietAt) return this.soon(quietAt - now);
      if (view.state.field(tabShownField) === false || view.dom.ownerDocument.visibilityState !== 'visible') return;
      if (!this.settle(news)) return;
      news = view.state.field(newsField);
      if (news.lines.length === 0 && news.gone.length === 0) return;
      const versions = new Set([...news.lines.map((l) => l.version), ...news.gone.map((g) => g.version)]);
      const awaited = this.words.find(
        (w) => w.kind === 'warning' && w.state === 'coming' && w.of !== null && versions.has(w.of),
      );
      if (awaited?.kind === 'warning' && now < awaited.since + WARNING_WAIT_MS)
        return this.soon(awaited.since + WARNING_WAIT_MS - now);
      if (this.asking || !ctx) return;
      this.asking = true;
      const upTo = syncedVersion(view.state);
      ctx.request<TellOutsideResult>({ type: 'tellOutside', upTo }).then(
        (result) => {
          this.asking = false;
          if (this.destroyed) return;
          // Another tab of the note, the one the person is in, tells it.
          if (result === null) return this.soon(QUIET_MS);
          this.tell(result.after, upTo);
        },
        (error: unknown) => {
          this.asking = false;
          if (this.destroyed) return;
          ctx.log('warn', 'The host did not say which tab tells the outside changes; this one does', error);
          this.tell(-1, upTo);
        },
      );
    }

    /** Tells what came in updates after `after` up to `upTo`, and marks it told. */
    private tell(after: number, upTo: number): void {
      const { view } = this;
      const { state } = view;
      const news = state.field(newsField);
      const ours = (v: number) => v > after && v <= upTo;
      const lines = news.lines.filter((l) => ours(l.version));
      const gone = news.gone.filter((g) => ours(g.version));
      const problems = this.words.some(
        (w) => w.kind === 'warning' && w.state === 'shown' && w.of !== null && ours(w.of),
      );
      const fileName = state.facet(panelContext)?.doc.fileName ?? '';
      // What the change did not touch: the cursor, and the unsaved typing where the tab knows all of it.
      const kept: Kept | null = news.touched
        ? null
        : !news.typingKnown
          ? 'cursorTypingUnknown'
          : news.typing.length > 0
            ? 'cursorAndTyping'
            : 'cursorNoTyping';
      const onYourLine =
        !problems && getMode(state) === 'edit' && view.hasFocus ? toldOnYourLine(state, lines, gone, kept) : null;
      const told = onYourLine ? null : toldOf(state, lines, gone, drawnAt(view), fileName, problems);
      const sentence = onYourLine ? yourLineSentence(onYourLine) : told ? outsideSentence(told) : null;
      view.dispatch({
        effects: sentence ? [EditorView.announce.of(sentence), toldNews.of(upTo)] : [toldNews.of(upTo)],
      });
    }
  },
);

export const outsideAnnounce: Feature = {
  id: 'outsideAnnounce',
  extension: () => [newsField, tabShownField, teller],
};
