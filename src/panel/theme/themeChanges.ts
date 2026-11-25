// When VS Code changes the page's theme. VS Code 1.120 to 1.146 give a webview the theme's kind as
// classes on <body> and its colors as properties of the root element's style, so a change to
// either is a change of theme.

/** Calls `changed` each time VS Code changes the theme of `doc`; gives the function that stops it. */
export function onThemeChange(doc: Document, changed: () => void): () => void {
  const watch = new MutationObserver(changed);
  watch.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  watch.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
  return () => watch.disconnect();
}
