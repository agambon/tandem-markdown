// Reading a file's bytes as text, exactly or not at all, and writing text as VS Code writes it.
import { describe, expect, it } from 'vitest';
import { decodeBytes, encodeText, readsText, textForShowing } from '../../src/core/encoding';

const enc = (s: string) => new TextEncoder().encode(s);

describe('decodeBytes', () => {
  it("lets a byte-order mark decide, then the document's encoding, strictly", () => {
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), 'utf16le')).toBe('a');
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00]), 'utf8')).toBe('a');
    expect(decodeBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x61]), 'utf8')).toBe('a');
    expect(decodeBytes(enc('héllo'), 'utf8')).toBe('héllo');
    expect(decodeBytes(new Uint8Array([0x61, 0x00]), 'utf16le')).toBe('a');
    expect(decodeBytes(new Uint8Array([0x00, 0x61]), 'utf16be')).toBe('a');
  });

  it('reads UTF-16 code unit by code unit, an unpaired surrogate included, as VS Code does', () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8, 0x62, 0x00]), 'utf8')).toBe(`a${high}b`);
    expect(decodeBytes(new Uint8Array([0xfe, 0xff, 0xde, 0x00, 0x00, 0x61]), 'utf8')).toBe(`${low}a`);
    expect(decodeBytes(new Uint8Array([0xd8, 0x3d, 0xde, 0x00]), 'utf16be')).toBe(high + low);
  });

  it('gives null for bytes that do not decode, and for encodings it does not handle', () => {
    expect(decodeBytes(new Uint8Array([0x61, 0xe9, 0x62]), 'utf8')).toBeNull(); // a cp1252 é
    expect(decodeBytes(new Uint8Array([0xe2, 0x9f]), 'utf8')).toBeNull(); // a character cut in two
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x61]), 'utf8')).toBeNull(); // odd UTF-16
    expect(decodeBytes(enc('abc'), 'windows1252')).toBeNull();
  });

  it('readsText says which encodings are read as text; any other is watched by its bytes', () => {
    for (const e of ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'UTF-8']) expect(readsText(e)).toBe(true);
    for (const e of ['windows1252', 'iso88591', 'shiftjis', 'cp437']) expect(readsText(e)).toBe(false);
  });
});

describe('textForShowing (a version held only in memory, for "Show the file\'s version")', () => {
  // Else as UTF-8, with the replacement character for what does not decode.
  it("shows the bytes in the document's encoding when the runtime knows it", () => {
    expect(textForShowing(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x0d, 0x0a]), 'windows1252')).toBe('Café\n');
    expect(textForShowing(new Uint8Array([0x61, 0xe9, 0x62]), 'utf8')).toBe('a\ufffdb');
    expect(textForShowing(new Uint8Array([0x61, 0x62]), 'cp437')).toBe('ab');
  });
});

describe('encodeText', () => {
  it('writes the bytes VS Code writes, which read back as the text', () => {
    const text = 'héllo \u{1f600}\r\n';
    for (const e of ['utf8', 'utf8bom', 'utf16le', 'utf16be']) expect(decodeBytes(encodeText(text, e)!, e)).toBe(text);
    expect(Array.from(encodeText('a', 'utf8bom')!)).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    expect(Array.from(encodeText('a', 'utf16le')!)).toEqual([0xff, 0xfe, 0x61, 0x00]);
    expect(Array.from(encodeText('a', 'utf16be')!)).toEqual([0xfe, 0xff, 0x00, 0x61]);
    expect(encodeText('a', 'windows1252')).toBeNull();
  });
});
