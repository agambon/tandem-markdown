// The names of the elements of the HTML standard: what the panel draws as HTML, and what the
// plain reading (plainText.ts) takes for a tag.

/**
 * The elements of the HTML standard, current and obsolete. A tag whose name is not here is not
 * HTML: `use <name> here` is text, shown as typed, though CommonMark reads `<name>` as a tag
 * and a browser would show nothing for it.
 */
const HTML_ELEMENTS = new Set(
  (
    'a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big blink ' +
    'blockquote body br button canvas caption center cite code col colgroup data datalist dd del details ' +
    'dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 ' +
    'h3 h4 h5 h6 head header hgroup hr html i iframe image img input ins isindex kbd keygen label legend ' +
    'li link listing main map mark marquee math menu menuitem meta meter multicol nav nextid nobr ' +
    'noembed noframes noscript object ol optgroup option output p param picture plaintext pre progress ' +
    'q rb rp rt rtc ruby s samp script search section select slot small source spacer span strike strong ' +
    'style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track tt u ' +
    'ul var video wbr xmp'
  ).split(' '),
);

/** Whether `name` (any letter case) is an element of the HTML standard. */
export function isHtmlElement(name: string): boolean {
  return HTML_ELEMENTS.has(name.toLowerCase());
}
