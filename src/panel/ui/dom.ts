// DOM helpers for the panel's own controls.

/** A codicon, hidden from screen readers. */
export function icon(doc: Document, name: string): HTMLElement {
  const span = doc.createElement('span');
  span.className = `codicon codicon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

interface IconButtonOptions {
  /** The codicon's name. */
  icon: string;
  /** The tooltip. The accessible name is the label without a trailing shortcut in parentheses. */
  label: string;
  className: string;
  /** A click leaves focus where it is, in the field the user is typing in. */
  keepFocus?: boolean;
}

/** A button that shows one codicon. */
export function iconButton(doc: Document, options: IconButtonOptions): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = options.className;
  button.title = options.label;
  button.setAttribute('aria-label', options.label.replace(/ \(.*\)$/, ''));
  button.appendChild(icon(doc, options.icon));
  if (options.keepFocus) button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}
