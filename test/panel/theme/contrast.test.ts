// Reading colors as VS Code and the browser write them, and WCAG 2's contrast ratio.

import { describe, expect, it } from 'vitest';
import { contrast, cssColor, parseColor } from '../../../src/panel/theme/contrast';

describe('colors', () => {
  it('reads the forms VS Code and the browser write, and nothing else', () => {
    expect(parseColor('#1f1f1f')).toEqual({ r: 31, g: 31, b: 31, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#347d3966')).toEqual({ r: 52, g: 125, b: 57, a: 0.4 });
    expect(parseColor(' rgb(204, 204, 204) ')).toEqual({ r: 204, g: 204, b: 204, a: 1 });
    expect(parseColor('rgba(155, 185, 85, 0.2)')).toEqual({ r: 155, g: 185, b: 85, a: 0.2 });
    for (const text of ['', 'green', 'transparent', '#12345', 'hsl(0, 0%, 0%)']) expect(parseColor(text)).toBeNull();
  });

  it('writes a color back as CSS', () => {
    expect(cssColor({ r: 31.4, g: 31, b: 31, a: 1 })).toBe('rgb(31, 31, 31)');
    expect(cssColor({ r: 155, g: 185, b: 85, a: 0.28125 })).toBe('rgba(155, 185, 85, 0.281)');
  });

  it("gives WCAG's ratios: 21 for black on white, 1 for a color on itself", () => {
    const white = parseColor('#ffffff')!;
    const black = parseColor('#000000')!;
    expect(contrast(black, white)).toBeCloseTo(21, 6);
    expect(contrast(white, black)).toBeCloseTo(21, 6);
    expect(contrast(white, white)).toBe(1);
    expect(contrast(parseColor('#767676')!, white)).toBeCloseTo(4.54, 2);
  });
});
