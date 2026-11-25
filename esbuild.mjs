// Builds the bundles. Flags:
//   (none)        host + panel
//   --production  minified, no source maps
//   --watch       rebuild on change (host + panel)
//   --harness     also build the browser harness into dist/harness
//   --itest       also build the in-VS-Code test suite into out/itest
//
// Imported, it builds nothing: scripts/third-party.mjs takes the host, panel and diagram frame
// build options and the copied packages from here, and harness/serve.mjs calls `buildHarness`.
import { realpathSync } from 'node:fs';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = import.meta.dirname;
const at = (...parts) => path.join(root, ...parts);

/** What every bundle shares. A production build is minified and has no source maps. */
function common(production) {
  return {
    bundle: true,
    sourcemap: production ? false : 'linked',
    minify: production,
    target: 'es2022',
    logLevel: 'info',
    absWorkingDir: root,
  };
}

/**
 * gemoji's module as the host and the panel read it: each name with its emoji, without the
 * descriptions and tags the package also holds, which are most of its size.
 */
const emojiNamesOnly = {
  name: 'emoji-names-only',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]gemoji[\\/]index\.js$/ }, async () => {
      const { nameToEmoji } = await import('gemoji');
      return { contents: `export const nameToEmoji = ${JSON.stringify(nameToEmoji)};\n`, loader: 'js' };
    });
  },
};

/** The extension host bundle. `vscode` is provided by VS Code at run time. */
export function hostOptions({ production = false } = {}) {
  return {
    ...common(production),
    entryPoints: ['src/host/extension.ts'],
    outfile: 'dist/host/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    plugins: [emojiNamesOnly],
  };
}

/** The panel (webview) bundle. ES modules with splitting so code-block languages load on demand. */
export function panelOptions({ production = false } = {}) {
  return {
    ...common(production),
    entryPoints: { main: 'src/panel/main.ts', panel: 'src/panel/theme/panel.css' },
    outdir: 'dist/panel',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    loader: { '.ttf': 'file', '.svg': 'dataurl' },
    plugins: [emojiNamesOnly],
  };
}

/**
 * The code of the diagram frame (src/panel/render/diagramFrame.ts): Mermaid and what drives it,
 * as one script, since the frame can fetch nothing. The panel imports it as a module whose
 * default export is the script's text (`asTextModule`) and hands that to the frame. Always
 * built as for production, minified: it is mostly Mermaid, and every new frame compiles it.
 */
export function frameOptions() {
  return {
    ...common(true),
    entryPoints: ['src/panel/render/frame/main.ts'],
    outfile: 'dist/panel/diagram-frame.js',
    platform: 'browser',
    format: 'iife',
  };
}

/** Writes each output, built with `write: false`, as a module whose default export is its text. */
const asTextModule = {
  name: 'as-text-module',
  setup(build) {
    build.onEnd(async (result) => {
      for (const file of result.outputFiles ?? []) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, `export default ${JSON.stringify(file.text)};\n`);
      }
    });
  },
};

/**
 * Packages whose files are copied as they ship, not bundled: `files` (files or folders) from
 * `from` into `to`, less any file `skip` matches.
 */
export const COPIED_PACKAGES = [
  { name: '@vscode/codicons', from: 'dist', files: ['codicon.css', 'codicon.ttf'], to: 'dist/panel' },
  // KaTeX's stylesheet, loaded with KaTeX, and its fonts. The stylesheet names each font in
  // WOFF2 first, which every Chromium reads, so the WOFF and TrueType copies are left out.
  { name: 'katex', from: 'dist', files: ['katex.min.css', 'fonts'], to: 'dist/panel/katex', skip: /\.(woff|ttf)$/ },
];

/**
 * The browser harness: the same panel code, built as the panel is, against a fake host, in a
 * plain web page.
 * `lab` is the render lab (harness/lab.html): the editor with every drawing feature and no host.
 */
function harnessOptions(production) {
  return {
    ...panelOptions({ production }),
    entryPoints: { harness: 'harness/harness.ts', lab: 'harness/lab.ts' },
    outdir: 'dist/harness',
  };
}

/**
 * Tests that run inside a real VS Code. mocha and vscode are loaded at run time. Every
 * `itest/suite/*.test.ts` is its own entry, so the suite's index can add them one by one. The
 * helper extension the suite loads beside this one goes to out/itest/helper with its manifest.
 */
async function itestOptions(production) {
  const suites = (await readdir(at('itest', 'suite')))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `itest/suite/${name}`);
  return {
    ...common(production),
    entryPoints: ['itest/runTest.ts', 'itest/suite/index.ts', 'itest/helper/extension.ts', ...suites],
    outdir: 'out/itest',
    outbase: 'itest',
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
  };
}

/** `file`, a path under dist/, moved under `out`. */
const moved = (out, file) => path.join(out, path.relative('dist', file));

async function copyStatic(harness, out = at('dist')) {
  for (const pkg of COPIED_PACKAGES) {
    const to = moved(out, pkg.to);
    await mkdir(to, { recursive: true });
    const filter = (source) => !pkg.skip?.test(source);
    for (const file of pkg.files) {
      await cp(at('node_modules', pkg.name, pkg.from, file), path.join(to, file), { recursive: true, filter });
    }
  }
  if (harness) {
    // The two pages, the sound the made-up workspace's players play, and the samples, with a
    // list of the samples for the pickers.
    const pages = path.join(out, 'harness');
    await mkdir(path.join(pages, 'samples'), { recursive: true });
    await cp(at('harness', 'index.html'), path.join(pages, 'index.html'));
    await cp(at('harness', 'lab.html'), path.join(pages, 'lab.html'));
    await cp(at('harness', 'fakes', 'silence.wav'), path.join(pages, 'silence.wav'));
    const samples = (await readdir(at('harness', 'samples'))).filter((name) => name.endsWith('.md')).sort();
    for (const name of samples) await cp(at('harness', 'samples', name), path.join(pages, 'samples', name));
    await writeFile(path.join(pages, 'samples', 'index.json'), JSON.stringify(samples));
  }
}

/**
 * Builds the panel and the browser harness into `out`, laid out as in dist/. Each script that
 * serves the harness builds into a folder of its own (harness/serve.mjs), so two of them running
 * at once never load files the other is writing.
 */
export async function buildHarness(out) {
  const builds = [
    panelOptions(),
    { ...frameOptions(), write: false, plugins: [asTextModule] },
    harnessOptions(false),
  ].map((options) => {
    const where = options.outdir ? { outdir: moved(out, options.outdir) } : { outfile: moved(out, options.outfile) };
    return { ...options, ...where, logLevel: 'warning' };
  });
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await copyStatic(true, out);
}

async function build(args) {
  const production = args.has('--production');
  const watch = args.has('--watch');
  const wanted = [
    ['host', hostOptions({ production })],
    ['panel', panelOptions({ production })],
    ['frame', { ...frameOptions(), write: false, plugins: [asTextModule] }],
  ];
  if (args.has('--harness')) wanted.push(['harness', harnessOptions(production)]);
  if (args.has('--itest')) wanted.push(['itest', await itestOptions(production)]);
  const builds = wanted.map(([, options]) => options);
  // A test file renamed or removed must not linger as an old bundle that still runs.
  if (args.has('--itest')) await rm(at('out', 'itest'), { recursive: true, force: true });
  // Split chunks are named by content, so every build leaves the previous build's chunks behind.
  // The package ships all of dist/panel, so a production build clears what it rebuilds first and no
  // stale chunk is packaged. Development builds leave the folders alone: a watch build or a running
  // browser check may be reading them.
  if (production && !watch) {
    for (const [name] of wanted) {
      if (name === 'host' || name === 'panel' || name === 'harness') {
        await rm(at('dist', name), { recursive: true, force: true });
      }
    }
  }

  if (args.has('--itest')) {
    await mkdir(at('out', 'itest', 'helper'), { recursive: true });
    await cp(at('itest', 'helper', 'package.json'), at('out', 'itest', 'helper', 'package.json'));
  }

  if (watch) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await copyStatic(args.has('--harness'));
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    await Promise.all(builds.map((options) => esbuild.build(options)));
    await copyStatic(args.has('--harness'));
  }
}

// Node resolves the script it runs through its real path, so compare real paths.
const runDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;
if (runDirectly) await build(new Set(process.argv.slice(2)));
