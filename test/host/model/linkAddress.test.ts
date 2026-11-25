// A link's address, read as a web address, an anchor or a path, with every spelling worth trying.

import { describe, expect, it } from 'vitest';
import { readAddress } from '../../../src/host/model/linkAddress';

describe('reading an address', () => {
  it('web addresses go to the browser; other schemes are refused', () => {
    expect(readAddress('https://example.com/a?b=1')).toEqual({ kind: 'web', url: 'https://example.com/a?b=1' });
    expect(readAddress('mailto:a@b.co')).toEqual({ kind: 'web', url: 'mailto:a@b.co' });
    expect(readAddress('<http://x.y/my page>')).toEqual({ kind: 'web', url: 'http://x.y/my page' });
    expect(readAddress('javascript:alert(1)')).toEqual({ kind: 'refused', scheme: 'javascript' });
    expect(readAddress('command:workbench.action.quit')).toEqual({ kind: 'refused', scheme: 'command' });
    expect(readAddress('vscode://file/c:/x')).toEqual({ kind: 'refused', scheme: 'vscode' });
    expect(readAddress('data:image/png;base64,AAAA')).toEqual({ kind: 'refused', scheme: 'data' });
    expect(readAddress('//cdn.example.com/x.png')).toEqual({ kind: 'web', url: 'https://cdn.example.com/x.png' });
  });

  it('a heading alone is an anchor', () => {
    expect(readAddress('#1-tagging-taxonomy')).toEqual({ kind: 'anchor', fragment: '1-tagging-taxonomy' });
    expect(readAddress('#Some%20Heading')).toEqual({ kind: 'anchor', fragment: 'Some Heading' });
  });

  it('paths: relative, from the root, absolute, with every spelling worth trying', () => {
    expect(readAddress('../Modules/Grounding.md')).toEqual({
      kind: 'path',
      candidates: ['../Modules/Grounding.md'],
      from: 'note',
      fragment: '',
    });
    expect(readAddress('/docs/Guide.md#rules')).toEqual({
      kind: 'path',
      candidates: ['docs/Guide.md'],
      from: 'root',
      fragment: 'rules',
    });
    expect(readAddress('<My Note-20261114.png>')).toMatchObject({ candidates: ['My Note-20261114.png'], from: 'note' });
    expect(readAddress('My%20Note.png')).toMatchObject({ candidates: ['My Note.png', 'My%20Note.png'] });
    // Windows-written: backslashes are folder separators, and a backslash before punctuation
    // may be either an escape (CommonMark) or a separator.
    expect(readAddress('files\\image_m.png')).toMatchObject({ candidates: ['files/image_m.png'], from: 'note' });
    expect(readAddress('files\\_old.png')).toMatchObject({ candidates: ['files_old.png', 'files/_old.png'] });
    expect(readAddress('C:\\Users\\me\\Note.md')).toMatchObject({
      candidates: ['C:/Users/me/Note.md'],
      from: 'absolute',
    });
    expect(readAddress('file:///C:/Users/me/My%20Note.md#top')).toEqual({
      kind: 'path',
      candidates: ['C:/Users/me/My Note.md'],
      from: 'absolute',
      fragment: 'top',
    });
    expect(readAddress('100%.png')).toMatchObject({ candidates: ['100%.png'] });
    expect(readAddress('www.example.com')).toMatchObject({ kind: 'path' });
  });
});

const SHARE = { kind: 'refused', scheme: 'file', share: true };

describe('readAddress and network shares', () => {
  it('refuses a share written as a Windows path, in every spelling', () => {
    for (const a of [
      '\\\\server\\share\\x.md',
      '\\\\server/share/x.md',
      '<\\\\server\\share\\My Note.md>',
      '\\\\?\\UNC\\server\\share\\x.md',
      '\\\\.\\UNC\\server\\x.md',
    ]) {
      expect(readAddress(a)).toEqual(SHARE);
    }
  });

  it('refuses a file: address that names another computer, or puts a share in its path', () => {
    for (const a of [
      'file://server/share/x.md',
      'FILE://server/share/x.png',
      'file:////server/share/x.md',
      'file:\\\\server\\share\\x.md',
      'file:%5C%5Cserver%5Cshare%5Cx.md',
    ]) {
      expect(readAddress(a)).toEqual(SHARE);
    }
  });

  it('still opens a file: address on this computer', () => {
    expect(readAddress('file:///C:/Users/me/x.md')).toEqual({
      kind: 'path',
      candidates: ['C:/Users/me/x.md'],
      from: 'absolute',
      fragment: '',
    });
    expect(readAddress('file://localhost/C:/Users/me/x.md')).toEqual({
      kind: 'path',
      candidates: ['C:/Users/me/x.md'],
      from: 'absolute',
      fragment: '',
    });
    expect(readAddress('file://C:/Users/me/x.md#top')).toEqual({
      kind: 'path',
      candidates: ['C:/Users/me/x.md'],
      from: 'absolute',
      fragment: 'top',
    });
    expect(readAddress('file:///home/me/x.md')).toEqual({
      kind: 'path',
      candidates: ['/home/me/x.md'],
      from: 'absolute',
      fragment: '',
    });
  });

  it('reads root and drive paths as paths, and // as a web address', () => {
    expect(readAddress('\\root\\x.md')).toMatchObject({ kind: 'path', from: 'root' });
    expect(readAddress('/root/x.md')).toMatchObject({ kind: 'path', from: 'root' });
    expect(readAddress('C:\\x.md')).toMatchObject({ kind: 'path', from: 'absolute' });
    expect(readAddress('//cdn.example.com/x.png')).toEqual({ kind: 'web', url: 'https://cdn.example.com/x.png' });
  });
});
