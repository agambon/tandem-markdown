// Anchors written as HTML, `<a name="here"></a>` or `<a id="here">`: what a `#here` link
// reaches when no heading of the file has that name, as a browser finds an element by its id
// or an anchor by its name.

import { isHtmlSpace } from '../../core/markdownText';

/** The longest tag looked at for its name. */
const MAX_TAG = 2000;

const NAME = /\s(?:name|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/**
 * Where the first `<a>` tag whose name or id is `fragment` starts in `text`, or, with none,
 * the first whose name or id is `fragment` in another letter case; -1 when there is neither.
 */
export function findNamedAnchor(text: string, fragment: string): number {
  const wanted = fragment.trim();
  if (wanted === '') return -1;
  const lower = text.toLowerCase();
  const wantedLower = wanted.toLowerCase();
  let folded = -1;
  // The first `>` after the last tag looked at, which is also the first after any later `<a` before it.
  let end = -1;
  for (let at = lower.indexOf('<a', 0); at >= 0; at = lower.indexOf('<a', at + 2)) {
    if (!isHtmlSpace(text.charCodeAt(at + 2))) continue;
    if (end < at) end = text.indexOf('>', at);
    if (end < 0) break;
    if (end - at > MAX_TAG) continue;
    for (const match of text.slice(at, end).matchAll(NAME)) {
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      if (value === wanted) return at;
      if (folded < 0 && value.toLowerCase() === wantedLower) folded = at;
    }
  }
  return folded;
}
