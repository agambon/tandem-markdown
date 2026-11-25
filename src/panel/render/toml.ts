// A reader of TOML for the front matter's table (render/frontmatter.ts), for display only: names
// and values in the order written, each scalar as written (a date, `1_000`, `3.0`) and each
// string as its text. It reads the forms of TOML 1.0: comments; bare, quoted and dotted keys;
// `[tables]` and `[[arrays of tables]]`; basic and literal strings on one line or several;
// arrays over several lines; inline tables. A text it cannot read gives null, and the block
// shows as source.

import { isSpaceOrTab } from '../../core/markdownText';
import type { FrontmatterEntry, FrontmatterValue } from './frontmatter';

type Table = Map<string, Value>;
type Value = { kind: 'text'; text: string } | { kind: 'list'; items: Value[] } | { kind: 'map'; table: Table };

class TomlError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const TOKEN = /[0-9A-Za-z_+\-.:]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCALAR =
  /^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9_]+(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
/** After a `\`: the spaces, line break and blank space that a backslash at a line's end removes. */
const LINE_JOIN = /[ \t]*\r?\n\s*/y;

class Reader {
  private i = 0;
  private readonly root: Table = new Map();
  /** Tables a header has opened, which another header may not open again. */
  private readonly opened = new Set<Table>();

  constructor(private readonly text: string) {}

  read(): Table {
    let table = this.root;
    for (;;) {
      this.skipBlank(true);
      if (this.i >= this.text.length) return this.root;
      if (this.text.startsWith('[[', this.i)) {
        this.i += 2;
        const path = this.key(']');
        this.expect(']]');
        table = this.appendTable(path);
      } else if (this.text[this.i] === '[') {
        this.i++;
        const path = this.key(']');
        this.expect(']');
        table = this.openTable(path);
      } else {
        this.pair(table);
      }
      this.endOfLine();
    }
  }

  private fail(): never {
    throw new TomlError();
  }

  private expect(word: string): void {
    if (!this.text.startsWith(word, this.i)) this.fail();
    this.i += word.length;
  }

  private skipSpaces(): void {
    while (isSpaceOrTab(this.text.charCodeAt(this.i))) this.i++;
  }

  /** Spaces, comments and, when `lines`, line breaks. */
  private skipBlank(lines: boolean): void {
    for (;;) {
      this.skipSpaces();
      const ch = this.text[this.i];
      if (ch === '#') {
        while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++;
      } else if (lines && (ch === '\n' || ch === '\r')) {
        this.i++;
      } else {
        return;
      }
    }
  }

  private endOfLine(): void {
    this.skipBlank(false);
    if (this.text[this.i] === '\r') this.i++;
    if (this.i < this.text.length && this.text[this.i] !== '\n') this.fail();
  }

  /** A dotted key, as its parts, ending before `stop` or `=`. */
  private key(stop: string): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipSpaces();
      const ch = this.text[this.i];
      if (ch === '"' || ch === "'") {
        parts.push(this.string(false));
      } else {
        const from = this.i;
        while (this.i < this.text.length && BARE_KEY.test(this.text[this.i]!)) this.i++;
        if (this.i === from) this.fail();
        parts.push(this.text.slice(from, this.i));
      }
      this.skipSpaces();
      if (this.text[this.i] !== '.') break;
      this.i++;
    }
    if (this.text[this.i] !== stop && this.text[this.i] !== '=') this.fail();
    return parts;
  }

  /** The table `name` in `table`, made when missing; through an array of tables, its last. */
  private child(table: Table, name: string): Table {
    let value = table.get(name);
    if (!value) table.set(name, (value = { kind: 'map', table: new Map() }));
    if (value.kind === 'list') value = value.items[value.items.length - 1];
    if (!value || value.kind !== 'map') this.fail();
    return value.table;
  }

  private parentOf(table: Table, path: readonly string[]): Table {
    let at = table;
    for (const part of path.slice(0, -1)) at = this.child(at, part);
    return at;
  }

  private openTable(path: readonly string[]): Table {
    const table = this.child(this.parentOf(this.root, path), path[path.length - 1]!);
    if (this.opened.has(table)) this.fail();
    this.opened.add(table);
    return table;
  }

  private appendTable(path: readonly string[]): Table {
    const parent = this.parentOf(this.root, path);
    const name = path[path.length - 1]!;
    let list = parent.get(name);
    if (!list) parent.set(name, (list = { kind: 'list', items: [] }));
    if (list.kind !== 'list') this.fail();
    const table: Table = new Map();
    list.items.push({ kind: 'map', table });
    return table;
  }

  private pair(table: Table): void {
    const path = this.key('=');
    this.expect('=');
    this.skipSpaces();
    const value = this.value();
    const parent = this.parentOf(table, path);
    const name = path[path.length - 1]!;
    if (parent.has(name)) this.fail();
    parent.set(name, value);
  }

  private value(): Value {
    const ch = this.text[this.i];
    if (ch === '"' || ch === "'") return { kind: 'text', text: this.string(true) };
    if (ch === '[') return this.array();
    if (ch === '{') return this.inlineTable();
    const from = this.i;
    this.token();
    // A date and a time may be joined by a space.
    if (DATE.test(this.text.slice(from, this.i)) && /^ \d{2}:/.test(this.text.slice(this.i, this.i + 4))) {
      this.i++;
      this.token();
    }
    const text = this.text.slice(from, this.i);
    if (!SCALAR.test(text)) this.fail();
    return { kind: 'text', text };
  }

  private token(): void {
    while (this.i < this.text.length && TOKEN.test(this.text[this.i]!)) this.i++;
  }

  private array(): Value {
    this.i++;
    const items: Value[] = [];
    for (;;) {
      this.skipBlank(true);
      if (this.text[this.i] === ']') break;
      items.push(this.value());
      this.skipBlank(true);
      if (this.text[this.i] === ',') this.i++;
      else if (this.text[this.i] !== ']') this.fail();
    }
    this.i++;
    return { kind: 'list', items };
  }

  private inlineTable(): Value {
    this.i++;
    const table: Table = new Map();
    this.skipSpaces();
    if (this.text[this.i] !== '}') {
      for (;;) {
        this.pair(table);
        this.skipSpaces();
        if (this.text[this.i] === '}') break;
        this.expect(',');
      }
    }
    this.i++;
    return { kind: 'map', table };
  }

  /** The quoted string at the cursor, decoded. `multiLine` allows the forms in three quotes. */
  private string(multiLine: boolean): string {
    const quote = this.text[this.i]!;
    const triple = quote.repeat(3);
    if (multiLine && this.text.startsWith(triple, this.i)) {
      this.i += 3;
      if (this.text.startsWith('\r\n', this.i)) this.i += 2;
      else if (this.text[this.i] === '\n') this.i++;
      let close = this.text.indexOf(triple, this.i);
      if (close < 0) this.fail();
      // Up to two quotes may stand just before the closing three.
      for (let extra = 0; extra < 2 && this.text[close + 3] === quote; extra++) close++;
      const body = this.text.slice(this.i, close);
      this.i = close + 3;
      return quote === '"' ? decode(body, true) : body;
    }
    this.i++;
    let end = this.i;
    while (end < this.text.length && this.text[end] !== quote && this.text[end] !== '\n') {
      end += quote === '"' && this.text[end] === '\\' ? 2 : 1;
    }
    if (this.text[end] !== quote) this.fail();
    const body = this.text.slice(this.i, end);
    this.i = end + 1;
    return quote === '"' ? decode(body, false) : body;
  }
}

/** A basic string's escapes resolved; in one over several lines, a `\` that ends a line joins it to the next text. */
function decode(body: string, multiLine: boolean): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (multiLine) {
      LINE_JOIN.lastIndex = i + 1;
      const join = LINE_JOIN.exec(body);
      if (join) {
        i += join[0].length;
        continue;
      }
    }
    const next = body[++i];
    if (next === 'u' || next === 'U') {
      const size = next === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + size);
      const code = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === size ? parseInt(hex, 16) : -1;
      if (code < 0 || code > 0x10ffff) throw new TomlError();
      out += String.fromCodePoint(code);
      i += size;
    } else if (next !== undefined && ESCAPES[next] !== undefined) {
      out += ESCAPES[next];
    } else {
      throw new TomlError();
    }
  }
  return out;
}

function toValue(value: Value): FrontmatterValue {
  if (value.kind === 'text') return value;
  if (value.kind === 'list') return { kind: 'list', items: value.items.map(toValue) };
  return { kind: 'map', entries: toEntries(value.table) };
}

function toEntries(table: Table): FrontmatterEntry[] {
  return [...table].map(([name, value]) => ({ name, value: toValue(value) }));
}

/** The names and values of a TOML text, or null when it does not read as TOML or holds none. */
export function tomlEntries(text: string): FrontmatterEntry[] | null {
  try {
    const entries = toEntries(new Reader(text).read());
    return entries.length ? entries : null;
  } catch (error) {
    if (error instanceof TomlError) return null;
    throw error;
  }
}
