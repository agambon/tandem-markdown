// Text for VS Code's notifications, which draws `[label](command:...)` and the like in a
// notification as a link, a command link running its command. A file name can hold that syntax on
// macOS and Linux, so every notice text built from a name, a path or an error passes plainNotice.

/** The text with every `](` broken by a zero-width space: VS Code's link pattern needs the two side by side. */
export function plainNotice(text: string): string {
  return text.replace(/\]\(/g, ']\u200b(');
}
