// Inside the diagram frame (render/diagramFrame.ts), before Mermaid's code runs: the changes to
// this frame's own realm that let Mermaid draw under the page's content policy, which the frame
// keeps, with nothing refused or reported (docs/ARCHITECTURE.md, "Diagrams").
//
// Styles. The policy blocks a `style` attribute or element from markup or `setAttribute`, not
// the style object or a constructed stylesheet. So `setAttribute('style', css)` sets the style
// object; a created `style` element is a stand-in whose CSS goes into a constructed sheet, kept
// for the picture (`takeStyleSheets`); markup parsed into the document has its `style`
// attributes moved to the style object and its `on...` attributes and `style` elements dropped.
//
// Addresses. Nothing in the frame may load: picture addresses (`src`, `srcset`, an `href` that
// is not `#...` on anything but a link) and a stylesheet's `url(...)` that is not `#...` go.

import { RENAMED_PREFIX, RENAMED_STYLE_ELEMENT, renameInline } from '../../html/renameInline';

/** The element a created `style` element is in its place; nothing reads or styles it. */
const STAND_IN = 'tm-css';

/**
 * Addresses CSS would load: `url(...)` whose target is not a fragment of this document. At
 * most 4,096 characters of an address are read, so no `url(` is read to the end again.
 */
const CSS_ADDRESS = /url\(\s*(?!['"]?\s*#)[^)]{0,4096}\)/gi;

/** The stand-ins for `style` elements created since the last `takeStyleSheets`, with their CSS. */
let sheets = new Map<Element, string>();

/** The CSS of every `style` element created since the last call, in the order they were made; adopted sheets are dropped. */
export function takeStyleSheets(): string[] {
  const css = [...sheets.values()];
  sheets = new Map();
  document.adoptedStyleSheets = [];
  return css;
}

function withoutAddresses(css: string): string {
  return css.replace(CSS_ADDRESS, 'none');
}

function setSheet(standIn: Element, css: string): void {
  const text = withoutAddresses(css);
  sheets.set(standIn, text);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function setStyle(element: Element, css: string): void {
  (element as Element & ElementCSSInlineStyle).style.cssText = withoutAddresses(css);
}

/** Whether setting `name` to `value` on `element` would make it load something. */
function loads(element: Element, name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'src' || lower === 'srcset' || lower === 'poster') return true;
  if (lower !== 'href' && lower !== 'xlink:href') return false;
  return element.localName !== 'a' && !value.trim().startsWith('#');
}

/** Moves renamed `style` attributes to the style object and drops what was set aside or would load. */
function settle(root: ParentNode): void {
  for (const element of root.querySelectorAll(RENAMED_STYLE_ELEMENT)) element.remove();
  for (const element of root.querySelectorAll('*')) {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? '';
      if (name.startsWith(RENAMED_PREFIX)) {
        element.removeAttribute(name);
        if (name === `${RENAMED_PREFIX}style`) setStyle(element, value);
      } else if (loads(element, name, value)) {
        element.removeAttribute(name);
      }
    }
  }
}

function isStyle(name: string): boolean {
  return name.toLowerCase() === 'style';
}

let prepared = false;

/** Makes the changes, once, before any other code runs in the frame. */
export function prepareRealm(): void {
  if (prepared) return;
  prepared = true;
  const element = Element.prototype;
  const setAttribute = element.setAttribute;
  element.setAttribute = function (this: Element, name: string, value: string): void {
    if (isStyle(name)) setStyle(this, String(value));
    else if (!loads(this, name, String(value))) setAttribute.call(this, name, value);
  };
  const setAttributeNS = element.setAttributeNS;
  element.setAttributeNS = function (this: Element, ns: string | null, name: string, value: string): void {
    if (!ns && isStyle(name)) setStyle(this, String(value));
    else if (!loads(this, name, String(value))) setAttributeNS.call(this, ns, name, value);
  };
  for (const name of ['src', 'srcset'] as const) {
    const property = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name)!;
    Object.defineProperty(HTMLImageElement.prototype, name, { ...property, set() {} });
  }

  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (this: Document, name: string, options?: ElementCreationOptions) {
    return isStyle(name) ? standIn(this) : createElement.call(this, name, options);
  } as Document['createElement'];
  const createElementNS = Document.prototype.createElementNS;
  Document.prototype.createElementNS = function (this: Document, ns: string | null, name: string, options?: unknown) {
    return isStyle(name) ? standIn(this) : createElementNS.call(this, ns, name, options as ElementCreationOptions);
  } as Document['createElementNS'];

  const innerHTML = Object.getOwnPropertyDescriptor(element, 'innerHTML')!;
  Object.defineProperty(element, 'innerHTML', {
    ...innerHTML,
    set(this: Element, value: unknown) {
      if (this.localName === STAND_IN) return setSheet(this, String(value));
      innerHTML.set!.call(this, renameInline(String(value)));
      settle(this);
    },
  });
  const textContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;
  Object.defineProperty(Node.prototype, 'textContent', {
    ...textContent,
    set(this: Node, value: unknown) {
      if (this instanceof Element && this.localName === STAND_IN) setSheet(this, String(value ?? ''));
      else textContent.set!.call(this, value);
    },
  });
  const parseFromString = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = function (this: DOMParser, markup: string, type: DOMParserSupportedType) {
    const parsed = parseFromString.call(this, renameInline(String(markup)), type);
    settle(parsed);
    return parsed;
  };
}

function standIn(doc: Document): HTMLElement {
  const element = doc.createElementNS('http://www.w3.org/1999/xhtml', STAND_IN) as HTMLElement;
  sheets.set(element, '');
  return element;
}
