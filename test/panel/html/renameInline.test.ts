import { describe, expect, it } from 'vitest';
import { renameInline } from '../../../src/panel/html/renameInline';
import { countingText } from '../../countingText';

describe('renaming what the content policy reports while HTML is parsed', () => {
  it('renames style and event-handler attributes, and style elements, in any letter case', () => {
    expect(renameInline('<p STYLE="color:red" onClick=x>a</p>')).toBe(
      '<p data-tm-STYLE="color:red" data-tm-onClick=x>a</p>',
    );
    expect(renameInline('<style>p{}</style><b>x</b>')).toBe('<tm-style>p{}</tm-style><b>x</b>');
    expect(renameInline('<img src=x/onerror=y>')).toBe('<img src=x/onerror=y>');
    expect(renameInline('<img src=x /onerror=y>')).toBe('<img src=x /data-tm-onerror=y>');
  });

  it('leaves text, attribute values and other attributes as they are', () => {
    const text = '<p title="one onward" data-x="style">only one style, on and on</p>';
    expect(renameInline(text)).toBe(text);
    expect(renameInline('plain text with no tags')).toBe('plain text with no tags');
  });

  it('finds a handler hidden after a comment that looks like a quoted value', () => {
    expect(renameInline('<!--<img src="--><img src=x onerror=a//">')).toContain('<img src=x data-tm-onerror=a');
  });

  it('follows both readings of a CDATA section and of a title', () => {
    expect(renameInline('<svg><![CDATA[><image xlink:href="]]><img src=x onerror=a//"></svg>')).toContain(
      'data-tm-onerror=a',
    );
    expect(renameInline('<svg><title><a id="</title><img src=x onerror=a>"></svg>')).toContain('data-tm-onerror=a');
  });

  it('reads a long run of unclosed tags a bounded number of times per character', () => {
    const text = countingText('<a title="'.repeat(20_000));
    renameInline(text.text);
    expect(text.read()).toBeLessThan(10 * text.text.length);
  });
});
