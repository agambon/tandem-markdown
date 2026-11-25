// What the panel's page loads before it can take a document, and what loads only when a note
// needs it, from a production build of the panel made with a metafile into the system's
// temporary folder (dist/ is left alone). Before `ready`: main.js, the boot chunk it imports,
// and every chunk either imports statically, then the stylesheets and the icon font. On demand:
// for each dynamic import, the chunks it brings that are not loaded already.
//
//   node scripts/speed/bundle.mjs

import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { frameOptions, panelOptions } from '../../esbuild.mjs';

const repo = path.join(import.meta.dirname, '..', '..');
const out = path.join(os.tmpdir(), 'tandem-markdown-speed', 'panel');
await rm(out, { recursive: true, force: true });

const panel = panelOptions({ production: true });
const result = await esbuild.build({ ...panel, outdir: out, metafile: true, logLevel: 'error' });
const frame = await esbuild.build({ ...frameOptions(), write: false, logLevel: 'error' });

const outputs = result.metafile.outputs;
const keyOf = new Map(Object.keys(outputs).map((k) => [path.resolve(repo, k), k]));
const resolve = (p) => keyOf.get(path.resolve(repo, p));

/** `start` and every chunk it imports statically. */
function closure(start, into = new Set()) {
  if (!start || into.has(start)) return into;
  into.add(start);
  for (const i of outputs[start].imports) if (i.kind === 'import-statement') closure(resolve(i.path), into);
  return into;
}
const bytesOf = (keys) => [...keys].reduce((n, k) => n + outputs[k].bytes, 0);

const main = Object.keys(outputs).find((k) => k.endsWith('main.js'));
const boot = outputs[main].imports.find((i) => i.kind === 'dynamic-import');
const atStart = closure(resolve(boot.path), closure(main));
const scriptBytes = bytesOf(atStart);
const css = Object.keys(outputs).find((k) => k.endsWith('panel.css'));
const copied = async (file) => (await stat(path.join(repo, 'node_modules', file))).size;
const codicons =
  (await copied('@vscode/codicons/dist/codicon.css')) + (await copied('@vscode/codicons/dist/codicon.ttf'));
console.log(
  `Before ready: ${scriptBytes.toLocaleString('en')} bytes of script in ${atStart.size} chunks; ` +
    `with panel.css and the icon font, ${(scriptBytes + outputs[css].bytes + codicons).toLocaleString('en')} bytes`,
);

/** The package or source folder that the largest share of the bytes of `keys` comes from. */
function label(keys) {
  const by = new Map();
  for (const k of keys)
    for (const [input, info] of Object.entries(outputs[k].inputs)) {
      const name = input.includes('node_modules/')
        ? input.replace(/^.*node_modules\/((@[^/]+\/)?[^/]+).*$/, '$1')
        : input.replace(/^(src\/panel\/[^/]+).*$/, '$1');
      by.set(name, (by.get(name) ?? 0) + info.bytesInOutput);
    }
  return [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
}

const targets = new Set();
for (const o of Object.values(outputs))
  for (const i of o.imports) if (i.kind === 'dynamic-import' && resolve(i.path)) targets.add(resolve(i.path));
const onDemand = [];
for (const target of targets) {
  if (atStart.has(target)) continue;
  const brought = [...closure(target)].filter((k) => !atStart.has(k));
  onDemand.push({ name: label(brought), bytes: bytesOf(brought) });
}

const katexFiles = path.join(repo, 'node_modules', 'katex', 'dist');
let katexAssets = (await stat(path.join(katexFiles, 'katex.min.css'))).size;
for (const font of await readdir(path.join(katexFiles, 'fonts')))
  if (font.endsWith('.woff2')) katexAssets += (await stat(path.join(katexFiles, 'fonts', font))).size;
const frameBytes = frame.outputFiles[0].contents.length;

// KaTeX's stylesheet and fonts load with it; a browser fetches a font only when a formula uses it.
const named = [
  ['KaTeX (math)', 'katex', `, and its stylesheet and fonts, ${katexAssets.toLocaleString('en')} bytes at most`],
  ['DOMPurify (HTML)', 'dompurify', ''],
  ['yaml (front matter)', 'yaml', ''],
];
for (const [title, pkg, more] of named) {
  const bytes = onDemand.filter((d) => d.name === pkg).reduce((n, d) => n + d.bytes, 0);
  console.log(`On demand, ${title}: ${bytes.toLocaleString('en')} bytes of script${more}`);
}
console.log(`On demand, Mermaid (diagrams): its frame's script, ${frameBytes.toLocaleString('en')} bytes`);
const rest = onDemand.filter((d) => !named.some(([, pkg]) => pkg === d.name));
console.log(
  `On demand, the rest (code block grammars and smaller parts): ${rest.length} imports, ` +
    `${rest.reduce((n, d) => n + d.bytes, 0).toLocaleString('en')} bytes`,
);
