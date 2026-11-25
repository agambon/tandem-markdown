// The one front matter rule (src/core/frontmatter.ts), used by the panel's parser, the outline
// and the word count.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ReadableText, findFrontmatterEnd } from '../../src/core/frontmatter';
import { seeded } from '../random';

/** The rule as src/core/frontmatter.ts states it, written out line by line. */
function byLines(text: string): number {
  const lines = text.split('\n');
  if (lines.length < 2 || lines[0] !== '---') return -1;
  let offset = 4;
  for (let k = 1; k < lines.length; k++) {
    if (lines[k] === '---' || lines[k] === '...') return offset + 3;
    offset += lines[k]!.length + 1;
  }
  return -1;
}

/** A parser-style input over `text`, counting how far it was read. */
function reader(text: string): ReadableText & { readTo: number } {
  const r = {
    length: text.length,
    readTo: 0,
    read(from: number, to: number) {
      r.readTo = Math.max(r.readTo, to);
      return text.slice(from, to);
    },
  };
  return r;
}

describe('findFrontmatterEnd', () => {
  it('ends just after the closing line, closed by --- or ...', () => {
    expect(findFrontmatterEnd('---\ntitle: x\n---\n# Title\n')).toBe('---\ntitle: x\n---'.length);
    expect(findFrontmatterEnd('---\ntitle: x\n...\nText')).toBe('---\ntitle: x\n...'.length);
    expect(findFrontmatterEnd('---\n---')).toBe(7);
    expect(findFrontmatterEnd('---\ntitle: x\n---')).toBe('---\ntitle: x\n---'.length);
  });

  it('takes no unclosed block, nothing but line 1, and only exact fence lines', () => {
    expect(findFrontmatterEnd('# Title\n')).toBe(-1);
    expect(findFrontmatterEnd('---\ntitle: x\n')).toBe(-1);
    expect(findFrontmatterEnd('---\n')).toBe(-1);
    expect(findFrontmatterEnd('---')).toBe(-1);
    expect(findFrontmatterEnd('--- \ntitle: x\n---\n')).toBe(-1);
    expect(findFrontmatterEnd('----\ntitle: x\n---\n')).toBe(-1);
    expect(findFrontmatterEnd(' ---\ntitle: x\n---\n')).toBe(-1);
    expect(findFrontmatterEnd('\n---\ntitle: x\n---\n')).toBe(-1);
    expect(findFrontmatterEnd('---\ntitle: x\n--- \n----\n---\nText')).toBe('---\ntitle: x\n--- \n----\n---'.length);
  });

  it('reads TOML between +++ lines, closed only by +++', () => {
    expect(findFrontmatterEnd('+++\ntitle = "x"\n+++\nText')).toBe('+++\ntitle = "x"\n+++'.length);
    expect(findFrontmatterEnd('+++\ntitle = "x"\n---\nText')).toBe(-1);
    expect(findFrontmatterEnd('---\ntitle: x\n+++\nText')).toBe(-1);
    expect(findFrontmatterEnd('++++\na = 1\n+++\n')).toBe(-1);
  });

  it('gives the same answer over a parser input as over a string, long lines included', () => {
    const line = fc.oneof(
      fc.constantFrom('---', '...', '--- ', '----', '', 'title: x', '# H', '..'),
      fc.integer({ min: 4000, max: 9000 }).map((n) => 'x'.repeat(n)),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), fc.boolean(), (lines, trailingBreak) => {
        const text = lines.join('\n') + (trailingBreak && lines.length > 0 ? '\n' : '');
        const want = byLines(text);
        expect(findFrontmatterEnd(text)).toBe(want);
        expect(findFrontmatterEnd(reader(text))).toBe(want);
      }),
      seeded({ numRuns: 1000 }),
    );
  });

  it('reads a parser input only a little past the closing line', () => {
    const text = `---\ntitle: x\n---\n${'Body text.\n'.repeat(50_000)}`;
    const input = reader(text);
    expect(findFrontmatterEnd(input)).toBe('---\ntitle: x\n---'.length);
    expect(input.readTo).toBeLessThan(10_000);
    const plain = reader(`# No frontmatter\n${'Body text.\n'.repeat(50_000)}`);
    expect(findFrontmatterEnd(plain)).toBe(-1);
    expect(plain.readTo).toBe(4);
  });
});
