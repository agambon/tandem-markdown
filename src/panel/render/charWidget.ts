// A widget that draws one character in place of the text it stands for: an emoji code's emoji
// (emoji.ts), an entity's character (emphasis.ts).

import type { EditorView } from '@codemirror/view';
import { RichWidget } from './framework';

/** One character in place of its source: it reads as that character, and a click on it places the cursor. */
export abstract class CharWidget extends RichWidget {
  constructor(
    source: string,
    readonly char: string,
  ) {
    super(source);
  }

  override sameAs(other: this): boolean {
    return other.char === this.char;
  }

  override get plainText(): string {
    return this.char;
  }

  /** A click places the cursor, as on any character. */
  override ignores(): boolean {
    return false;
  }

  /** The character in a span of class `className`. */
  protected charSpan(view: EditorView, className: string): HTMLElement {
    const span = view.dom.ownerDocument.createElement('span');
    span.className = className;
    span.textContent = this.char;
    return span;
  }
}
