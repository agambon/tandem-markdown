// The panel commands on the focused text field, through the command registry, on a stand-in
// view (helpers.ts).

import { describe, expect, it, vi } from 'vitest';
import { panelCommands, runCommand } from '../../src/panel/commands/registry';
import { standInView, stateOf } from './helpers';

describe('the field commands', () => {
  it('are in the editor under the ids the host forwards', () => {
    const commands = standInView(stateOf('')).state.facet(panelCommands);
    for (const id of ['fieldUndo', 'fieldRedo']) expect(commands.has(id)).toBe(true);
  });

  it("fieldUndo and fieldRedo run the browser's own history on a focused field only", () => {
    const view = standInView(stateOf('‸x'));
    const exec = vi.fn(() => true);
    const doc = view.dom.ownerDocument as unknown as { activeElement: unknown; execCommand: (c: string) => boolean };
    doc.execCommand = exec;
    doc.activeElement = { tagName: 'TEXTAREA' };
    expect(runCommand(view, 'fieldUndo')).toBe(true);
    expect(runCommand(view, 'fieldRedo')).toBe(true);
    expect(exec.mock.calls).toEqual([['undo'], ['redo']]);
    doc.activeElement = view.contentDOM;
    expect(runCommand(view, 'fieldUndo')).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
