// Reading a file's bytes as text. The core reads UTF-8 and UTF-16 exactly, or not at all: a
// decoder that disagreed with VS Code's about one character would merge that difference into
// the document, so a file in any other encoding is watched by its bytes and never merged.

import { toLf } from './eol';

const TEXT_ENCODINGS = new Set(['utf8', 'utf8bom', 'utf16le', 'utf16be']);

function encodingId(encoding: string): string {
  return encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The name VS Code's status bar shows for each encoding it offers (its `labelShort`, as in VS Code 1.146). */
const ENCODING_NAMES: Record<string, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 with BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  windows1252: 'Windows 1252',
  iso88591: 'ISO 8859-1',
  iso88593: 'ISO 8859-3',
  iso885915: 'ISO 8859-15',
  macroman: 'Mac Roman',
  cp437: 'CP437',
  windows1256: 'Windows 1256',
  iso88596: 'ISO 8859-6',
  windows1257: 'Windows 1257',
  iso88594: 'ISO 8859-4',
  iso885914: 'ISO 8859-14',
  windows1250: 'Windows 1250',
  iso88592: 'ISO 8859-2',
  cp852: 'CP 852',
  windows1251: 'Windows 1251',
  cp866: 'CP 866',
  cp1125: 'CP 1125',
  iso88595: 'ISO 8859-5',
  koi8r: 'KOI8-R',
  koi8u: 'KOI8-U',
  iso885913: 'ISO 8859-13',
  windows1253: 'Windows 1253',
  iso88597: 'ISO 8859-7',
  windows1255: 'Windows 1255',
  iso88598: 'ISO 8859-8',
  iso885910: 'ISO 8859-10',
  iso885916: 'ISO 8859-16',
  windows1254: 'Windows 1254',
  iso88599: 'ISO 8859-9',
  windows1258: 'Windows 1258',
  gbk: 'GBK',
  gb18030: 'GB18030',
  cp950: 'Big5',
  big5hkscs: 'Big5-HKSCS',
  shiftjis: 'Shift JIS',
  eucjp: 'EUC-JP',
  euckr: 'EUC-KR',
  windows874: 'Windows 874',
  iso885911: 'ISO 8859-11',
  koi8ru: 'KOI8-RU',
  koi8t: 'KOI8-T',
  gb2312: 'GB 2312',
  cp865: 'CP 865',
  cp850: 'CP 850',
  cp857: 'CP 857',
};

/** The encoding's name as VS Code's status bar shows it; an encoding VS Code does not list, as it is given. */
export function encodingName(encoding: string): string {
  return ENCODING_NAMES[encodingId(encoding)] ?? encoding;
}

/** True for the encodings the core reads; a document in any other is watched by its bytes. */
export function readsText(encoding: string): boolean {
  return TEXT_ENCODINGS.has(encodingId(encoding));
}

/**
 * True for UTF-16, where VS Code reads and writes an unpaired surrogate as it is. In UTF-8 a save
 * writes one as U+FFFD, and a file cannot hold one.
 */
export function keepsUnpairedSurrogates(encoding: string): boolean {
  const id = encodingId(encoding);
  return id === 'utf16le' || id === 'utf16be';
}

/**
 * The file's text, or null when it cannot be read exactly: a byte-order mark decides
 * first; otherwise the document's encoding. UTF-8 is decoded strictly, UTF-16 code unit by code
 * unit as VS Code reads it. utf8, utf8bom, utf16le and utf16be are understood; any other
 * encoding is not, and gives null.
 */
export function decodeBytes(bytes: Uint8Array, encoding: string): string | null {
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return utf8(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
    switch (encodingId(encoding)) {
      case 'utf8':
      case 'utf8bom':
        return utf8(bytes);
      case 'utf16le':
        return utf16le(bytes);
      case 'utf16be':
        return utf16be(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * The bytes as text to show the user, never to merge: exactly when the core can read them,
 * else in the document's encoding as the runtime knows it (VS Code's ids, such as
 * `windows1252`, translated into the runtime's names), else UTF-8 with what does not decode shown as
 * the replacement character.
 */
export function textForShowing(bytes: Uint8Array, encoding: string): string {
  const exact = decodeBytes(bytes, encoding);
  if (exact !== null) return toLf(exact);
  const id = encodingId(encoding);
  const labels = [
    id.replace(/^windows(\d+)$/, 'windows-$1'),
    id.replace(/^iso8859(\d+)$/, 'iso-8859-$1'),
    id.replace(/^koi8([ru])$/, 'koi8-$1'),
    (
      {
        shiftjis: 'shift_jis',
        eucjp: 'euc-jp',
        euckr: 'euc-kr',
        macroman: 'macintosh',
        latin1: 'iso-8859-1',
      } as Record<string, string>
    )[id] ?? id,
  ];
  for (const label of labels) {
    try {
      return toLf(new TextDecoder(label).decode(bytes));
    } catch {
      // not a name the runtime knows
    }
  }
  return toLf(new TextDecoder('utf-8').decode(bytes));
}

/**
 * The bytes VS Code writes for `text` in `encoding` (UTF-8 with an unpaired surrogate as U+FFFD,
 * UTF-16 with its byte-order mark), or null for an encoding the core does not read.
 */
export function encodeText(text: string, encoding: string): Uint8Array | null {
  const id = encodingId(encoding);
  if (id === 'utf8' || id === 'utf8bom') {
    const body = new TextEncoder().encode(text);
    if (id === 'utf8') return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  if (id !== 'utf16le' && id !== 'utf16be') return null;
  const out = new Uint8Array(2 + text.length * 2);
  const be = id === 'utf16be';
  out[0] = be ? 0xfe : 0xff;
  out[1] = be ? 0xff : 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + 2 * i + (be ? 1 : 0)] = c & 0xff;
    out[2 + 2 * i + (be ? 0 : 1)] = c >> 8;
  }
  return out;
}

/**
 * The encoding of a backup the core writes from text it holds (a copy of the user's text, or what
 * an Undo deletes), whatever the note's; a backup of the file's own bytes is in the note's.
 */
export const TEXT_COPY_ENCODING = 'utf8';

/** The bytes of a backup the core writes from `text`, in TEXT_COPY_ENCODING. */
export function textCopyBytes(text: string): Uint8Array {
  return encodeText(text, TEXT_COPY_ENCODING)!;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Code unit by code unit, an unpaired surrogate included, as VS Code reads UTF-16 (and writes it back). */
function utf16le(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new Error('odd length');
  const units = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < units.length; i++) units[i] = bytes[2 * i]! | (bytes[2 * i + 1]! << 8);
  return fromCodeUnits(units);
}

/** Code units passed to one String.fromCharCode call, well under any engine's argument limit. */
const UNITS_PER_CALL = 0x2000;

/** The string whose UTF-16 code units are `units` (a byte each for a Uint8Array), UNITS_PER_CALL at a time. */
export function fromCodeUnits(units: Uint8Array | Uint16Array): string {
  let text = '';
  for (let i = 0; i < units.length; i += UNITS_PER_CALL)
    text += String.fromCharCode(...units.subarray(i, i + UNITS_PER_CALL));
  return text;
}

function utf16be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new Error('odd length');
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return utf16le(swapped);
}
