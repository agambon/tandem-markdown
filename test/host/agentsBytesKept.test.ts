// "Add Agent Instructions", run as the command itself on real files: what AGENTS.md held before
// the press, which the command did not write, is still there after it, byte for byte. A UTF-8
// file has the instructions added after its own lines. A file in another encoding (UTF-16, as
// Windows PowerShell's `>` writes it, or Windows-1252), a hard link to another file (CLAUDE.md,
// where a symbolic link needs rights the user lacks) and a symbolic link are left as they are.

import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ADD_THE_INSTRUCTIONS, INSTRUCTIONS_HEADING } from '../../src/host/model/conflictFile';
import { registered } from './hostStandIns';

vi.mock('vscode', async () => {
  const standIn = await import('./vscodeStandIn');
  const state = { folders: [] as unknown[], shown: [] as string[] };
  const show = async (text: string) => {
    state.shown.push(text);
    return undefined;
  };
  return {
    ...standIn,
    __state: state,
    workspace: {
      ...standIn.workspace,
      get workspaceFolders() {
        return state.folders;
      },
    },
    window: {
      ...standIn.window,
      showInformationMessage: show,
      showWarningMessage: show,
      showQuickPick: async () => undefined,
    },
    env: { clipboard: { writeText: async () => undefined } },
  };
});
vi.mock('../../src/host/commandRegistration', async () => (await import('./hostStandIns')).commandRegistration);
vi.mock('../../src/host/log', () => ({ log: () => undefined }));

const root = mkdtempSync(path.join(tmpdir(), 'tandem-agents-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A workspace folder of its own, with AGENTS.md as `write` leaves it; runs the command and presses its button. */
async function addTo(name: string, write: (dir: string) => void): Promise<{ dir: string; written: string[] }> {
  const vs = (await import('vscode')) as unknown as {
    Uri: { file(p: string): unknown };
    __state: { folders: unknown[] };
  };
  const { agentInstructions } = await import('../../src/host/agentInstructions');
  const dir = path.join(root, name);
  mkdirSync(dir);
  write(dir);
  const folder = { uri: vs.Uri.file(dir), name, index: 0 };
  vs.__state.folders = [folder];
  agentInstructions({} as never, undefined as never, true);
  const { allowAnswersForTests, answerPromptsForTests } = await import('../../src/host/questions');
  allowAnswersForTests(true);
  answerPromptsForTests(() => ADD_THE_INSTRUCTIONS);
  const result = (await registered.get('addAgentInstructions')!(folder)) as { written: string[] };
  return { dir, written: result.written };
}

/** `after` begins with every byte of `before`. */
function beginsWith(after: Buffer, before: Buffer): boolean {
  return after.length >= before.length && after.subarray(0, before.length).equals(before);
}

const OWN = '# Agents\n\nUse two spaces, and write café with its accent.\n';

describe('Add Agent Instructions, on AGENTS.md as it is on disk', () => {
  it('adds its lines after a UTF-8 file’s own, which stay byte for byte', async () => {
    const before = Buffer.from(OWN, 'utf8');
    const { dir, written } = await addTo('utf8', (d) => writeFileSync(path.join(d, 'AGENTS.md'), before));
    const after = readFileSync(path.join(dir, 'AGENTS.md'));
    expect(written).toContain('AGENTS.md');
    expect(beginsWith(after, before)).toBe(true);
    expect(after.toString('utf8')).toContain(INSTRUCTIONS_HEADING);
  });

  it.each([
    ['UTF-16', 'utf16', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(OWN, 'utf16le')])],
    ['Windows-1252', 'windows1252', Buffer.from(OWN, 'latin1')],
  ])('leaves the bytes of a %s file as they were', async (_encoding, name, before) => {
    const { dir } = await addTo(name, (d) => writeFileSync(path.join(d, 'AGENTS.md'), before));
    const after = readFileSync(path.join(dir, 'AGENTS.md'));
    expect(beginsWith(after, before)).toBe(true);
  });

  it('leaves AGENTS.md and CLAUDE.md one file where they are hard links to it', async () => {
    const { dir } = await addTo('hardlink', (d) => {
      writeFileSync(path.join(d, 'CLAUDE.md'), OWN, 'utf8');
      linkSync(path.join(d, 'CLAUDE.md'), path.join(d, 'AGENTS.md'));
    });
    const agents = statSync(path.join(dir, 'AGENTS.md'), { bigint: true });
    const claude = statSync(path.join(dir, 'CLAUDE.md'), { bigint: true });
    // Left alone as one file; either way CLAUDE.md holds what it held.
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(OWN);
    expect(agents.ino === claude.ino).toBe(true);
  });

  /** Whether this machine lets the test make a symbolic link (Windows needs a right for it). */
  const canLink = (() => {
    const probe = path.join(root, 'probe');
    try {
      writeFileSync(`${probe}.target`, '');
      symlinkSync(`${probe}.target`, `${probe}.link`);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!canLink)('leaves a symbolic link to CLAUDE.md, and CLAUDE.md, as they were', async () => {
    const { dir, written } = await addTo('symlink', (d) => {
      writeFileSync(path.join(d, 'CLAUDE.md'), OWN, 'utf8');
      symlinkSync(path.join(d, 'CLAUDE.md'), path.join(d, 'AGENTS.md'));
    });
    expect(written).not.toContain('AGENTS.md');
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(OWN);
  });
});
