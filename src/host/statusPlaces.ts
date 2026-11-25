// Where each of the extension's status bar items stands, all on the right of the status bar, where
// a higher priority sits further left: a warning that a file cannot be read or that merge on save
// is off, then the count of open conflict file parts, then waiting strip messages, then Tab Moves
// Focus, the word count and the view's name.

export const STATUS_PRIORITY = {
  warning: 1000,
  conflictFiles: 999,
  waitingMessages: 998,
  tabMovesFocus: 102,
  wordCount: 101,
  view: 100,
} as const;
