// The titles the Command Palette shows for the extension's commands, read from its manifest,
// so a message about a command names it as the user knows it.

/**
 * Each command's title by its id after `prefix` (`tandemMarkdown.`), from the manifest's
 * `contributes.commands`. Entries without a string id and title are left out.
 */
export function commandTitles(manifest: unknown, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  const list = (manifest as { contributes?: { commands?: unknown } } | null | undefined)?.contributes?.commands;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const { command, title } = (entry ?? {}) as { command?: unknown; title?: unknown };
    if (typeof command !== 'string' || typeof title !== 'string' || !command.startsWith(prefix)) continue;
    out.set(command.slice(prefix.length), title);
  }
  return out;
}

/** "«title» didn't work: «what went wrong»", for a command that threw. */
export function commandFailedText(title: string | undefined, error: string): string {
  return `${title ?? 'That command'} didn't work: ${error}`;
}
