// The table commands, through the command registry, on a stand-in view (helpers.ts).

import { describe, expect, it } from 'vitest';
import { panelCommands, runCommand } from '../../../src/panel/commands/registry';
import { TABLE_EVENT } from '../../../src/panel/tables/edits';
import { standInView, stateOf } from '../helpers';

describe('the table commands', () => {
  it('are in the editor under the ids the host forwards', () => {
    const commands = standInView(stateOf('')).state.facet(panelCommands);
    for (const id of ['insertTable', 'alignTable']) expect(commands.has(id)).toBe(true);
  });

  it("insertTable puts a 3 by 3 table at the cursor's line, the cursor after it", () => {
    const view = standInView(stateOf('Pa‸ra\n\nNext\n'));
    expect(runCommand(view, 'insertTable')).toBe(true);
    const text = view.state.doc.toString();
    expect(text).toBe(
      'Para\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n\nNext\n',
    );
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('');
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(7);
  });

  it('insertTable does nothing in Rich view', () => {
    const view = standInView(stateOf('‸Para\n', { mode: 'view' }));
    expect(runCommand(view, 'insertTable')).toBe(false);
    expect(view.state.doc.toString()).toBe('Para\n');
  });

  it('alignTable pads the table the selection is in, as one change that is not typing', () => {
    const text = 'Top\n\n| a | long header |\n| --- | --- |\n| wide cell | x |\n';
    const view = standInView(stateOf(text.replace('wide', '‸wide')));
    expect(runCommand(view, 'alignTable')).toBe(true);
    expect(view.state.doc.toString()).toBe(
      'Top\n\n| a         | long header |\n| --------- | ----------- |\n| wide cell | x           |\n',
    );
    expect(view.specs).toHaveLength(1);
    expect((view.specs[0] as { userEvent?: string }).userEvent).toBe(TABLE_EVENT);
  });

  it('alignTable outside a table does nothing', () => {
    const view = standInView(stateOf('Ju‸st text\n'));
    expect(runCommand(view, 'alignTable')).toBe(false);
  });
});
