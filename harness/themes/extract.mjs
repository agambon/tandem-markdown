// Writes harness/themes/themes.json, the themes the harness pages offer: every color theme a copy
// of VS Code ships, each with the value VS Code gives a webview for every `--vscode-*` color the
// panel reads (src/panel). A theme's own colors come from its file and the files it includes;
// the rest from VS Code's color registry, read from the copy's workbench bundle and resolved as
// VS Code resolves it. Run it again for a new VS Code, or after the panel reads a new color.
//
//   node harness/themes/extract.mjs <VS Code folder> [--out <file>]
//
// The folder is a copy such as .vscode-test/vscode-win32-x64-archive-1.146.0, or its
// resources/app folder. Where the bundle holds what this script cannot read, it stops and says
// so rather than guess a color.
//
// RGBA, HSLA and Color follow VS Code's src/vs/base/common/color.ts, and Theme its color lookup
// in src/vs/platform/theme/common/colorUtils.ts and colorThemeData.ts (VS Code, MIT). Its notice:
//
//   Copyright (c) 2015 - present Microsoft Corporation
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as prettier from 'prettier';
import ts from 'typescript';

const repo = path.join(import.meta.dirname, '..', '..');

/** VS Code's theme kinds by a theme's `uiTheme`, in the order its Color Theme picker lists them. */
const KINDS = { vs: 'light', 'vs-dark': 'dark', 'hc-light': 'hcLight', 'hc-black': 'hcDark' };
const KIND_ORDER = ['light', 'dark', 'hcLight', 'hcDark'];

// ---------------------------------------------------------------------------
// VS Code's colors (src/vs/base/common/color.ts), as the bundle has them

const roundFloat = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
const clamp01 = (n) => Math.max(Math.min(1, n), 0);

class RGBA {
  constructor(r, g, b, a = 1) {
    this.r = Math.min(255, Math.max(0, r)) | 0;
    this.g = Math.min(255, Math.max(0, g)) | 0;
    this.b = Math.min(255, Math.max(0, b)) | 0;
    this.a = roundFloat(clamp01(a), 3);
  }
}

class HSLA {
  constructor(h, s, l, a) {
    this.h = Math.max(Math.min(360, h), 0) | 0;
    this.s = roundFloat(clamp01(s), 3);
    this.l = roundFloat(clamp01(l), 3);
    this.a = roundFloat(clamp01(a), 3);
  }

  static fromRGBA({ r: r255, g: g255, b: b255, a }) {
    const [r, g, b] = [r255 / 255, g255 / 255, b255 / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (min + max) / 2;
    const chroma = max - min;
    let h = 0;
    let s = 0;
    if (chroma > 0) {
      s = Math.min(l <= 0.5 ? chroma / (2 * l) : chroma / (2 - 2 * l), 1);
      if (max === r) h = (g - b) / chroma + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / chroma + 2;
      else h = (r - g) / chroma + 4;
      h = Math.round(h * 60);
    }
    return new HSLA(h, s, l, a);
  }

  static hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  static toRGBA({ h: h360, s, l, a }) {
    const h = h360 / 360;
    let [r, g, b] = [l, l, l];
    if (s !== 0) {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      [r, g, b] = [HSLA.hueToRgb(p, q, h + 1 / 3), HSLA.hueToRgb(p, q, h), HSLA.hueToRgb(p, q, h - 1 / 3)];
    }
    return new RGBA(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a);
  }
}

class Color {
  constructor(value) {
    if (value instanceof HSLA) {
      this.hslaValue = value;
      this.rgba = HSLA.toRGBA(value);
    } else {
      this.rgba = value;
    }
  }

  get hsla() {
    return this.hslaValue ?? HSLA.fromRGBA(this.rgba);
  }

  /** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; a value of another length is red, as in VS Code. */
  static fromHex(hex) {
    if (!/^#(.{3,4}|.{6}|.{8})$/.test(hex)) return new Color(new RGBA(255, 0, 0, 1));
    if (!/^#[0-9a-f]+$/i.test(hex))
      stop(`${hex} is not a hex color, and VS Code's reading of it is not computed here.`);
    const digits = hex.slice(1);
    const pairs = digits.length <= 4 ? [...digits].map((d) => d + d) : digits.match(/../g);
    const [r, g, b, a = 255] = pairs.map((p) => parseInt(p, 16));
    return new Color(new RGBA(r, g, b, a / 255));
  }

  lighten(factor) {
    const { h, s, l, a } = this.hsla;
    return new Color(new HSLA(h, s, l + l * factor, a));
  }

  darken(factor) {
    const { h, s, l, a } = this.hsla;
    return new Color(new HSLA(h, s, l - l * factor, a));
  }

  transparent(factor) {
    const { r, g, b, a } = this.rgba;
    return new Color(new RGBA(r, g, b, a * factor));
  }

  makeOpaque(background) {
    if (this.rgba.a === 1 || background.rgba.a !== 1) return this;
    const { r, g, b, a } = this.rgba;
    const under = background.rgba;
    return new Color(
      new RGBA(under.r - a * (under.r - r), under.g - a * (under.g - g), under.b - a * (under.b - b), 1),
    );
  }

  mix(other, ratio = 0.5) {
    const t = clamp01(ratio);
    const [x, y] = [this.rgba, other.rgba];
    return new Color(
      new RGBA(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t, x.a + (y.a - x.a) * t),
    );
  }

  /** As VS Code writes a color into a webview's CSS: `#rrggbb` when opaque, else `rgba(...)`. */
  toString() {
    const { r, g, b, a } = this.rgba;
    if (a === 1) return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})`;
  }
}

// ---------------------------------------------------------------------------
// Reading the bundle: one JavaScript expression at a time, the few forms the registry uses

/**
 * The expression that starts at `at` in `src`, as a tree; null when it is not one of the forms read
 * here, or when more of the expression follows than these forms take (`a?b:c` is not read as `a`).
 */
function parseExpression(src, at) {
  let i = at;
  const skip = () => {
    while (/\s/.test(src[i] ?? '')) i++;
  };
  const take = (text) => {
    skip();
    if (!src.startsWith(text, i)) throw new SyntaxError(text);
    i += text.length;
  };
  const word = () => {
    skip();
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
    if (!m) throw new SyntaxError('name');
    i += m[0].length;
    return m[0];
  };
  const list = (close) => {
    const items = [];
    skip();
    if (src[i] === close) {
      i++;
      return items;
    }
    for (;;) {
      items.push(expression());
      skip();
      if (src[i] === close) {
        i++;
        return items;
      }
      take(',');
    }
  };
  function primary() {
    skip();
    const c = src[i];
    const number = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i, i + 40));
    if (number) {
      i += number[0].length;
      return { t: 'num', v: Number(number[0]) };
    }
    if (c === '"' || c === "'") {
      let end = i + 1;
      while (src[end] !== c) {
        if (end >= src.length) throw new SyntaxError('string');
        end += src[end] === '\\' ? 2 : 1;
      }
      const v = JSON.parse(`"${src.slice(i + 1, end).replace(/\\'/g, "'")}"`);
      i = end + 1;
      return { t: 'str', v };
    }
    if (c === '{') {
      i++;
      const props = [];
      skip();
      if (src[i] === '}') i++;
      else
        for (;;) {
          const key = word();
          take(':');
          props.push([key, expression()]);
          skip();
          if (src[i] === '}') {
            i++;
            break;
          }
          take(',');
        }
      return { t: 'obj', props };
    }
    const name = word();
    if (name === 'null') return { t: 'null' };
    if (name === 'new') {
      const callee = word();
      take('(');
      return { t: 'new', callee, args: list(')') };
    }
    return { t: 'id', name };
  }
  function expression() {
    let node = primary();
    for (;;) {
      skip();
      if (src[i] === '.' && /[A-Za-z_$]/.test(src[i + 1] ?? '')) {
        i++;
        node = { t: 'member', object: node, name: word() };
      } else if (src[i] === '(') {
        i++;
        node = { t: 'call', callee: node, args: list(')') };
      } else {
        return node;
      }
    }
  }
  try {
    const node = expression();
    skip();
    return /^[,;)}]/.test(src[i] ?? ';') ? node : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function stop(message) {
  console.error(message);
  process.exit(1);
}

/** The first match of `pattern` in the bundle, or a stop that names `what` could not be found. */
function find(bundle, pattern, what) {
  return pattern.exec(bundle) ?? stop(`The bundle has no ${what} where this script looks for it (${pattern}).`);
}

/**
 * VS Code's color registry as the bundle declares it: each color's id and its defaults (a tree), the
 * names the bundle gives colors, the color classes and the transform helpers.
 */
function readRegistry(bundle) {
  const register = find(bundle, /(?<![\w$.])([\w$]+)\("editor\.background",\{/, 'color registry')[1];
  const colorClass = find(bundle, /([\w$]+)=class [\w$]+\{static fromHex\(/, 'Color class')[1];
  const rgbaClass = find(
    bundle,
    /([\w$]+)=class\{constructor\([\w$]+,[\w$]+,[\w$]+,[\w$]+=1\)\{this\._rgbaBrand/,
    'RGBA class',
  )[1];
  const body = bundle.slice(bundle.indexOf(`${colorClass}=class `));
  const statics = new Map();
  const staticColor = new RegExp(
    `^static\\{this\\.(\\w+)=new [\\w$]+\\(new ${escape(rgbaClass)}\\(([\\d.,]+)\\)\\)\\}`,
  );
  for (const m of body.matchAll(/static\{this\.\w+=/g)) {
    const color = staticColor.exec(body.slice(m.index, m.index + 120));
    if (!color) break;
    const [r, g, b, a] = color[2].split(',').map(Number);
    if (!statics.has(color[1])) statics.set(color[1], new Color(new RGBA(r, g, b, a)));
  }
  const helpers = new Map();
  for (const m of bundle.matchAll(/function ([\w$]+)\(([\w$.,]*)\)\{return\{op:(\d+),([^{}]*)\}\}/g)) {
    const params = m[2].split(',').map((p) => p.replace('...', ''));
    const fields = m[4].split(',').map((f) => f.split(':'));
    const helper = { op: +m[3], params, rest: m[2].includes('...'), fields };
    const seen = helpers.get(m[1]);
    helpers.set(m[1], seen && JSON.stringify(seen) !== JSON.stringify(helper) ? null : helper);
  }
  const defaults = new Map();
  const names = new Map();
  const call = new RegExp(`(?:([\\w$]+)=|(?<![\\w$.]))${escape(register)}\\("([\\w.-]+)",`, 'g');
  for (const m of bundle.matchAll(call)) {
    // A form not read here stops the script only if the panel reads that color (`valueOf`).
    if (!defaults.has(m[2])) defaults.set(m[2], parseExpression(bundle, m.index + m[0].length) ?? { t: 'unread' });
    if (m[1]) names.set(m[1], m[2]);
  }
  return {
    bundle,
    colorClass,
    rgbaClass,
    statics,
    helpers,
    ops: readOps(bundle),
    defaults,
    names,
    constants: new Map(),
  };
}

/** Each case of the bundle's resolver, by what its code does, in the order they are told apart. */
const OP_SIGNS = [
  ['lessProminent', /\.isDarkerThan\(/],
  ['mix', /\.mix\(/],
  ['opaque', /\.makeOpaque\(/],
  ['firstDefined', /\.values\)/],
  ['ifDefined', /\.defines\(/],
  ['opacity', /\.opacity\)/],
  ['darken', /\.darken\(/],
  ['lighten', /\.lighten\(/],
  ['transparent', /\.transparent\([\w$]+\.factor\)/],
];

/**
 * What each transform's op number means, read from the bundle's resolver of transforms (its
 * `switch` on `op`, in VS Code's colorUtils.ts): op number to a name of `OP_SIGNS`. Stops when the
 * resolver is not found, or a case does what none of the signs names, or two cases share a name.
 */
function readOps(bundle) {
  const start = bundle.search(/case \d+:return [\w$]+\([\w$]+\.value,[\w$]+\)\?\.darken\(/);
  if (start < 0) stop('The bundle has no resolver of color transforms where this script looks for it.');
  const cases = bundle
    .slice(start, bundle.indexOf('default:', start))
    .split(/case (\d+):/)
    .slice(1);
  const ops = new Map();
  for (let k = 0; k < cases.length; k += 2) {
    const sign = OP_SIGNS.find(([, pattern]) => pattern.test(cases[k + 1]));
    if (!sign) stop(`The color transform op ${cases[k]} does what this script does not know.`);
    if ([...ops.values()].includes(sign[0])) stop(`Two color transform ops read as ${sign[0]}.`);
    ops.set(Number(cases[k]), sign[0]);
  }
  return ops;
}

/** `name` for a regular expression: a bundle's names may hold `$`. */
function escape(name) {
  return name.replace(/\$/g, '\\$');
}

/** The one value `name` is given at the bundle's top level, as a tree; a name given two different values stops the script. */
function constant(registry, name) {
  if (registry.constants.has(name)) return registry.constants.get(name);
  const found = new Map();
  for (const m of registry.bundle.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}=(?!=)`, 'g'))) {
    const node = parseExpression(registry.bundle, m.index + m[0].length);
    if (node) found.set(JSON.stringify(node), node);
  }
  if (found.size !== 1)
    stop(`${name} is given ${found.size} different values in the bundle; its color cannot be read.`);
  const node = [...found.values()][0];
  registry.constants.set(name, node);
  return node;
}

/**
 * A tree from the registry as the value VS Code holds: a number, a string (a hex color or the id
 * of another color), null, a Color, a transform (`{ op, ... }`) or the four kinds' defaults.
 */
function valueOf(registry, node) {
  switch (node.t) {
    case 'num':
    case 'str':
      return node.v;
    case 'null':
      return null;
    case 'obj':
      return Object.fromEntries(node.props.map(([key, value]) => [key, valueOf(registry, value)]));
    case 'new': {
      const [inner] = node.args;
      if (node.callee !== registry.colorClass || inner?.t !== 'new' || inner.callee !== registry.rgbaClass) break;
      const [r, g, b, a = 1] = inner.args.map((arg) => valueOf(registry, arg));
      return new Color(new RGBA(r, g, b, a));
    }
    case 'id':
      if (registry.names.has(node.name)) return registry.names.get(node.name);
      return valueOf(registry, constant(registry, node.name));
    case 'member':
      if (node.object.t === 'id' && node.object.name === registry.colorClass && registry.statics.has(node.name))
        return registry.statics.get(node.name);
      break;
    case 'call': {
      const args = node.args.map((arg) => valueOf(registry, arg));
      const callee = node.callee;
      if (callee.t === 'id' && registry.helpers.get(callee.name)) {
        const helper = registry.helpers.get(callee.name);
        const bound = Object.fromEntries(helper.params.map((p, k) => [p, helper.rest ? args.slice(k) : args[k]]));
        return Object.fromEntries([['op', helper.op], ...helper.fields.map(([field, param]) => [field, bound[param]])]);
      }
      if (callee.t === 'member' && callee.object.t === 'id' && callee.object.name === registry.colorClass) {
        if (callee.name === 'fromHex') return Color.fromHex(args[0]);
      } else if (callee.t === 'member' && ['transparent', 'darken', 'lighten'].includes(callee.name)) {
        const color = valueOf(registry, callee.object);
        if (color instanceof Color) return color[callee.name](args[0]);
      }
      break;
    }
  }
  return stop(`A color default in a form this script does not read: ${JSON.stringify(node).slice(0, 300)}.`);
}

// ---------------------------------------------------------------------------
// A theme, and a color in it (src/vs/platform/theme/common/colorUtils.ts)

class Theme {
  constructor(registry, kind, colors) {
    this.registry = registry;
    this.kind = kind;
    this.colors = colors;
  }

  defines(id) {
    return this.colors.has(id);
  }

  getColor(id) {
    if (this.colors.has(id)) return this.colors.get(id);
    const node = this.registry.defaults.get(id);
    if (!node) return undefined;
    if (node.t === 'unread') stop(`The defaults of ${id} are in a form this script does not read.`);
    const value = valueOf(this.registry, node);
    const isDefaults = value !== null && typeof value === 'object' && 'light' in value && 'dark' in value;
    return this.resolve(isDefaults ? value[this.kind] : value);
  }

  /** A registry value as a color in this theme, or undefined where VS Code gives none. */
  resolve(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') return value.startsWith('#') ? Color.fromHex(value) : this.getColor(value);
    if (value instanceof Color) return value;
    const color = (v) => this.resolve(v);
    switch (this.registry.ops.get(value.op)) {
      case 'darken':
        return color(value.value)?.darken(value.factor);
      case 'lighten':
        return color(value.value)?.lighten(value.factor);
      case 'transparent':
        return color(value.value)?.transparent(value.factor);
      case 'opaque': {
        const background = color(value.background);
        return background ? color(value.value)?.makeOpaque(background) : color(value.value);
      }
      case 'firstDefined':
        for (const v of value.values) {
          const found = color(v);
          if (found) return found;
        }
        return undefined;
      case 'ifDefined':
        return color(this.defines(value.if) ? value.then : value.else);
      case 'mix': {
        const clear = new Color(new RGBA(0, 0, 0, 0));
        return (color(value.color) ?? clear).mix(color(value.with) ?? clear, value.ratio);
      }
      case 'opacity': {
        const rgba = color(value.value)?.rgba;
        return rgba && new Color(new RGBA(rgba.r, rgba.g, rgba.b, value.opacity));
      }
    }
    return stop(`A color transform this script does not compute (op ${value.op}, ${this.registry.ops.get(value.op)}).`);
  }
}

// ---------------------------------------------------------------------------
// The themes VS Code ships

/** A JSON file that may hold comments and trailing commas, as theme files do. */
function readJsonc(file) {
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (error) stop(`${file} could not be read: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`);
  return config;
}

/** A theme file's colors with those of the files it includes beneath them, as VS Code reads them. */
function themeColors(file) {
  const theme = readJsonc(file);
  const colors = theme.include ? themeColors(path.join(path.dirname(file), theme.include)) : new Map();
  for (const [id, value] of Object.entries(theme.colors ?? {}))
    if (typeof value === 'string') colors.set(id, Color.fromHex(value));
  return colors;
}

function shippedThemes(app) {
  const themes = [];
  const extensions = path.join(app, 'extensions');
  for (const dir of readdirSync(extensions)) {
    const manifest = path.join(extensions, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const contributed = readJsonc(manifest).contributes?.themes ?? [];
    const nlsFile = path.join(extensions, dir, 'package.nls.json');
    const nls = existsSync(nlsFile) ? readJsonc(nlsFile) : {};
    for (const t of contributed) {
      const name = t.label.replace(/^%(.+)%$/, (_, key) => {
        const entry = nls[key];
        return typeof entry === 'string'
          ? entry
          : (entry?.message ?? stop(`${dir} names ${key} and gives it no text.`));
      });
      themes.push({ name, kind: KINDS[t.uiTheme], colors: themeColors(path.join(extensions, dir, t.path)) });
    }
  }
  return themes.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/** Every `--vscode-*` name the panel's code and styles read. */
function panelVariables() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|css)$/.test(entry.name))
        for (const m of readFileSync(file, 'utf8').matchAll(/--vscode-([\w-]+)/g)) names.add(m[1]);
    }
  };
  walk(path.join(repo, 'src', 'panel'));
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Start

/** The app folder of the copy in `folder`: the folder itself, its resources/app, or that of a folder inside it. */
function appFolder(folder) {
  const inside = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const base of [folder, ...inside.map((e) => path.join(folder, e.name))])
    for (const app of [base, path.join(base, 'resources', 'app')])
      if (existsSync(path.join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'))) return app;
  return stop(`No copy of VS Code was found in ${folder}.`);
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? path.resolve(args[outAt + 1]) : path.join(import.meta.dirname, 'themes.json');
const folder = outAt >= 0 ? args.filter((_, k) => k !== outAt && k !== outAt + 1)[0] : args[0];
if (!folder) stop('Name a copy of VS Code: node harness/themes/extract.mjs <VS Code folder> [--out <file>]');

const app = appFolder(path.resolve(folder));
const version = readJsonc(path.join(app, 'package.json')).version;
const registry = readRegistry(
  readFileSync(path.join(app, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'), 'utf8'),
);

// VS Code 1.120 to 1.146 name a color's variable by its id with its first dot made a dash.
const byVariable = new Map([...registry.defaults.keys()].map((id) => [id.replace('.', '-'), id]));
const wanted = panelVariables();
const notColors = wanted.filter((name) => !byVariable.has(name));

const themes = shippedThemes(app).map(({ name, kind, colors }) => {
  const theme = new Theme(registry, kind, colors);
  const variables = {};
  for (const name of wanted) {
    const color = byVariable.has(name) ? theme.getColor(byVariable.get(name)) : undefined;
    if (color) variables[`--vscode-${name}`] = color.toString();
  }
  return { name, kind, variables };
});

const text = JSON.stringify({ vscodeVersion: version, themes }, null, 2);
writeFileSync(out, await prettier.format(text, { ...(await prettier.resolveConfig(out)), filepath: out }));
console.log(`${themes.length} themes from VS Code ${version} written to ${path.relative(process.cwd(), out)}.`);
if (notColors.length > 0)
  console.log(`Not theme colors, left to the page: ${notColors.map((n) => `--vscode-${n}`).join(', ')}.`);
