// Finding the HTML anchor a link's fragment names, by its name or its id.

import { describe, expect, it } from 'vitest';
import { findNamedAnchor } from '../../../src/host/model/namedAnchors';
import { countingText } from '../../countingText';

describe('findNamedAnchor', () => {
  const text = 'Intro\n\n<a name="readme-top"></a>\n\nBody <a id=\'Usage\'></a> and <A NAME=other>.\n';

  it('finds an anchor by its name or its id, quoted or not, in any tag letter case', () => {
    expect(findNamedAnchor(text, 'readme-top')).toBe(text.indexOf('<a name'));
    expect(findNamedAnchor(text, 'Usage')).toBe(text.indexOf("<a id='Usage'"));
    expect(findNamedAnchor(text, 'other')).toBe(text.indexOf('<A NAME'));
  });

  it('prefers the name as written, and falls back to another letter case', () => {
    const both = '<a name="Top"></a>\n<a name="top"></a>';
    expect(findNamedAnchor(both, 'top')).toBe(both.indexOf('<a name="top"'));
    expect(findNamedAnchor(text, 'usage')).toBe(text.indexOf("<a id='Usage'"));
  });

  it('finds nothing for a missing name, an empty fragment, or another element', () => {
    expect(findNamedAnchor(text, 'missing')).toBe(-1);
    expect(findNamedAnchor(text, '  ')).toBe(-1);
    expect(findNamedAnchor('<abbr name="x">', 'x')).toBe(-1);
  });

  it('reads a long run of unclosed anchor tags a bounded number of times per character', () => {
    const many = countingText(`${'<a b '.repeat(50_000)}>`);
    expect(findNamedAnchor(many.text, 'x')).toBe(-1);
    expect(many.read()).toBeLessThan(10 * many.text.length);
  });
});
