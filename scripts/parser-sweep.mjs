// The parser sweep: reads every *.md under a folder, read-only, and checks for each file:
//   (a) loading its LF text into an EditorState and reading it back gives the same text;
//   (b) building every drawing feature's decorations, in Rich view and in Rich editor, throws
//       nothing and switches no feature off;
//   (c) our parser and markdown-it (tables and strikethrough on, HTML on) agree, line by line,
//       on which lines are headings and at what level, list items, quote lines, fenced code,
//       tables and rules.
//
//   node scripts/parser-sweep.mjs <root> [--out <folder>]
//
// Writes report.md and sweep.log into the out folder (default: tandem-markdown-sweep in the system's
// temporary folder), where the panel code is also bundled to be loaded. Writes nothing elsewhere.

import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import MarkdownIt from 'markdown-it';
import { errorMessage } from '../harness/checks.mjs';

const repo = path.join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const root = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const outFlag = args.indexOf('--out');
const out = outFlag >= 0 ? args[outFlag + 1] : path.join(os.tmpdir(), 'tandem-markdown-sweep');
if (!root) {
  console.error('Give the folder to sweep: node scripts/parser-sweep.mjs <root>');
  process.exit(1);
}
const rootAbs = path.resolve(root);
const outAbs = path.resolve(out);
if (outAbs === rootAbs || outAbs.startsWith(rootAbs + path.sep)) {
  console.error('The out folder must not be inside the folder being swept.');
  process.exit(1);
}
await mkdir(outAbs, { recursive: true });
const logFile = path.join(outAbs, 'sweep.log');
await writeFile(logFile, `Sweep of ${rootAbs} started ${new Date().toISOString()}\n`);
const log = (line) => appendFile(logFile, line + '\n');

// ---------------------------------------------------------------------------
// Bundle the panel code this needs

const entry = `
export { EditorState } from '@codemirror/state';
export { SETTING_DEFAULTS } from './src/core/protocol';
export { syntaxTree } from '@codemirror/language';
export { createEditorState } from './src/panel/editor';
export { withFullTree } from './src/panel/render/framework';
export { drawHeadless } from './test/panel/headless';
export { faultedFeatures } from './src/panel/render/faults';
`;
const bundlePath = path.join(outAbs, 'sweep-bundle.mjs');
await esbuild.build({
  stdin: { contents: entry, resolveDir: repo, loader: 'ts', sourcefile: 'sweep-entry.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
  logLevel: 'error',
  // The yaml package (frontmatter drawing) calls require() for a Node built-in, which an ES
  // module bundle does not have. Give the bundle one.
  banner: {
    js: "import { createRequire as __rmCreateRequire } from 'node:module'; const require = __rmCreateRequire(import.meta.url);",
  },
});
const panel = await import(pathToFileURL(bundlePath).href);

// ---------------------------------------------------------------------------
// Files

async function markdownFiles(dir, found = []) {
  for (const entryInfo of await readdir(dir, { withFileTypes: true })) {
    if (entryInfo.name.startsWith('.') || entryInfo.name === 'node_modules') continue;
    const full = path.join(dir, entryInfo.name);
    if (entryInfo.isDirectory()) await markdownFiles(full, found);
    else if (entryInfo.isFile() && entryInfo.name.toLowerCase().endsWith('.md')) found.push(full);
  }
  return found;
}

// ---------------------------------------------------------------------------
// A panel context with no host

const settings = { ...panel.SETTING_DEFAULTS, maxRichFileSizeKb: 1_000_000, workspaceTrusted: true };

function context(fileName) {
  const errors = [];
  const ctx = {
    bridge: { post() {}, onMessage: () => () => {}, getState: () => undefined, setState() {} },
    doc: { uri: `file:///${fileName}`, fileName, workspacePath: fileName, readOnly: false },
    slots: {},
    settings,
    onSettingsChange: () => () => {},
    request: () => Promise.reject(new Error('No host')),
    notify() {},
    log(level, message, detail) {
      if (level === 'error') errors.push(`${message}: ${errorMessage(detail)}`);
    },
    view() {
      throw new Error('No view');
    },
  };
  return { ctx, errors };
}

// ---------------------------------------------------------------------------
// Block classification, line by line

const KINDS = ['heading', 'listItem', 'quote', 'fence', 'table', 'rule'];

function emptyClasses(lineCount) {
  return {
    heading: new Uint8Array(lineCount),
    listItem: new Uint8Array(lineCount),
    quote: new Uint8Array(lineCount),
    fence: new Uint8Array(lineCount),
    table: new Uint8Array(lineCount),
    rule: new Uint8Array(lineCount),
  };
}

const HEADING = /^(?:ATXHeading|SetextHeading)(\d)$/;

/** Ours, from the syntax tree. Line numbers are 0-based here. Also returns the front matter's line count. */
function ours(state) {
  const doc = state.doc;
  const c = emptyClasses(doc.lines);
  const line = (pos) => doc.lineAt(pos).number - 1;
  const mark = (array, from, to, value = 1) => {
    for (let n = line(from); n <= line(to); n++) array[n] = value;
  };
  let frontmatterLines = 0;
  panel.syntaxTree(state).iterate({
    enter(node) {
      const name = node.name;
      const h = HEADING.exec(name);
      if (h) mark(c.heading, node.from, node.to, Number(h[1]));
      else if (name === 'ListItem') c.listItem[line(node.from)] = 1;
      else if (name === 'Blockquote') mark(c.quote, node.from, node.to);
      else if (name === 'FencedCode') mark(c.fence, node.from, node.to);
      else if (name === 'Table') mark(c.table, node.from, node.to);
      else if (name === 'HorizontalRule') c.rule[line(node.from)] = 1;
      else if (name === 'Frontmatter') frontmatterLines = line(node.to) + 1;
      // Leaf blocks hold no blocks; code and HTML hold nested-language trees not worth walking.
      return !(
        name === 'Paragraph' ||
        name === 'FencedCode' ||
        name === 'CodeBlock' ||
        name === 'HTMLBlock' ||
        name === 'CommentBlock' ||
        name === 'Frontmatter' ||
        name === 'Table' ||
        HEADING.test(name)
      );
    },
  });
  return { classes: c, frontmatterLines };
}

const md = new MarkdownIt({ html: true });

/** markdown-it's view of the same lines. */
function theirs(text, lineCount) {
  const c = emptyClasses(lineCount);
  const mark = (array, map, value = 1) => {
    for (let n = map[0]; n < map[1] && n < lineCount; n++) array[n] = value;
  };
  for (const token of md.parse(text, {})) {
    if (!token.map) continue;
    switch (token.type) {
      case 'heading_open':
        mark(c.heading, token.map, Number(token.tag.slice(1)));
        break;
      case 'list_item_open':
        c.listItem[token.map[0]] = 1;
        break;
      case 'blockquote_open':
        mark(c.quote, token.map);
        break;
      case 'fence':
        mark(c.fence, token.map);
        break;
      case 'table_open':
        mark(c.table, token.map);
        break;
      case 'hr':
        c.rule[token.map[0]] = 1;
        break;
    }
  }
  return c;
}

/** markdown-it ends a block's map at the last line it consumed, which can be a trailing blank line; ours ends at the content. */
function isBlank(text) {
  return /^\s*$/.test(text);
}

// ---------------------------------------------------------------------------
// The sweep

const files = (await markdownFiles(rootAbs)).sort();
await log(`${files.length} markdown files`);

const totals = {
  files: files.length,
  lines: 0,
  bytes: 0,
  roundTripFailures: 0,
  drawFailures: 0,
  filesWithDisagreement: 0,
};
const roundTrip = [];
const drawProblems = [];
const disagreements = Object.fromEntries(KINDS.map((k) => [k, { lines: 0, files: new Set(), examples: [] }]));
const found = Object.fromEntries(KINDS.map((k) => [k, { ours: 0, theirs: 0 }]));
const slowest = [];
const started = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const rel = path.relative(rootAbs, file);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    drawProblems.push({ file: rel, problem: `could not be read: ${error.message}` });
    continue;
  }
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
  totals.bytes += Buffer.byteLength(text);

  const t0 = performance.now();
  let parsed;
  let fileHasDisagreement = false;
  try {
    for (const mode of ['view', 'edit']) {
      const { ctx, errors } = context(rel);
      const state = panel.withFullTree(panel.createEditorState({ ctx, text, mode }), 30_000);
      if (state.doc.toString() !== text) {
        totals.roundTripFailures++;
        roundTrip.push(`${rel} (${mode})`);
      }
      const drawn = panel.drawHeadless(state);
      const off = panel.faultedFeatures(ctx);
      if (off.length || errors.length) {
        totals.drawFailures++;
        drawProblems.push({
          file: rel,
          problem: `${mode}: ${[...off.map((f) => `${f} switched off`), ...errors].join('; ')}`,
        });
      }
      if (drawn.length === 0) drawProblems.push({ file: rel, problem: `${mode}: no feature drew anything` });
      parsed ??= state;
    }
  } catch (error) {
    totals.drawFailures++;
    drawProblems.push({ file: rel, problem: `threw: ${error.stack ?? error}` });
    continue;
  }
  const ms = performance.now() - t0;
  slowest.push({ file: rel, ms, bytes: Buffer.byteLength(text) });
  slowest.sort((a, b) => b.ms - a.ms);
  slowest.length = Math.min(slowest.length, 10);

  const lineCount = parsed.doc.lines;
  totals.lines += lineCount;
  const { classes: a, frontmatterLines } = ours(parsed);
  // markdown-it knows no front matter: give it the same lines, blanked.
  const lines = text.split('\n');
  const forIt = lines.map((l, n) => (n < frontmatterLines ? '' : l)).join('\n');
  const b = theirs(forIt, lineCount);
  // After a final line break the editor has one more, empty, line, which markdown-it does
  // not count; an unclosed fence or quote reaches it in ours only.
  const compared = text.endsWith('\n') ? lineCount - 1 : lineCount;
  for (const kind of KINDS) {
    const d = disagreements[kind];
    for (let n = frontmatterLines; n < compared; n++) {
      if (a[kind][n]) found[kind].ours++;
      if (b[kind][n]) found[kind].theirs++;
      if (a[kind][n] === b[kind][n]) continue;
      // A trailing blank line inside markdown-it's map, outside ours, is not a disagreement about the content.
      if ((kind === 'quote' || kind === 'table' || kind === 'heading') && isBlank(lines[n] ?? '')) continue;
      d.lines++;
      d.files.add(rel);
      fileHasDisagreement = true;
      if (d.examples.length < 20) {
        const ourView =
          kind === 'heading' ? (a[kind][n] ? `h${a[kind][n]}` : 'not a heading') : a[kind][n] ? kind : `not ${kind}`;
        const itsView =
          kind === 'heading' ? (b[kind][n] ? `h${b[kind][n]}` : 'not a heading') : b[kind][n] ? kind : `not ${kind}`;
        const context = lines
          .slice(Math.max(0, n - 2), n + 3)
          .map((l, k) => `${Math.max(0, n - 2) + k + 1 === n + 1 ? '>' : ' '} ${l}`);
        d.examples.push({ file: rel, line: n + 1, text: lines[n], ours: ourView, theirs: itsView, context });
      }
    }
  }
  if (fileHasDisagreement) totals.filesWithDisagreement++;
  if ((i + 1) % 200 === 0)
    await log(`${i + 1} of ${files.length} files, ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
await log(`Done in ${seconds} s`);

// ---------------------------------------------------------------------------
// Report

const label = {
  heading: 'Headings (and their level)',
  listItem: 'List items (the line an item starts on)',
  quote: 'Quote lines',
  fence: 'Fenced code lines',
  table: 'Table lines',
  rule: 'Horizontal rules',
};
const fence = (s) => s.replace(/`/g, '\u02cb');
let report = `# Parser sweep\n\nRoot: \`${rootAbs}\`. Run ${new Date().toISOString()}, ${seconds} s.\n\n`;
report += `## Totals\n\n| | |\n|---|---|\n`;
report += `| Files | ${totals.files} |\n| Lines | ${totals.lines} |\n| Text (LF, bytes) | ${totals.bytes} |\n`;
report += `| (a) Round trip failures | ${totals.roundTripFailures} |\n| (b) Drawing failures | ${totals.drawFailures} |\n`;
report += `| (c) Files with a block-level disagreement | ${totals.filesWithDisagreement} |\n\n`;
report += `## (c) Disagreements with markdown-it by kind\n\n| Kind | Lines found (ours) | Lines found (markdown-it) | Lines that disagree | Files |\n|---|---|---|---|---|\n`;
for (const kind of KINDS) {
  report += `| ${label[kind]} | ${found[kind].ours} | ${found[kind].theirs} | ${disagreements[kind].lines} | ${disagreements[kind].files.size} |\n`;
}
report += `\nFrontmatter lines are left out: markdown-it is given them blank. A blank line that only markdown-it counts inside a quote, table or heading is not counted, nor the empty line after a file's final line break, which markdown-it does not count as a line.\n`;
for (const kind of KINDS) {
  const d = disagreements[kind];
  if (!d.examples.length) continue;
  report += `\n### ${label[kind]}: the first ${d.examples.length}\n`;
  for (const e of d.examples) {
    report += `\n- \`${fence(e.file)}\` line ${e.line}: ours says ${e.ours}, markdown-it says ${e.theirs}\n\n  \`\`\`\n${e.context.map((l) => `  ${l}`).join('\n')}\n  \`\`\`\n`;
  }
}
report += `\n## (a) Round trip failures\n\n${roundTrip.length ? roundTrip.map((f) => `- ${f}`).join('\n') : 'None.'}\n`;
report += `\n## (b) Drawing failures\n\n${
  drawProblems.length
    ? drawProblems
        .slice(0, 50)
        .map((p) => `- \`${fence(p.file)}\`: ${p.problem}`)
        .join('\n')
    : 'None.'
}\n`;
report += `\n## Slowest files (parse to the end, plus drawing in both modes)\n\n| File | ms | bytes |\n|---|---|---|\n`;
for (const s of slowest) report += `| \`${fence(s.file)}\` | ${s.ms.toFixed(0)} | ${s.bytes} |\n`;
await writeFile(path.join(outAbs, 'report.md'), report);
console.log(`Swept ${totals.files} files in ${seconds} s. Report: ${path.join(outAbs, 'report.md')}`);
