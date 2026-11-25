// The theme the harness page and the render lab are shown in, and the select on each page's bar
// that chooses it: one of VS Code's built-in themes with its own colors (themes/themes.json,
// which themes/extract.mjs writes from a copy of VS Code), or the page's own dark or light
// colors, the ones the panel's styles fall back on where VS Code gives none. A VS Code theme is
// shown as VS Code shows it to a webview: its kind as classes on <body>, its colors as
// properties of the root element.

import { barSelect, type BarGroup } from './barSelect';
import vscodeThemes from './themes/themes.json';

/** The classes VS Code 1.120 to 1.146 give a webview's <body> for each kind of theme. */
const KIND_CLASSES: Record<string, readonly string[]> = {
  light: ['vscode-light'],
  dark: ['vscode-dark'],
  hcLight: ['vscode-high-contrast', 'vscode-high-contrast-light'],
  hcDark: ['vscode-high-contrast'],
};
const EVERY_KIND_CLASS = [...new Set(Object.values(KIND_CLASSES).flat())];

/** The group each kind of theme is listed under, as VS Code's Color Theme picker groups them. */
const KIND_GROUPS: Record<string, string> = {
  light: 'light',
  dark: 'dark',
  hcLight: 'high contrast',
  hcDark: 'high contrast',
};

/** The page's own colors: the value `?theme=` and `setTheme` name each by, which is also its kind, and its name in the select. */
const OWN = [
  ['dark', 'Dark'],
  ['light', 'Light'],
] as const;

/**
 * Adds the theme select to `bar` and shows the page in the theme `params` asks for: a VS Code
 * theme by its name (`?theme=Dark 2026`), the page's own light colors for `?theme=light`, and its
 * own dark ones otherwise. Gives the function that shows the page in another, by the same names.
 */
export function themeSelect(bar: HTMLElement, params: URLSearchParams): (theme: string) => void {
  // themes.json lists the themes by kind, in the picker's order.
  const groups: BarGroup[] = [...new Set(vscodeThemes.themes.map((t) => KIND_GROUPS[t.kind]))].map((kind) => ({
    label: `VS Code ${vscodeThemes.vscodeVersion}, ${kind}`,
    options: vscodeThemes.themes.filter((t) => KIND_GROUPS[t.kind] === kind).map((t) => [t.name, t.name] as const),
  }));
  const select = barSelect(bar, 'Theme', [...groups, { label: "Without VS Code's colors", options: OWN }], (value) =>
    show(value),
  );
  function show(value: string): void {
    const theme = vscodeThemes.themes.find((t) => t.name === value);
    const own = value === 'light' ? 'light' : 'dark';
    const root = document.documentElement.style;
    for (const property of Array.from(root)) if (property.startsWith('--vscode-')) root.removeProperty(property);
    document.body.classList.remove(...EVERY_KIND_CLASS);
    document.body.classList.add(...(KIND_CLASSES[theme?.kind ?? own] ?? []));
    for (const [property, color] of Object.entries(theme?.variables ?? {})) root.setProperty(property, color);
    select.value = theme?.name ?? own;
  }
  show(params.get('theme') ?? 'dark');
  return show;
}
