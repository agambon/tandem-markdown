// Interface text that more than one of the host's features shows. The rich views' names, which
// the panel shows too, are the core's (`RICH_VIEW_NAME`, src/core/protocol.ts).

/**
 * A command that waited for a rich tab's typing to reach your text, and gave up: each names
 * what did not happen.
 */
export const NOT_RUN = {
  undo: "Undo didn't run. Try again in a moment.",
  redo: "Redo didn't run. Try again in a moment.",
  close: "The tab didn't close. Try again in a moment.",
  source: "Source didn't open. Try again in a moment.",
  verify: "Verify File didn't run. Try again in a moment.",
} as const;
