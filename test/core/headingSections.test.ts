// Unit tests for heading section ranges and outline section reordering.

import { describe, expect, it } from 'vitest';
import {
  allFoldableHeadings,
  headingSectionAtLine,
  lineSourceOf,
  moveOutlineSection,
} from '../../src/core/headingSections';
import { buildOutline } from '../../src/core/outline';

describe('headingSectionAtLine & allFoldableHeadings', () => {
  it('computes nested section boundaries and ignores # comments inside code fences', () => {
    const doc = [
      '# One',
      '',
      'Intro text.',
      '',
      '```sh',
      '# Not a heading',
      'echo hi',
      '```',
      '',
      '## Sub',
      '',
      'Sub body.',
      '',
      '# Two',
      '',
      'Second body.',
      '',
    ].join('\n');
    const src = lineSourceOf(doc);

    const one = headingSectionAtLine(src, 1);
    expect(one).not.toBeNull();
    expect(one!.level).toBe(1);
    expect(one!.hasBody).toBe(true);
    expect(one!.sectionEndLine).toBe(13); // blank line right before `# Two`

    const sub = headingSectionAtLine(src, 10);
    expect(sub).not.toBeNull();
    expect(sub!.level).toBe(2);
    expect(sub!.sectionEndLine).toBe(13);

    const two = headingSectionAtLine(src, 14);
    expect(two).not.toBeNull();
    expect(two!.sectionEndLine).toBe(src.lines);

    const all = allFoldableHeadings(src);
    expect(all.map((s) => s.headLine)).toEqual([1, 10, 14]);
  });

  it('marks empty headings followed directly by a peer heading as not foldable', () => {
    const doc = '# Empty\n\n# Full\n\nBody.\n\n# Tail\n';
    const src = lineSourceOf(doc);
    expect(headingSectionAtLine(src, 1)?.hasBody).toBe(false);
    expect(headingSectionAtLine(src, 3)?.hasBody).toBe(true);
    expect(headingSectionAtLine(src, 7)?.hasBody).toBe(false);
    expect(allFoldableHeadings(src).map((s) => s.headLine)).toEqual([3]);
  });

  it('supports Setext headings and skips YAML front matter', () => {
    const doc = '---\ntitle: Test\n---\n\nTitle\n=====\n\nBody line.\n';
    const src = lineSourceOf(doc);
    const all = allFoldableHeadings(src);
    expect(all).toHaveLength(1);
    expect(all[0]!.headLine).toBe(5);
    expect(all[0]!.headEndLine).toBe(6);
    expect(all[0]!.level).toBe(1);
    expect(all[0]!.hasBody).toBe(true);
  });
});

describe('moveOutlineSection', () => {
  it('moves a heading with its nested subtree before or after another section', () => {
    const doc = '# Alpha\n\nA body.\n\n## Alpha Child\n\nChild body.\n\n# Beta\n\nB body.\n\n# Gamma\n\nG body.\n';
    const headings = buildOutline(doc);
    // Move Alpha (index 0, includes Alpha Child index 1) after Beta (index 2).
    const movedDown = moveOutlineSection(doc, headings, 0, 2, 'after');
    expect(movedDown).toBe(
      '# Beta\n\nB body.\n\n# Alpha\n\nA body.\n\n## Alpha Child\n\nChild body.\n\n# Gamma\n\nG body.\n',
    );

    // Move Gamma (index 3) before Alpha (index 0).
    const movedUp = moveOutlineSection(doc, headings, 3, 0, 'before');
    expect(movedUp).toBe(
      '# Gamma\n\nG body.\n\n# Alpha\n\nA body.\n\n## Alpha Child\n\nChild body.\n\n# Beta\n\nB body.\n',
    );
  });

  it('refuses moving a heading into its own descendant or as a no-op', () => {
    const doc = '# Parent\n\n## Child\n\nBody.\n';
    const headings = buildOutline(doc);
    expect(moveOutlineSection(doc, headings, 0, 1, 'after')).toBeNull();
    expect(moveOutlineSection(doc, headings, 0, 0, 'before')).toBeNull();
  });

  it('handles files without a trailing newline cleanly when moving the last section up', () => {
    const doc = '# First\n\nOne.\n\n# Second\n\nTwo.';
    const headings = buildOutline(doc);
    const moved = moveOutlineSection(doc, headings, 1, 0, 'before');
    expect(moved).toBe('# Second\n\nTwo.\n\n# First\n\nOne.');
  });
});
