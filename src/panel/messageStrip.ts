// The message strip at the top of the tab: the message about this note that waits for the user,
// as the host sends it (`messages`; src/host/messages.ts), one at a time, with the buttons that
// still apply and, while others wait behind it, how many, as plain text after the buttons. A press
// goes to the host (`messagePressed`), which settles the message or sends it again with what
// applies then. Its look is the panel's notices' (theme/panel.css), its first button the main one.
// A screen reader hears a message as it comes, unless it popped up as well. All text goes in
// through `textContent`.

import type { StripMessage } from '../core/featureProtocol';
import type { HostBridge } from './context';

export class MessageStrip {
  private shown: StripMessage | null = null;
  private drawn = 0;

  /** `focusEditor`: where the keyboard goes when the message it was on leaves and none follows. */
  constructor(
    private readonly host: HTMLElement,
    private readonly bridge: HostBridge,
    private readonly focusEditor: () => void,
  ) {
    host.setAttribute('aria-live', 'polite');
  }

  /**
   * Shows `next` (nothing for null). The keyboard, where it was in the strip, stays on the strip's
   * first button, or goes to the editor once the strip is empty; with `focus`, it goes there now.
   */
  show(next: StripMessage | null, focus: boolean): void {
    const doc = this.host.ownerDocument;
    const hadKeyboard = this.host.contains(doc.activeElement);
    const changed = !sameMessage(this.shown, next);
    this.shown = next;
    if (changed) this.draw(next);
    if (focus || (changed && hadKeyboard)) {
      const first = this.host.querySelector('button');
      if (first) first.focus();
      else if (hadKeyboard) this.focusEditor();
    }
  }

  private draw(m: StripMessage | null): void {
    const doc = this.host.ownerDocument;
    if (!m) {
      this.host.replaceChildren();
      return;
    }
    // Heard once: through the pop-up where it popped up, else from here.
    this.host.setAttribute('aria-live', m.popped ? 'off' : 'polite');
    const box = doc.createElement('div');
    box.className = 'tm-notice tm-notice-warning tm-message';
    box.setAttribute('role', 'group');
    const text = doc.createElement('span');
    text.className = 'tm-message-text';
    text.id = `tm-message-${++this.drawn}`;
    text.textContent = m.text;
    box.setAttribute('aria-labelledby', text.id);
    const buttons = doc.createElement('div');
    buttons.className = 'tm-message-buttons';
    m.buttons.forEach((b, i) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = i === 0 ? 'tm-notice-action' : 'tm-notice-action tm-notice-action-secondary';
      button.textContent = b.label;
      button.addEventListener('click', () =>
        this.bridge.post({ type: 'messagePressed', message: m.id, button: b.does }),
      );
      buttons.appendChild(button);
    });
    box.append(text, buttons);
    if (m.more !== null) {
      const more = doc.createElement('span');
      more.className = 'tm-message-more';
      more.textContent = m.more;
      box.appendChild(more);
    }
    this.host.replaceChildren(box);
  }
}

/** The `shown` of a `messages` message as the strip takes it: a message, null for none, undefined where it is neither. */
export function stripMessageOf(value: unknown): StripMessage | null | undefined {
  if (value === null) return null;
  const m = value as Partial<StripMessage> | undefined;
  if (typeof m !== 'object' || typeof m.id !== 'string' || typeof m.text !== 'string' || !Array.isArray(m.buttons))
    return undefined;
  const buttons = m.buttons.filter(
    (b): b is StripMessage['buttons'][number] => typeof b?.does === 'string' && typeof b?.label === 'string',
  );
  return {
    id: m.id,
    text: m.text,
    buttons,
    popped: m.popped === true,
    more: typeof m.more === 'string' ? m.more : null,
  };
}

/** The same message with the same words and buttons: nothing to draw again. */
function sameMessage(a: StripMessage | null, b: StripMessage | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id && a.text === b.text && a.more === b.more && JSON.stringify(a.buttons) === JSON.stringify(b.buttons)
  );
}
