// Finding the heading a link's fragment names: by its id, by its GitHub anchor, duplicates
// numbered.

import { describe, expect, it } from 'vitest';
import { buildOutline } from '../../../src/core/outline';
import { findHeading, outlineHas, slugOf } from '../../../src/host/model/headingAnchors';

describe('finding a heading', () => {
  const headings = ['1. Tagging Taxonomy', 'Notes', 'Notes', 'Café & Things', 'Why? Because!'];

  it('by GitHub anchor, duplicates numbered', () => {
    expect(slugOf('1. Tagging Taxonomy')).toBe('1-tagging-taxonomy');
    expect(slugOf('Café & Things')).toBe('café--things');
    expect(findHeading(headings, '1-tagging-taxonomy')).toBe(0);
    expect(findHeading(headings, 'notes')).toBe(1);
    expect(findHeading(headings, 'notes-1')).toBe(2);
    expect(findHeading(headings, 'why-because')).toBe(4);
  });

  it('by the id its attributes give it, before any anchor', () => {
    const ids = [undefined, 'intro', undefined, undefined, undefined];
    expect(findHeading(headings, 'intro', ids)).toBe(1);
    expect(findHeading(headings, 'notes', ids)).toBe(1);
    expect(findHeading(['Intro', 'Other'], 'intro', [undefined, 'intro'])).toBe(1);
  });

  it('by the anchor made from the heading as written, whatever its entities, HTML and comments read as', () => {
    const outline = buildOutline('# Tom &amp; Jerry\n# Press <kbd>S</kbd>\n# Plan %%draft%%\n# Old <!-- x --> one\n');
    expect(outline.map((h) => h.text)).toEqual(['Tom & Jerry', 'Press S', 'Plan', 'Old one']);
    for (const anchor of ['tom-amp-jerry', 'press-kbdskbd', 'plan-draft', 'old----x----one'])
      expect(outlineHas(outline, anchor), anchor).toBe(true);
  });

  it('by its text, as a wikilink writes it', () => {
    expect(findHeading(headings, 'Why? Because!')).toBe(4);
    expect(findHeading(headings, 'café & things')).toBe(3);
    expect(findHeading(headings, 'Missing')).toBe(-1);
    expect(findHeading(headings, '')).toBe(-1);
  });
});
