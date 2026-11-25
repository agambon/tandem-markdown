/// <reference types="mocha" />
// Add Agent Instructions in a real VS Code: it shows the lines and where they go, writes only on
// its own button, to AGENTS.md and to .claude/rules/tandem-markdown.md, never CLAUDE.md, and
// changes nothing on a second run. Its questions are answered through the test hook.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AddResult } from '../../src/host/agentInstructions';
import { RULE_TEXT } from '../../src/host/model/agentInstructions';
import {
  ADD_THE_INSTRUCTIONS,
  ADD_TO_FOLDER,
  AGENTS_PLACE,
  ALREADY_BOTH,
  CLAUDE_MD_UNCHANGED,
  INSTRUCTIONS,
  INSTRUCTIONS_WRITTEN,
  LINES_GO,
  RULE_HAS,
  RULE_PLACE,
} from '../../src/host/model/conflictFile';
import { fill } from '../../src/host/model/templates';
import { api, note, workspaceDir } from './helpers';

/** Runs the command, every question it asks answered with `answer` (undefined: nothing pressed). */
async function run(answer: string | undefined): Promise<AddResult> {
  (await api()).answerPrompts(() => answer);
  return vscode.commands.executeCommand<AddResult>('tandemMarkdown.addAgentInstructions');
}

suite('Add Agent Instructions', () => {
  const agents = () => path.join(workspaceDir(), 'AGENTS.md');
  const rule = () => path.join(workspaceDir(), '.claude', 'rules', 'tandem-markdown.md');
  const claude = () => path.join(workspaceDir(), 'CLAUDE.md');
  const clear = () => {
    for (const file of [agents(), rule(), claude()]) rmSync(file, { force: true });
  };

  setup(clear);
  teardown(clear);
  suiteTeardown(async () => {
    (await api()).answerPrompts(undefined);
  });

  test('shows the lines and where they go, writes both files only on its own button, then has them', async () => {
    let r = await run(undefined);
    note(`asked: ${r.prompt?.message}`);
    assert.equal(r.prompt?.message, fill(ADD_TO_FOLDER, { folder: path.basename(workspaceDir()) }));
    assert.ok(r.prompt?.detail.startsWith(fill(LINES_GO, { places: `${AGENTS_PLACE.new}, and ${RULE_PLACE.new}` })));
    assert.ok(r.prompt?.detail.endsWith(INSTRUCTIONS.trimEnd()), 'the dialog shows the lines themselves');
    assert.equal(existsSync(agents()), false, 'nothing is written without the button');
    assert.equal(existsSync(rule()), false);

    r = await run(ADD_THE_INSTRUCTIONS);
    assert.equal(r.reply, INSTRUCTIONS_WRITTEN);
    assert.equal(readFileSync(agents(), 'utf8'), INSTRUCTIONS);
    assert.equal(readFileSync(rule(), 'utf8'), RULE_TEXT);
    assert.equal(existsSync(claude()), false, 'CLAUDE.md is never written');

    r = await run(ADD_THE_INSTRUCTIONS);
    assert.equal(r.reply, ALREADY_BOTH);
    assert.equal(r.prompt, undefined, 'nothing is asked when both have them');
  });

  test('adds its section at the end of an AGENTS.md of other text, and leaves CLAUDE.md alone', async () => {
    writeFileSync(agents(), '# Agents\n\nUse two spaces.\n');
    writeFileSync(claude(), '# Mine\n');
    mkdirSync(path.dirname(rule()), { recursive: true });
    writeFileSync(rule(), RULE_TEXT);
    const r = await run(ADD_THE_INSTRUCTIONS);
    assert.ok(
      r.prompt?.detail.startsWith(`${fill(LINES_GO, { places: AGENTS_PLACE.end })} ${CLAUDE_MD_UNCHANGED} ${RULE_HAS}`),
      `the dialog says: ${r.prompt?.detail}`,
    );
    assert.equal(readFileSync(agents(), 'utf8'), `# Agents\n\nUse two spaces.\n\n${INSTRUCTIONS}`);
    assert.equal(readFileSync(claude(), 'utf8'), '# Mine\n');
  });
});
