// The page shown when the panel cannot start. It imports nothing, so `main.ts` can draw it
// when the rest of the panel's code did not load.

const FAILURE_TEXT = 'Tandem Markdown could not start in this tab.';
const FAILURE_BUTTON = 'Show Source';

/** "Tandem Markdown could not start in this tab." and a Show Source button; nothing else. Returns the button. */
export function showFailurePage(root: HTMLElement, showSource: () => void): HTMLButtonElement {
  const doc = root.ownerDocument;
  root.classList.add('tm-root');
  const box = doc.createElement('div');
  box.className = 'tm-notice tm-notice-error tm-failed';
  box.setAttribute('role', 'alert');
  const text = doc.createElement('span');
  text.className = 'tm-notice-text';
  text.textContent = FAILURE_TEXT;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'tm-notice-action';
  button.textContent = FAILURE_BUTTON;
  button.addEventListener('click', () => {
    try {
      showSource();
    } catch (error) {
      console.error('Tandem Markdown: could not ask for Source', error);
    }
  });
  box.append(text, button);
  root.replaceChildren(box);
  return button;
}
