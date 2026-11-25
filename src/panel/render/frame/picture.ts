// Inside the diagram frame: Mermaid's SVG, as the markup `render` returns, made into a picture
// the panel shows with an `<img>`. Mermaid writes HTML (`<br>`, labels in `foreignObject`), but
// a picture is read as XML, so the markup is parsed and written out again with XMLSerializer.
// The CSS of the diagram's `style` elements (render/frame/realm.ts kept it aside) goes
// back in as one `style` element at the start, and the size is taken from the view box.

import type { DiagramPicture } from '../diagramProtocol';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The size a diagram with no usable view box is given. */
const FALLBACK = { width: 300, height: 150 };

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The view box's width and height, or null. */
function viewBoxSize(svg: Element): { width: number; height: number } | null {
  const parts = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , width, height] = parts;
  if (parts.length !== 4 || !(width! > 0) || !(height! > 0)) return null;
  return { width: Math.ceil(width!), height: Math.ceil(height!) };
}

/** The text of the root's own `title` and `desc` (Mermaid's `accTitle` and `accDescr`). */
function labelOf(svg: Element): string {
  const parts: string[] = [];
  for (const child of svg.children) {
    if (child.namespaceURI === SVG_NS && (child.localName === 'title' || child.localName === 'desc')) {
      const text = child.textContent?.trim();
      if (text) parts.push(text);
    }
  }
  return parts.join('. ');
}

/** `markup` (one `<svg>` element) as a picture with `css` in it. Throws when there is no SVG. */
export function pictureOf(markup: string, css: readonly string[]): DiagramPicture {
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  const svg = parsed.body.querySelector('svg');
  if (!svg) throw new Error('Mermaid drew nothing.');
  const size = viewBoxSize(svg) ?? FALLBACK;
  // Mermaid sizes the root to its container (`width="100%"` and a largest width); a picture
  // needs its own size.
  svg.removeAttribute('style');
  svg.setAttribute('width', String(size.width));
  svg.setAttribute('height', String(size.height));
  const xml = new XMLSerializer().serializeToString(svg);
  const style = css.length ? `<style>${escapeText(css.join('\n'))}</style>` : '';
  const end = startTagEnd(xml);
  const picture =
    xml[end - 1] === '/'
      ? `${xml.slice(0, end - 1)}>${style}</svg>`
      : `${xml.slice(0, end + 1)}${style}${xml.slice(end + 1)}`;
  return { svg: picture, ...size, label: labelOf(svg) };
}

/** Where the root's start tag ends: its `>`, outside the attributes' quotes. */
function startTagEnd(xml: string): number {
  let quote = '';
  for (let i = 0; i < xml.length; i++) {
    const c = xml[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  throw new Error('Mermaid drew nothing.');
}
