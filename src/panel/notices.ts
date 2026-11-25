// The notice strip, drawn into `slots.notices`.
//
// Notices stack, newest at the bottom. Each has a dismiss button and its actions as buttons;
// pressing one closes the notice, except a `closeWhenDone` action, whose notice closes only once
// the action succeeds. A `sticky` notice stays until dismissed; any other leaves after
// LIFETIME_MS (the timer pauses while the pointer is over it, so an action can still be
// reached). A notice with the same kind and text as one already showing is not added twice;
// the one showing restarts its timer.
//
// All text goes in through `textContent`.

import type { Notice, NoticeAction } from './context';

const LIFETIME_MS = 8000;

interface Shown {
  notice: Notice;
  element: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  hovered: boolean;
}

export interface NoticeHandle {
  close(): void;
  readonly open: boolean;
}

export class NoticeStrip {
  private readonly shown: Shown[] = [];

  constructor(private readonly host: HTMLElement) {
    host.setAttribute('aria-live', 'polite');
  }

  show(notice: Notice): NoticeHandle {
    const twin = this.shown.find((s) => s.notice.kind === notice.kind && s.notice.text === notice.text);
    if (twin) {
      this.startTimer(twin);
      return this.handle(twin);
    }
    const doc = this.host.ownerDocument;
    const element = doc.createElement('div');
    element.className = `tm-notice tm-notice-${notice.kind}`;
    element.setAttribute('role', notice.kind === 'info' ? 'status' : 'alert');

    const text = doc.createElement('span');
    text.className = 'tm-notice-text';
    text.textContent = notice.text;
    element.appendChild(text);

    const shown: Shown = { notice, element, timer: null, hovered: false };

    for (const action of notice.actions ?? []) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'tm-notice-action';
      button.textContent = action.label;
      button.addEventListener('click', () => this.press(shown, action, button));
      element.appendChild(button);
    }

    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'tm-notice-close';
    close.title = 'Dismiss';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => this.remove(shown));
    element.appendChild(close);

    element.addEventListener('mouseenter', () => {
      shown.hovered = true;
      this.clearTimer(shown);
    });
    element.addEventListener('mouseleave', () => {
      shown.hovered = false;
      this.startTimer(shown);
    });

    this.host.appendChild(element);
    this.shown.push(shown);
    this.startTimer(shown);
    return this.handle(shown);
  }

  /** A button pressed: the notice closes first, or for `closeWhenDone`, once the action says it is done. */
  private press(shown: Shown, action: NoticeAction, button: HTMLButtonElement): void {
    if (!action.closeWhenDone) {
      this.remove(shown);
      const failed = (error: unknown) => console.error('Tandem Markdown: notice action failed', error);
      try {
        Promise.resolve(action.run()).catch(failed);
      } catch (error) {
        failed(error);
      }
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    Promise.resolve()
      .then(async () => (await action.run()) === true)
      .then(
        (done) => {
          if (done) this.remove(shown);
          else button.disabled = false;
        },
        (error: unknown) => {
          console.error('Tandem Markdown: notice action failed', error);
          button.disabled = false;
        },
      );
  }

  clear(): void {
    for (const s of [...this.shown]) this.remove(s);
  }

  private handle(shown: Shown): NoticeHandle {
    return {
      close: () => this.remove(shown),
      get open() {
        return shown.element.isConnected;
      },
    };
  }

  private startTimer(shown: Shown): void {
    this.clearTimer(shown);
    if (shown.notice.sticky || shown.hovered) return;
    shown.timer = setTimeout(() => this.remove(shown), LIFETIME_MS);
  }

  private clearTimer(shown: Shown): void {
    if (shown.timer !== null) clearTimeout(shown.timer);
    shown.timer = null;
  }

  private remove(shown: Shown): void {
    this.clearTimer(shown);
    const index = this.shown.indexOf(shown);
    if (index >= 0) this.shown.splice(index, 1);
    shown.element.remove();
  }
}
