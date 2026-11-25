// Add Agent Instructions run again after its section in AGENTS.md was edited by hand and lines
// were added below it. A section "Tandem Markdown" that the user has edited by hand is no text
// this command wrote, so it cannot know where its own lines end. The dialog still says "the rest
// of AGENTS.md is not touched": whatever was added below the section later, with no heading of its
// own, must stay.

import { describe, expect, it } from 'vitest';
import { agentsPlan } from '../../../src/host/model/agentInstructions';
import { INSTRUCTIONS } from '../../../src/host/model/conflictFile';

describe('AGENTS.md, a second run after the section was edited by hand and lines were added below', () => {
  it('keeps the lines added below', () => {
    const edited = INSTRUCTIONS.replace('Two habits', 'Three habits').replace(
      'before going on.\n',
      'before going on.\n- Run the formatter after each write.\n',
    );
    const before = `# Agents\n\nUse two spaces.\n\n${edited}\nRelease notes go in CHANGELOG.md, newest first.\n`;
    const plan = agentsPlan(before);
    // A section changed by hand is left as it is, and the command says so.
    expect(plan.place).toBe('edited');
    expect(plan.text).toBe(before);
  });
});
