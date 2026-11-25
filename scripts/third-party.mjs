// Writes THIRD_PARTY_NOTICES.md: every package whose code is in the production bundles, with
// its license text as the package ships it, and the code adapted into this project's own files.
//
//   node scripts/third-party.mjs           write the file
//   node scripts/third-party.mjs --check   exit 1 if the file is not what the build gives
//
// The bundles are built in memory with esbuild.mjs's production options, so the list is exactly
// the packages that put bytes into dist/. Nothing is written but the notices.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { COPIED_PACKAGES, frameOptions, hostOptions, panelOptions } from '../esbuild.mjs';

const root = path.join(import.meta.dirname, '..');
const target = path.join(root, 'THIRD_PARTY_NOTICES.md');

const BUNDLES = {
  host: hostOptions({ production: true }),
  panel: panelOptions({ production: true }),
  'diagram frame': frameOptions(),
};

/**
 * What the notices say of a copied package beyond what it ships: the license files that apply
 * when it ships more than one, and a note. A copied package with no entry gets every license file.
 */
const COPIED_NOTES = {
  '@vscode/codicons': {
    licenseFiles: ['LICENSE-CODE'],
    note:
      'The icon font is © Microsoft Corporation under the Creative Commons Attribution 4.0 International ' +
      'license (https://creativecommons.org/licenses/by/4.0/legalcode), unmodified. Its CSS is under the ' +
      'MIT license below.',
  },
};

/** The license of each package whose manifest names none, as its own license file states it. */
const UNNAMED_LICENSES = { khroma: 'MIT' };

/** The packages esbuild.mjs copies into dist/, each named for the folder it lands in and its files. */
const COPIED = COPIED_PACKAGES.map((p) => ({
  name: p.name,
  bundle: `${path.posix.basename(p.to)} (${p.files.join(', ')})`,
  ...COPIED_NOTES[p.name],
}));

/**
 * Code in this project's own files that is adapted from elsewhere, or written from a published
 * description. Each entry names words its file's own notice contains: the script stops when no
 * file under src/ holds them, so this list cannot outlive the code it describes.
 */
const ADAPTED = [
  {
    mark: 'node-diff3',
    text:
      '`diff3Regions` is a port of `diff3MergeRegions` from node-diff3 4.0.0 (MIT). Its notice: ' +
      '"diff function extracted from Project Synchrotron. Copyright (c) 2006, 2008 Tony Garnock-Jones ' +
      '<tonyg@lshift.net>. Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net>. Copyright (c) ' +
      '2019-2026 Bryan Housel <bhousel@gmail.com>." The MIT license text below applies.',
  },
  {
    mark: "GFM's flanking rule for a run of delimiter marks",
    text:
      "The flanking test for a run of delimiter marks is @lezer/markdown's Strikethrough extension's " +
      '(MIT, Copyright (C) 2020 by Marijn Haverbeke and others; its license text is below).',
  },
  {
    mark: 'Strikethrough extension (MIT) with `=`',
    text:
      "The highlight syntax is @lezer/markdown's Strikethrough extension with `=` in place of `~` " +
      '(MIT, Copyright (C) 2020 by Marijn Haverbeke and others; its license text is below).',
  },
  {
    mark: '`Subscript` and `Superscript` (MIT) define them',
    text:
      "The subscript and superscript nodes are defined as @lezer/markdown's `Subscript` and `Superscript` " +
      'define them (MIT, Copyright (C) 2020 by Marijn Haverbeke and others; its license text is below).',
  },
  {
    mark: '`HardBreak` inline parser (MIT)',
    text:
      "`LinearHardBreak` is @lezer/markdown's `HardBreak` inline parser with one guard added " +
      '(MIT, Copyright (C) 2020 by Marijn Haverbeke and others; its license text is below).',
  },
  {
    mark: "markdown-it 15.0's `isValidEntityCode`",
    text:
      "`decodable` follows markdown-it's `isValidEntityCode` " +
      '(MIT, Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin; its license text is below).',
  },
  {
    mark: "turndown 7.2.5's `markdownEscapes`",
    text:
      "`MARKDOWN_ESCAPES` is turndown's `markdownEscapes` less its escape of `_` " +
      '(MIT, Copyright (c) 2017 Dom Christie; its license text is below).',
  },
  {
    mark: "@lezer/markdown 1.8.1's `parseRow`",
    text:
      "`splitRow` and `DELIMITER_ROW` follow @lezer/markdown's `parseRow` and `delimiterLine` " +
      '(MIT, Copyright (C) 2020 by Marijn Haverbeke and others; its license text is below).',
  },
  {
    mark: "from html-pipeline 2's",
    text:
      "The allowed elements and attributes are the allow-list of html-pipeline 2's `SanitizationFilter` " +
      '(MIT, Copyright (c) 2012 GitHub Inc. and Jerry Cheung). The MIT license text below applies.',
  },
  {
    mark: 'from primer/primitives',
    text:
      "The code colors are Primer's `prettylights` syntax colors, from primer/primitives " +
      '(MIT, Copyright (c) 2018 GitHub Inc.). The MIT license text below applies.',
  },
  {
    mark: 'Myers',
    text:
      'The sequence diff is written from E. W. Myers, "An O(ND) Difference Algorithm and Its Variations", ' +
      'Algorithmica 1 (1986), section 4b. No code was taken from another implementation.',
  },
  {
    mark: 'diff-match-patch',
    text:
      "`edgeScore` ranks the places a change may start or end on the scale diff-match-patch's semantic " +
      "cleanup describes. The code is this project's own.",
  },
];

async function bundledPackages() {
  const found = new Map();
  for (const [bundle, options] of Object.entries(BUNDLES)) {
    const result = await esbuild.build({ ...options, write: false, metafile: true, logLevel: 'error' });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        const at = input.lastIndexOf('node_modules/');
        if (bytesInOutput === 0 || at < 0) continue;
        const parts = input.slice(at + 'node_modules/'.length).split('/');
        const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
        const dir = path.join(root, input.slice(0, at), 'node_modules', name);
        const entry = found.get(dir) ?? { name, dir, bundles: new Set() };
        entry.bundles.add(bundle);
        found.set(dir, entry);
      }
    }
  }
  return [...found.values()].map((p) => ({ ...p, bundle: [...p.bundles].sort().join(', ') }));
}

/** A license file's text with its byte-order mark, indentation and trailing spaces removed. */
function readLicense(file) {
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const indent = Math.min(...indents);
  return lines
    .map((l) => l.slice(indent).trimEnd())
    .join('\n')
    .trim();
}

function describe(pkg) {
  const manifest = JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
  const files =
    pkg.licenseFiles ??
    readdirSync(pkg.dir)
      .filter((f) => /^(licen[cs]e|copying)/i.test(f))
      .sort();
  if (files.length === 0) throw new Error(`${pkg.name} ships no license file: read its terms and list it by hand.`);
  const license = files.map((f) => readLicense(path.join(pkg.dir, f))).join('\n\n');
  const spdx = manifest.license ?? UNNAMED_LICENSES[pkg.name];
  if (typeof spdx !== 'string')
    throw new Error(`${pkg.name} names no license in its manifest: read its license file and list it by hand.`);
  return { ...pkg, version: manifest.version, spdx, license };
}

function adaptedCode() {
  const sources = readdirSync(path.join(root, 'src'), { recursive: true })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => /\.(ts|css)$/.test(f))
    .map((f) => ({ file: `src/${f}`, text: readFileSync(path.join(root, 'src', f), 'utf8') }));
  return ADAPTED.map(({ mark, text }) => {
    const files = sources.filter((s) => s.text.includes(mark)).map((s) => `\`${s.file}\``);
    if (files.length === 0) throw new Error(`No file under src/ mentions "${mark}": update ADAPTED in this script.`);
    return `- ${files.join(', ')}: ${text}`;
  });
}

function render(packages) {
  const groups = new Map();
  for (const pkg of packages) groups.set(pkg.license, [...(groups.get(pkg.license) ?? []), pkg]);
  const out = [
    '# Third-party notices',
    '',
    "Tandem Markdown's production build contains code from the packages below: the extension host bundle " +
      '(`dist/host/extension.js`) and the panel bundle (`dist/panel/`, the page inside the editor tab, with ' +
      'the code-block languages it loads when a block first names one and the libraries it loads when a file ' +
      'first needs them), and the diagram frame (`dist/panel/diagram-frame.js`, Mermaid and what drives it, ' +
      'which the panel hands to the frame it draws diagrams in). Each license text follows as its package ships it.',
    '',
    'This file is generated by `scripts/third-party.mjs` (`npm run notices`). Change the script, not this file.',
    '',
    '## Packages',
    '',
    '| Package | Version | License | In |',
    '|---|---|---|---|',
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.spdx} | ${p.bundle} |`),
    '',
    "## Code adapted into Tandem Markdown's own files",
    '',
    ...adaptedCode(),
    '',
    '## License texts',
  ];
  for (const [license, members] of groups) {
    out.push('', `### ${members.map((p) => p.name).join(', ')}`, '');
    for (const p of members.filter((m) => m.note)) out.push(p.note, '');
    out.push('```text', license, '```');
  }
  return out.join('\n') + '\n';
}

/** The bundled packages and the copied ones; a package that is both is listed once, with both places. */
function allPackages(bundled) {
  const out = [...bundled];
  for (const copied of COPIED) {
    const dir = path.join(root, 'node_modules', copied.name);
    const same = out.find((p) => p.dir === dir);
    if (same) Object.assign(same, { ...copied, bundle: `${same.bundle}; ${copied.bundle}` });
    else out.push({ ...copied, dir });
  }
  return out;
}

const packages = allPackages(await bundledPackages())
  .map(describe)
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
const text = render(packages);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // A missing file is stale.
  }
  if (current !== text) {
    console.error('THIRD_PARTY_NOTICES.md is out of date: run npm run notices.');
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
  console.log(`Wrote THIRD_PARTY_NOTICES.md: ${packages.length} packages.`);
}
