// The reconciler's reads, through the reading thread.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileBytes, statFile, stopFileReads } from '../../../src/host/model/fileReads';

const dir = mkdtempSync(join(tmpdir(), 'tandem-markdown-reads-'));
afterAll(() => {
  stopFileReads();
  rmSync(dir, { recursive: true, force: true });
});

describe('the file reads', () => {
  it("read a file's bytes exactly, and its size", async () => {
    const path = join(dir, 'note.md');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xe2, 0x9f]);
    writeFileSync(path, bytes);
    const r = await readFileBytes(path);
    expect(r.ok && Array.from(r.bytes)).toEqual(Array.from(bytes));
    expect((await statFile(path))?.size).toBe(bytes.length);
  });

  it('say a missing file is missing, many reads at once included', async () => {
    const path = join(dir, 'none.md');
    const reads = await Promise.all([1, 2, 3].map(() => readFileBytes(path)));
    for (const r of reads) expect(r.ok ? 'read' : r.error).toBe('missing');
    expect(await statFile(path)).toBeNull();
  });
});
