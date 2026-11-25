import { describe, expect, it } from 'vitest';
import { find, topLevel } from './treeHelpers';

const names = (text: string) =>
  find(text, 'FootnoteRef', 'FootnoteDef', 'FootnoteLabel').map((n) => `${n.name}:${n.text}`);

describe('footnotes', () => {
  it('reads a reference', () => {
    expect(names('Text[^1] and [^note].')).toEqual(['FootnoteRef:[^1]', 'FootnoteRef:[^note]']);
  });

  it('reads a definition with its label, not as a link reference', () => {
    const text = '[^1]: The note.\n';
    expect(names(text)).toEqual(['FootnoteDef:[^1]: The note.', 'FootnoteLabel:[^1]:']);
    expect(find(text, 'LinkReference')).toEqual([]);
    expect(find(text, 'Paragraph').map((p) => p.text)).toEqual(['The note.']);
  });

  it('a definition holds indented lines and continues lazily', () => {
    const text = '[^1]: First line\ncontinued.\n\n    Second paragraph.\n\nAfter.';
    const [def] = find(text, 'FootnoteDef');
    expect(def!.text).toBe('[^1]: First line\ncontinued.\n\n    Second paragraph.');
    expect(topLevel(text)).toEqual(['FootnoteDef', 'Paragraph']);
  });

  it('a definition interrupts a paragraph', () => {
    expect(topLevel('Para\n[^1]: note')).toEqual(['Paragraph', 'FootnoteDef']);
  });

  it('labels have no spaces and are not empty', () => {
    expect(names('[^a b] [^] [^a[b]')).toEqual([]);
    expect(names('[^]: x')).toEqual([]);
  });

  // markdown-it-footnote: the link rule runs first, so `[^1](url)` is a link.
  it('[^1](url) is a link, not a reference', () => {
    expect(names('[^1](https://example.com)')).toEqual([]);
    expect(find('[^1](https://example.com)', 'Link').length).toBe(1);
  });

  // The outer brackets open a link first; the reference is read inside its text, as markdown-it does.
  it('[^1] inside a link is a reference inside the link', () => {
    const text = '[see [^1]](https://example.com)';
    expect(find(text, 'Link', 'FootnoteRef').map((n) => `${n.name}:${n.text}`)).toEqual([
      'Link:[see [^1]](https://example.com)',
      'FootnoteRef:[^1]',
    ]);
  });

  it('is not read inside code', () => {
    expect(names('`[^1]`')).toEqual([]);
    expect(names('```\n[^1]: x\n```')).toEqual([]);
  });
});
