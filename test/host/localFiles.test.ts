// The host's own files on the local disk. A whole file written through a temporary name and a
// rename (writeWhole) lands once the file it replaces is free: Windows refuses to replace a file
// another program has open, as VS Code has an open conflict file while it reads it again, or an
// agent while it reads one; the stand-in for that program here keeps the file open for HELD_MS.
// And a file VS Code's stat cannot see for another reason than that nothing is there may still be
// there (mayBeThere), so a backup is not taken for gone while a permission or a drive refuses.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mayBeThere, writeWhole } from '../../src/host/localFiles';
import { __state, Uri } from './vscodeStandIn';

vi.mock('vscode', () => import('./vscodeStandIn'));

/** How long the other program keeps the file open: a moment, well inside the time the write keeps trying. */
const HELD_MS = 200;

const folder = mkdtempSync(path.join(tmpdir(), 'tandem-whole-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('a whole-file write', () => {
  it('lands once another program that has the file open closes it', async () => {
    const file = path.join(folder, 'Field notes.md.conflict');
    writeFileSync(file, 'Before.\n');
    const held = await open(file, 'r');
    const closed = new Promise<void>((resolve) => setTimeout(() => void held.close().then(resolve), HELD_MS));
    try {
      await writeWhole(file, 'After.\n');
    } finally {
      await closed;
    }
    expect(readFileSync(file, 'utf8')).toBe('After.\n');
    expect(readdirSync(folder)).toEqual(['Field notes.md.conflict']);
  });
});

describe('whether a file may be there', () => {
  it('is false only where VS Code says nothing is there', async () => {
    const at = (name: string, answer: string) => {
      const uri = Uri.file(path.join(folder, name));
      __state.stats.set(uri.fsPath, answer);
      return uri;
    };
    expect(await mayBeThere(at('there.md', 'file') as never)).toBe(true);
    expect(await mayBeThere(at('gone.md', 'FileNotFound') as never)).toBe(false);
    expect(await mayBeThere(at('refused.md', 'NoPermissions') as never)).toBe(true);
    expect(await mayBeThere(at('drive away.md', 'Unavailable') as never)).toBe(true);
  });
});
