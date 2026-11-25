import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { escapeUnknownTags } from '../../../src/panel/html/blocks';
import { cleanAddress, htmlLinksIn, isLinkAddress } from '../../../src/panel/html/links';
import { isStoredPicture, MAX_STORED_PICTURE, storedPictureRefusal } from '../../../src/panel/html/storedPicture';
import { markdownParser } from '../../../src/panel/markdown';

describe('escapeUnknownTags', () => {
  it('writes tags that name no element as text, and leaves HTML and SVG names alone', () => {
    expect(escapeUnknownTags('<div>Use <your-key> and </your-key> <b>x</b></div>')).toBe(
      '<div>Use &lt;your-key> and &lt;/your-key> <b>x</b></div>',
    );
    expect(escapeUnknownTags('<svg><linearGradient/></svg>')).toBe('<svg><linearGradient/></svg>');
    expect(escapeUnknownTags('<p title="<name>">a</p>')).toBe('<p title="<name>">a</p>');
  });
});

describe('link addresses', () => {
  it('drops control characters before reading the scheme, as a browser does', () => {
    expect(cleanAddress(' jav\tascript:alert(1)')).toBe('javascript:alert(1)');
    expect(isLinkAddress(cleanAddress('jav\nascript:alert(1)'))).toBe(false);
  });

  it('allows a relative address and the schemes GitHub keeps', () => {
    for (const ok of ['docs/a.md', '#here', 'https://x.y', 'mailto:a@b.c', 'irc://x'])
      expect(isLinkAddress(ok)).toBe(true);
    for (const no of ['javascript:x', 'vbscript:x', 'data:text/html,x', 'file:///etc'])
      expect(isLinkAddress(no)).toBe(false);
  });
});

describe('htmlLinksIn', () => {
  const linksOf = (text: string) => {
    const tree = markdownParser.parse(text);
    const paragraph = tree.topNode.firstChild!;
    return htmlLinksIn(Text.of(text.split('\n')), paragraph).map((l) => [l.href, text.slice(l.textFrom, l.textTo)]);
  };

  it('pairs each <a href> with the next </a>, its address decoded and checked', () => {
    expect(linksOf('A <a href="docs/a.md?x=1&amp;y=2">one</a> and <A HREF=https://x.y>two</A>.')).toEqual([
      ['docs/a.md?x=1&y=2', 'one'],
      ['https://x.y', 'two'],
    ]);
  });

  it('finds no link for an anchor with no address or one GitHub refuses', () => {
    expect(linksOf('<a name="x"></a> <a href="jav&#x09;ascript:alert(1)">no</a> <a href="">empty</a>')).toEqual([]);
  });
});

describe('stored pictures', () => {
  it('draws PNG, JPEG, GIF and WebP stored in the file, and says why it draws anything else', () => {
    expect(isStoredPicture('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isStoredPicture('data:image/WEBP;base64,UklGR')).toBe(true);
    expect(isStoredPicture('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(storedPictureRefusal('data:text/html,<script>')).toMatch(/Only PNG/);
    const huge = `data:image/png;base64,${'A'.repeat(MAX_STORED_PICTURE)}`;
    expect(isStoredPicture(huge)).toBe(false);
    expect(storedPictureRefusal(huge)).toMatch(/^Larger than \d+ MB$/);
  });
});
