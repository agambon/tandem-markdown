// Character entity references (`&amp;`, `&nbsp;`, `&#8212;`, `&#x2014;`), decoded as
// markdown-it decodes them, so the panel shows what the preview shows. The parser marks any
// `&name;` as an `Entity`; only the ones CommonMark recognizes (HTML5's named entities,
// decimal of up to 7 digits, hexadecimal of up to 6) stand for a character.
//
// `decodable` follows markdown-it 15.0's `isValidEntityCode` (MIT), test for test.
// markdown-it's notice:
//
//   Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { decodeHTMLStrict } from 'entities';
import { CODE_HASH } from '../../core/markdownText';

const SHAPE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});$/;

/** Whether markdown-it decodes a numeric reference to `code`; it leaves the others as typed. */
function decodable(code: number): boolean {
  if (code > 0x10ffff) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false; // surrogates
  if (code >= 0xfdd0 && code <= 0xfdef) return false; // noncharacters
  if ((code & 0xffff) === 0xffff || (code & 0xffff) === 0xfffe) return false;
  // C0 controls other than tab, line feed, form feed and carriage return
  if (code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f)) return false;
  if (code >= 0x7f && code <= 0x9f) return false; // DEL and C1 controls
  return true;
}

/** The character `source` stands for, or null when it is not an entity CommonMark recognizes. */
export function entityChar(source: string): string | null {
  if (!SHAPE.test(source)) return null;
  if (source.charCodeAt(1) === CODE_HASH) {
    const hex = source[2] === 'x' || source[2] === 'X';
    const code = parseInt(source.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return decodable(code) ? String.fromCodePoint(code) : null;
  }
  const decoded = decodeHTMLStrict(source);
  return decoded === source ? null : decoded;
}
