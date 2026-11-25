// Panel commands by id. A feature provides its commands in `Feature.commands`, and the editor
// puts them in its state through `panelCommands`. The host's `command { id, args }` message and
// the toolbar both run commands through `runCommand`, so a command is written once.
//
// Ids are the host's command ids without the `tandemMarkdown.` prefix: `toggleBold`, `insertTable`.

import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { panelContext } from '../context';

export type PanelCommand = (view: EditorView, args?: unknown) => boolean;

/** The commands of every feature in the state, by id. */
export const panelCommands = Facet.define<Readonly<Record<string, PanelCommand>>, ReadonlyMap<string, PanelCommand>>({
  combine: (tables) => new Map(tables.flatMap((table) => Object.entries(table))),
});

/** Runs a command. False when it did nothing, when the id is unknown, or when it threw (which is logged). */
export function runCommand(view: EditorView, id: string, args?: unknown): boolean {
  const run = view.state.facet(panelCommands).get(id);
  const ctx = view.state.facet(panelContext);
  if (!run) {
    ctx?.log('warn', `Unknown panel command "${id}"`);
    return false;
  }
  try {
    return run(view, args);
  } catch (error) {
    if (ctx) ctx.log('error', `The panel command "${id}" failed`, error);
    else console.error(`Tandem Markdown: the panel command "${id}" failed`, error);
    return false;
  }
}
