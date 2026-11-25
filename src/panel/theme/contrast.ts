// Colors as the page draws them, and their contrast by WCAG 2's formula: reading the CSS forms
// VS Code and the browser write, painting one color over another, and mixing two.

/** An sRGB color: channels 0 to 255, alpha 0 to 1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * The color `css` names, in the forms VS Code gives a webview's theme colors and the browser
 * gives computed styles: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` and `rgba(r, g, b, a)`.
 * Null for any other text, an empty one included.
 */
export function parseColor(css: string): Rgba | null {
  const text = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hex) {
    const pairs = hex.length === 3 ? [...hex].map((d) => d + d) : hex.match(/../g)!;
    const [r, g, b, a = 255] = pairs.map((p) => parseInt(p, 16)) as [number, number, number, number?];
    return { r, g, b, a: a / 255 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
  if (!fn) return null;
  return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
}

/**
 * `rgb()` for an alpha of 1 or more, else `rgba()`: channels rounded to whole numbers, alpha to
 * three decimals. A caller that must keep a rule for the color as written rounds the same way.
 */
export function cssColor({ r, g, b, a }: Rgba): string {
  const [R, G, B] = [r, g, b].map(Math.round);
  return a >= 1 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${Math.round(a * 1000) / 1000})`;
}

/** `top` painted over the opaque `under`, as the browser composites them: an opaque color. */
export function over(top: Rgba, under: Rgba): Rgba {
  const mixIn = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mixIn(top.r, under.r), g: mixIn(top.g, under.g), b: mixIn(top.b, under.b), a: 1 };
}

/**
 * `from` moved toward `to` by `amount`, 0 to 1, channel by channel and alpha with them. For two
 * opaque colors that is `color-mix()` in srgb; for translucent ones it is not, since `color-mix()`
 * mixes with premultiplied alpha.
 */
export function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  const step = (f: number, t: number) => f + (t - f) * amount;
  return { r: step(from.r, to.r), g: step(from.g, to.g), b: step(from.b, to.b), a: step(from.a, to.a) };
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2's contrast ratio of two opaque colors, 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
