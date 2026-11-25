// Which documents' tabs scroll together, and where an untoggled document starts.
import { describe, expect, it } from 'vitest';
import { canLink, ScrollLinks } from '../../../src/host/model/scrollLinks';

const A = 'file:///w/a.md';
const B = 'file:///w/b.md';

describe('which documents can be linked', () => {
  it('is a markdown document in two tabs of any kind', () => {
    expect(canLink({ markdown: true, source: 2, rich: 0 })).toBe(true);
    expect(canLink({ markdown: true, source: 1, rich: 1 })).toBe(true);
    expect(canLink({ markdown: true, source: 0, rich: 3 })).toBe(true);
    expect(canLink({ markdown: true, source: 1, rich: 0 })).toBe(false);
  });

  it('is a text or untitled document only while a rich tab of it is visible', () => {
    expect(canLink({ markdown: false, source: 2, rich: 0 })).toBe(false);
    expect(canLink({ markdown: false, source: 1, rich: 1 })).toBe(true);
  });
});

describe('whether a document is linked', () => {
  it('starts as the setting says once a rich tab is visible', () => {
    const links = new ScrollLinks();
    expect(links.linked(A, { markdown: true, source: 1, rich: 1 }, true)).toBe(true);
    expect(links.linked(A, { markdown: true, source: 1, rich: 1 }, false)).toBe(false);
  });

  it('starts not linked in Source tabs alone, whatever the setting says', () => {
    expect(new ScrollLinks().linked(A, { markdown: true, source: 2, rich: 0 }, true)).toBe(false);
  });

  it('keeps the user’s choice whatever tabs the document has, and for that document only', () => {
    const links = new ScrollLinks();
    links.choose(A, true);
    expect(links.linked(A, { markdown: true, source: 2, rich: 0 }, false)).toBe(true);
    links.choose(A, false);
    expect(links.linked(A, { markdown: true, source: 1, rich: 1 }, true)).toBe(false);
    expect(links.linked(B, { markdown: true, source: 1, rich: 1 }, true)).toBe(true);
  });

  it('carries the choice to a renamed document', () => {
    const links = new ScrollLinks();
    links.choose(A, false);
    links.renamed(A, B);
    expect(links.linked(B, { markdown: true, source: 1, rich: 1 }, true)).toBe(false);
    expect(links.linked(A, { markdown: true, source: 1, rich: 1 }, true)).toBe(true);
  });
});
