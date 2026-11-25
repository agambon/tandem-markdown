// Line endings. Everything in src/core works on LF text; VS Code writes CRLF back when it applies
// an edit to a CRLF document.

/**
 * Every "\r\n" and every lone "\r" becomes "\n": VS Code and CodeMirror both take a lone "\r" as
 * a line break, so a file holding one must compare equal to what VS Code loaded from it.
 */
export function toLf(text: string): string {
  if (text.indexOf('\r') < 0) return text;
  return text.replace(/\r\n?/g, '\n');
}
