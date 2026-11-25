// Which documents' tabs scroll together (docs/ARCHITECTURE.md, "Scroll sync"). The state is one
// value per document, "linked" or "not linked", kept in memory for the window and shared by
// every tab of the document. A document the user has not toggled starts linked when
// `tandemMarkdown.scrollSync` is on and a rich tab of it is among its visible tabs; one visible
// only in Source tabs starts not linked, so VS Code's own editor scrolls as it always has until
// the user links it.

/** What the rule reads of one document's visible tabs. */
export interface VisibleTabs {
  /** The document's language is markdown. */
  markdown: boolean;
  /** How many of its visible tabs are VS Code's text editor, and how many are rich. */
  source: number;
  rich: number;
}

/**
 * True when the document's tabs can be linked: it is visible in two or more tabs, and it is
 * markdown, or another document (a `.txt` or untitled file) with a rich tab among them.
 */
export function canLink(tabs: VisibleTabs): boolean {
  return tabs.source + tabs.rich >= 2 && (tabs.markdown || tabs.rich > 0);
}

export class ScrollLinks {
  /** The user's choice for a document, by its uri. */
  private readonly chosen = new Map<string, boolean>();

  /** The user linked or unlinked a document's tabs; the choice holds whatever tabs it has. */
  choose(uri: string, linked: boolean): void {
    this.chosen.set(uri, linked);
  }

  /** Whether the document's tabs are linked now. `setting` is `tandemMarkdown.scrollSync` for it. */
  linked(uri: string, tabs: VisibleTabs, setting: boolean): boolean {
    return this.chosen.get(uri) ?? (setting && tabs.rich > 0);
  }

  /** Every choice the user made, by document. */
  choices(): [string, boolean][] {
    return [...this.chosen];
  }

  /** A document renamed: its choice goes with it. */
  renamed(from: string, to: string): void {
    const choice = this.chosen.get(from);
    if (choice === undefined) return;
    this.chosen.delete(from);
    this.chosen.set(to, choice);
  }
}
