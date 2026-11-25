// Read-only documents of texts the host holds in memory, for VS Code's comparisons: what a rich
// tab showed, or what the file on disk held, when Verify File ran. Each text has its own
// address, whose last part is the note's name, so the comparison's tab and language follow the
// note. A text is let go when VS Code closes its document, and the oldest are let go once more
// than MAX_HELD are held, so texts nobody opened do not pile up.

import * as vscode from 'vscode';

const SCHEME = 'tandem-markdown-text';
const MAX_HELD = 8;

export class HeldTexts implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private next = 0;
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: (uri) => this.texts.get(uri.toString()) ?? '',
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.scheme === SCHEME) this.texts.delete(d.uri.toString());
      }),
    );
  }

  /** Holds `text` and returns the address of its read-only document, named `name`. */
  hold(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++this.next}/${name || 'note.md'}` });
    this.texts.set(uri.toString(), text);
    while (this.texts.size > MAX_HELD) this.texts.delete(this.texts.keys().next().value!);
    return uri;
  }

  dispose(): void {
    this.registration.dispose();
    this.texts.clear();
  }
}
