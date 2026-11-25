// Add Agent Instructions run again after lines were added below its section in AGENTS.md. The
// first run puts the section at the end of the file, so whatever the user or another tool adds
// below it later sits under the same heading, and a second run must not delete those lines.

import { describe, expect, it } from 'vitest';
import { agentsPlan } from '../../../src/host/model/agentInstructions';

/** AGENTS.md after a first run, with lines added below the instructions afterward. */
function afterFirstRun(added: string): string {
  const first = agentsPlan('# Agents\n\nUse two spaces.\n');
  expect(first.place).toBe('end');
  return `${first.text}\n${added}`;
}

describe('AGENTS.md, a second run after lines were added below the instructions', () => {
  it('keeps a line added at the end with no heading of its own', () => {
    const before = afterFirstRun('- Use pnpm, not npm.\n');
    const plan = agentsPlan(before);
    expect(plan.text).toContain('- Use pnpm, not npm.');
  });

  it('keeps a section added at the end under a level-three heading', () => {
    const before = afterFirstRun('### Release checklist\n\n- Bump the version.\n');
    const plan = agentsPlan(before);
    expect(plan.text).toContain('### Release checklist');
    expect(plan.text).toContain('- Bump the version.');
  });

  it('keeps a section added at the end under a setext heading', () => {
    const before = afterFirstRun('Testing\n-------\n\nRun the tests before a commit.\n');
    const plan = agentsPlan(before);
    expect(plan.text).toContain('Run the tests before a commit.');
  });
});
