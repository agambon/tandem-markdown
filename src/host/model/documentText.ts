// A VS Code document's whole text, read from it at most once per version.

/** What `documentText` needs of a VS Code `TextDocument`. */
interface VersionedText {
  readonly version: number;
  getText(): string;
}

const read = new WeakMap<VersionedText, { version: number; text: string }>();

/**
 * The document's whole text, read from it at most once per version. VS Code joins its lines
 * on every `getText()`, and the version changes with every change to the text.
 */
export function documentText(document: VersionedText): string {
  const seen = read.get(document);
  if (seen && seen.version === document.version) return seen.text;
  const text = document.getText();
  read.set(document, { version: document.version, text });
  return text;
}
