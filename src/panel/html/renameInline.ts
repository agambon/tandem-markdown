// Renames, in a file's HTML, what the page's content policy would report while the HTML is
// parsed into a detached document: `style` attributes, `on...` attributes (inline event
// handlers) and `style` elements. Nothing runs or loads in that document, and the allow-list
// drops the renamed ones after it, so this keeps the policy's report quiet; it is not what
// makes the HTML safe (html/door.ts is).
//
// The text is read as the HTML tokenizer reads it, with one difference: where the tokenizer's
// reading depends on where it stands in the tree (inside `<svg>` or `<math>`, a CDATA section
// is one and a `<style>` or `<title>` holds tags), both readings are followed, and an attribute
// either reading sees is renamed. One reading's text can hold the other's tags, which is how
// attacks hide them from sanitizers. That is why it does not use `readTags` (html/blocks.ts),
// which follows one reading; it reads each tag as `readTags` does, through html/tagScan.ts.

import { isAsciiLetter } from '../../core/markdownText';
import { firstFrom } from '../../core/textLines';
import { CODE_BANG, CODE_QUESTION_MARK, CODE_SLASH } from '../markdown/chars';
import { scanTag } from './tagScan';

/** What a renamed attribute's name starts with, and what a `style` element is renamed to. */
export const RENAMED_PREFIX = 'data-tm-';
export const RENAMED_STYLE_ELEMENT = 'tm-style';

/** Elements whose content the tokenizer reads as text in HTML (as tags inside SVG and MathML). */
const RAW_TEXT = new Set(['script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

/** The most characters read in all, as a multiple of the text's length; past it, renaming stops. */
const MAX_WORK = 64;

/** The sorted offsets where `needle` (lower case) occurs in `lower`. */
function offsetsOf(lower: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** `html` with every `style` and `on...` attribute, and every `style` element, renamed. */
export function renameInline(html: string): string {
  const n = html.length;
  const lower = html.toLowerCase();
  const found = new Map<string, number[]>();
  const offsets = (needle: string) => {
    let list = found.get(needle);
    if (!list) found.set(needle, (list = offsetsOf(lower, needle)));
    return list;
  };
  /** Where the construct ending in `needle` that starts at or after `from` ends, or the text's end. */
  const after = (needle: string, from: number) => {
    const at = firstFrom(offsets(needle), from);
    return at < 0 ? n : at + needle.length;
  };

  const attributes = new Set<number>();
  const elements = new Set<number>();
  const seen = new Set<number>();
  const starts = [0];
  let work = 0;

  /** Reads a start or end tag whose name starts at `at`; returns where the tag ends. */
  const tag = (at: number, closing: boolean): number => {
    const scan = scanTag(
      html,
      lower,
      at,
      (quote, from) => firstFrom(offsets(quote), from),
      (attribute, from) => {
        if (!closing && (attribute === 'style' || attribute.startsWith('on'))) attributes.add(from);
      },
    );
    const name = scan.name;
    if (name === 'style') elements.add(at);
    // Where the tag's `>` is, or the text's end when the text ends inside it.
    const j = scan.end < 0 ? n : scan.end - 1;
    work += j - at;
    // In HTML a raw-text element's content is text up to its closing tag; inside SVG or MathML it holds tags.
    if (!closing && RAW_TEXT.has(name)) {
      const end = firstFrom(offsets(`</${name}`), j);
      if (end >= 0) starts.push(end);
    }
    return j + 1;
  };

  while (starts.length && work <= MAX_WORK * n) {
    let i = starts.pop()!;
    while (i < n) {
      const lt = html.indexOf('<', i);
      if (lt < 0 || seen.has(lt)) break;
      seen.add(lt);
      work += lt - i + 1;
      const next = html.charCodeAt(lt + 1);
      if (lower.startsWith('<!--', lt)) {
        // `<!-->` and `<!--->` end at once; otherwise the comment ends at `-->` or `--!>`.
        if (html[lt + 4] === '>') i = lt + 5;
        else if (lower.startsWith('->', lt + 4)) i = lt + 6;
        else i = Math.min(after('-->', lt + 4), after('--!>', lt + 4));
      } else if (lower.startsWith('<![cdata[', lt)) {
        // A CDATA section inside SVG or MathML; a comment up to the next `>` anywhere else.
        starts.push(after(']]>', lt + 9));
        i = after('>', lt + 2);
      } else if (next === CODE_BANG || next === CODE_QUESTION_MARK) {
        i = after('>', lt + 2); // `<!...>` and `<?...>`
      } else if (next === CODE_SLASH) {
        if (isAsciiLetter(html.charCodeAt(lt + 2))) i = tag(lt + 2, true);
        else i = html[lt + 2] === '>' ? lt + 3 : after('>', lt + 2);
      } else if (isAsciiLetter(next)) {
        i = tag(lt + 1, false);
      } else {
        i = lt + 1;
      }
    }
  }

  if (attributes.size === 0 && elements.size === 0) return html;
  const cuts = [
    ...[...attributes].map((at) => ({ at, element: false })),
    ...[...elements].map((at) => ({ at, element: true })),
  ];
  cuts.sort((a, b) => a.at - b.at);
  let out = '';
  let last = 0;
  for (const cut of cuts) {
    if (cut.element) {
      out += html.slice(last, cut.at) + RENAMED_STYLE_ELEMENT;
      last = cut.at + 'style'.length;
    } else {
      out += html.slice(last, cut.at) + RENAMED_PREFIX;
      last = cut.at;
    }
  }
  return out + html.slice(last);
}
