// One value each live panel is kept told of, such as whether its note holds unsaved changes
// (announce.ts) or whether git lists it as in conflict (gitConflicts.ts): posted only when it
// differs from what that panel holds.

import type * as vscode from 'vscode';
import type { HostToPanel } from '../core/protocol';
import { panels, type HostPanel } from './panels';

/**
 * From each init a panel holds `fromInit`, or nothing where that is undefined, and is told at
 * once; `tell` tells it again where its value now differs. A panel that goes is forgotten.
 */
export class PanelValue<T> implements vscode.Disposable {
  /** What each live panel holds, by panel id. */
  private readonly held = new Map<string, T>();
  private readonly listening: vscode.Disposable[];

  constructor(
    private readonly valueOf: (panel: HostPanel) => T,
    private readonly message: (value: T) => HostToPanel,
    fromInit?: T,
  ) {
    this.listening = [
      panels.onDidBecomeLive((p) => {
        if (fromInit === undefined) this.held.delete(p.id);
        else this.held.set(p.id, fromInit);
        this.tell(p);
      }),
      panels.onDidChangePanels(() => {
        const open = new Set(panels.all().map((p) => p.id));
        for (const id of this.held.keys()) if (!open.has(id)) this.held.delete(id);
      }),
    ];
  }

  /** Tells `panel` its value, where it is live and holds another. */
  tell(panel: HostPanel): void {
    if (!panel.live || panel.disposed) return;
    const value = this.valueOf(panel);
    if (this.held.has(panel.id) && this.held.get(panel.id) === value) return;
    this.held.set(panel.id, value);
    void panel.post(this.message(value));
  }

  dispose(): void {
    for (const d of this.listening) d.dispose();
    this.held.clear();
  }
}
