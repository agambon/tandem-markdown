// The lost-contact warning. A push or a resync request starts the watch. Only the answer ends
// it and takes the notice away: an `updates` message holding this view's own changes, a
// `pushRejected` for this view, or an `init`. Other messages (updates from elsewhere, link
// answers) say nothing about whether the push landed.

import type { HostToPanel, PanelToHost } from '../core/protocol';
import type { Notice } from './context';
import type { NoticeHandle } from './notices';

/**
 * The lost-contact warning: no answer has come from the host for this long after a push or a
 * resync request. PanelSync has asked for a resync by then, and from that request the view
 * takes no edits (sync.ts `resyncPending`), so the warning says that.
 */
const LOST_CONTACT_MS = 10_000;
const LOST_CONTACT_TEXT =
  "This tab can't take typing right now, because VS Code isn't responding to it. Wait, or switch to Source.";
/** The same warning in the rare case the view still takes edits (an answer waiting behind IME composition). */
const LOST_CONTACT_EDITABLE_TEXT =
  "VS Code isn't responding to this tab, so what you type here may be lost. Wait, or switch to Source.";

interface ContactOptions {
  /** True once the panel has failed or been disposed: nothing more is shown. */
  stopped(): boolean;
  /** Shows a notice in the page; null before the first init, when there is nowhere to show it. */
  showNotice(notice: Notice): NoticeHandle | null;
  /** The view still takes edits. */
  editable(): boolean;
  post(message: PanelToHost): void;
}

export class ContactWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notice: NoticeHandle | null = null;
  /** The client id of the latest init: the host's answers to this view's pushes carry it. */
  clientId: string | null = null;

  constructor(private readonly o: ContactOptions) {}

  /** A push or a resync request went out. */
  watch(): void {
    // Already watching, or the warning is showing: it stays until the answer comes (or the user dismisses it).
    if (this.timer !== null || this.notice?.open || this.o.stopped()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.o.stopped()) return;
      this.notice?.close();
      this.notice = this.o.showNotice({
        kind: 'error',
        text: this.o.editable() ? LOST_CONTACT_EDITABLE_TEXT : LOST_CONTACT_TEXT,
        sticky: true,
        actions: [{ label: 'Show Source', run: () => this.o.post({ type: 'showSource' }) }],
      });
    }, LOST_CONTACT_MS);
  }

  /** Every host message passes here; one that answers this view ends the watch. */
  heard(m: HostToPanel): void {
    if (!this.answersThisView(m)) return;
    this.dispose();
    this.notice?.close();
    this.notice = null;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** True for a host message that answers this view's push or resync request. */
  private answersThisView(m: HostToPanel): boolean {
    if (m.type === 'init') return true;
    if (m.type === 'pushRejected') return (m as { clientId?: unknown }).clientId === this.clientId;
    if (m.type !== 'updates') return false;
    const updates = (m as { updates?: unknown }).updates;
    return (
      Array.isArray(updates) && updates.some((u) => !!u && (u as { clientId?: unknown }).clientId === this.clientId)
    );
  }
}
