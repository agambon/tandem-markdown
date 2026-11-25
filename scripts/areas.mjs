// Which browser specs, and whether the panel's unit tests and the in-VS-Code suite, a change needs,
// by the files it touches: the "area" home of CONTRIBUTING.md ("Where each check runs"), whose
// table says the same in words. .github/workflows/area.yml asks this script.
//
//   node scripts/areas.mjs                   what the changes since main need (committed or not)
//   node scripts/areas.mjs <base> [<head>]   what the changes between two commits need
//   node scripts/areas.mjs --run [<base>]    runs those specs, one after another
//   node scripts/areas.mjs --all             every spec and the in-VS-Code suite, as a release runs them
//   --github                                 prints `specs=[...]`, `unit=` and `itest=true|false`, for $GITHUB_OUTPUT
//
// A path ending in / names a folder and everything in it, one ending in /* the files directly in a
// folder, and any other path one file.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.join(import.meta.dirname, '..');

/** A change here can move what every spec and the in-VS-Code suite see: the build, the dependencies. */
const EVERYTHING = ['package.json', 'package-lock.json', 'esbuild.mjs', 'tsconfig.json', 'scripts/areas.mjs'];

/** What every spec shares: the checks, the pages' openers and the server, and the panel's own frame of files. */
const EVERY_SPEC = [
  'harness/checks.mjs',
  'harness/pages.mjs',
  'harness/serve.mjs',
  'src/panel/*',
  'src/panel/render/framework.ts',
  'src/panel/render/lines.ts',
  'src/panel/render/damage.ts',
  'src/panel/render/faults.ts',
  'src/panel/theme/',
  'src/core/protocol.ts',
  'src/core/featureProtocol.ts',
];

/** The render lab, which most drawing specs drive. */
const LAB = [
  'harness/lab.ts',
  'harness/lab.html',
  'harness/fakes/notes.ts',
  'harness/fakes/workspace.ts',
  'harness/barSelect.ts',
  'harness/sampleList.ts',
  'harness/theme.ts',
  'harness/themes/themes.json',
];

/** The two-sided harness page: the panel against the real core through the fake host. */
const HARNESS_PAGE = [
  'harness/harness.ts',
  'harness/index.html',
  'harness/fakeHost.ts',
  'harness/fakes/',
  'harness/barSelect.ts',
  'harness/sampleList.ts',
  'harness/theme.ts',
  'harness/themes/themes.json',
];

/** The document core, the panel's side of sync and their stand-ins: what keeps the text. */
const DOCUMENT = [
  'src/core/alignDiff.ts',
  'src/core/coordinator.ts',
  'src/core/diff.ts',
  'src/core/documentGate.ts',
  'src/core/encoding.ts',
  'src/core/eol.ts',
  'src/core/errors.ts',
  'src/core/hash.ts',
  'src/core/merge3.ts',
  'src/core/noticeText.ts',
  'src/core/positions.ts',
  'src/core/reconcile/',
  'src/core/safeMerge.ts',
  'src/core/sequenceDiff.ts',
  'src/core/session.ts',
  'src/core/textLines.ts',
  'src/core/wordChars.ts',
  'test/sync/world.ts',
  'test/sync/fakes/',
];

/** What reads and draws markdown: a change here can change any drawing. */
const DRAWING = [
  'src/panel/markdown/',
  'src/panel/syntax/',
  'src/panel/render/',
  'src/panel/html/',
  'src/panel/links/',
  'src/panel/tables/',
  'src/core/attributes.ts',
  'src/core/blockId.ts',
  'src/core/emojiCodes.ts',
  'src/core/fileKinds.ts',
  'src/core/formulas.ts',
  'src/core/frontmatter.ts',
  'src/core/htmlElements.ts',
  'src/core/markdownText.ts',
  'src/core/outline.ts',
  'src/core/plainText.ts',
  'src/core/tableModel.ts',
  'src/core/wikilinks.ts',
  'src/core/wordChars.ts',
  'src/core/words.ts',
];

/** Each browser spec in harness/tests/, with the files whose promises it checks (its own file aside). */
const SPECS = {
  attacks: [...LAB, ...DRAWING, 'harness/attacks/', 'harness/pictures.mjs', 'src/host/provider.ts'],
  drawn: [
    ...LAB,
    ...HARNESS_PAGE,
    'src/panel/markdown/',
    'src/panel/render/contents.ts',
    'src/panel/render/follow.ts',
    'src/panel/render/blockIds.ts',
    'src/panel/render/conflicts.ts',
    'src/panel/render/diagramFrame.ts',
    'src/panel/render/diagramProtocol.ts',
    'src/panel/render/diagrams.ts',
    'src/panel/render/drawnBlock.ts',
    'src/panel/render/embeds.ts',
    'src/panel/render/frame/',
    'src/panel/ui/diagramView.ts',
    'src/core/blockId.ts',
    'src/core/outline.ts',
    'src/host/model/',
    'src/host/provider.ts',
    'harness/pictures.mjs',
    'harness/samples/syntax-drawn.md',
    'src/panel/syntax/kinds.ts',
  ],
  editing: [
    ...LAB,
    ...HARNESS_PAGE,
    ...DOCUMENT,
    'src/panel/commands/',
    'src/panel/ui/',
    'src/panel/markdown/tree.ts',
    'src/panel/markdown/writing.ts',
    'harness/samples/editing.md',
  ],
  'find-paste': [
    ...LAB,
    'src/panel/paste/',
    'src/panel/ui/',
    'src/panel/markdown/writing.ts',
    'src/panel/commands/placeBlock.ts',
    'src/panel/commands/lineInfo.ts',
    'src/core/listText.ts',
    'test/panel/paste/fixtures/',
  ],
  html: [
    ...LAB,
    'src/panel/html/',
    'src/panel/markdown/',
    'src/panel/render/html.ts',
    'src/panel/render/htmlBlocks.ts',
    'src/panel/render/htmlDrawing.ts',
    'src/panel/render/follow.ts',
    'src/panel/render/images.ts',
    'src/panel/render/drawnBlock.ts',
    'src/panel/render/frame/',
    'src/core/htmlElements.ts',
    'src/core/fileKinds.ts',
    'src/host/model/linkAddress.ts',
    'src/panel/syntax/kinds.ts',
  ],
  messages: [...HARNESS_PAGE],
  links: [
    ...HARNESS_PAGE,
    'src/panel/links/',
    'src/panel/complete/',
    'src/panel/ui/',
    'src/panel/render/links.ts',
    'src/panel/render/follow.ts',
    'src/panel/render/wikilinks.ts',
    'src/panel/render/images.ts',
    'src/panel/render/lists.ts',
    'src/panel/markdown/',
    'src/core/fileKinds.ts',
    'src/core/wikilinks.ts',
    'src/core/outline.ts',
    'src/host/model/',
    'harness/samples/links.md',
  ],
  outsideMark: [
    ...HARNESS_PAGE,
    ...DOCUMENT,
    'src/panel/render/outsideMark.ts',
    'src/panel/announce/',
    'src/core/fill.ts',
    'src/core/listText.ts',
  ],
  render: [...LAB, ...DRAWING, 'harness/samples/everything.md', 'harness/samples/editing.md'],
  sync: [...HARNESS_PAGE, ...DOCUMENT],
  syntax: [...LAB, ...DRAWING, 'test/panel/syntax/cases/', 'harness/samples/syntax.md'],
  tables: [
    ...LAB,
    'src/panel/tables/',
    'src/panel/markdown/',
    'src/panel/commands/placeBlock.ts',
    'src/panel/commands/lineInfo.ts',
    'src/panel/render/frontmatter.ts',
    'src/panel/render/frontmatterLinks.ts',
    'src/panel/render/follow.ts',
    'src/panel/render/gridTables.ts',
    'src/panel/render/toml.ts',
    'src/core/frontmatter.ts',
    'src/core/tableModel.ts',
    'harness/samples/tables.md',
    'src/panel/syntax/kinds.ts',
  ],
  vscode: [
    ...HARNESS_PAGE,
    'src/panel/complete/',
    'src/panel/ui/',
    'src/panel/render/changeMarks.ts',
    'src/panel/render/diagnostics.ts',
    'src/host/model/',
    'harness/samples/vscode.md',
  ],
};

/** What the panel's unit tests (vitest's `panel` project) read: the panel, and the core it reads with. */
const PANEL_UNIT = ['src/panel/', 'src/core/', 'test/panel/', 'vitest.config.ts'];

/** What the in-VS-Code suite checks: the host, the core, the contributions, and the suite itself. */
const ITEST = [
  'src/host/',
  'src/core/',
  'src/panel/sync.ts',
  'src/panel/testHook.ts',
  'src/panel/vscodeBridge.ts',
  'itest/',
];

/** Whether `file` (a path from the repository's root, with forward slashes) is named by `paths`. */
function named(paths, file) {
  return paths.some((p) => {
    if (p.endsWith('/*')) return file.startsWith(p.slice(0, -1)) && !file.slice(p.length - 1).includes('/');
    return p.endsWith('/') ? file.startsWith(p) : file === p;
  });
}

/** The specs, and whether the panel's unit tests and the in-VS-Code suite, the changed `files` need. */
export function checksFor(files) {
  const all = files.some((f) => named(EVERYTHING, f));
  const specs = Object.keys(SPECS).filter(
    (spec) =>
      all || files.some((f) => f === `harness/tests/${spec}.spec.mjs` || named(EVERY_SPEC, f) || named(SPECS[spec], f)),
  );
  return {
    specs,
    unit: all || files.some((f) => named(PANEL_UNIT, f)),
    itest: all || files.some((f) => named(ITEST, f)),
  };
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The files changed between `base` and `head`, or, with no `head`, between `base` and the working tree. */
function changedFiles(base, head) {
  const lines = head
    ? git('diff', '--name-only', `${base}...${head}`)
    : git('diff', '--name-only', git('merge-base', base, 'HEAD').trim()) +
      git('ls-files', '--others', '--exclude-standard');
  return [...new Set(lines.split('\n').filter(Boolean))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const github = args.includes('--github');
  const run = args.includes('--run');
  const [base = 'main', head] = args.filter((a) => !a.startsWith('--'));
  const known = readdirSync(path.join(root, 'harness', 'tests'))
    .filter((n) => n.endsWith('.spec.mjs'))
    .map((n) => n.slice(0, -'.spec.mjs'.length));
  const unlisted = known.filter((spec) => !(spec in SPECS));
  if (unlisted.length) {
    console.error(`scripts/areas.mjs has no entry for ${unlisted.join(', ')}: add one to SPECS.`);
    process.exit(2);
  }
  const listed = [EVERYTHING, EVERY_SPEC, PANEL_UNIT, ITEST, ...Object.values(SPECS)].flat();
  const missing = [...new Set(listed)].filter((p) => !existsSync(path.join(root, p.replace(/\/\*$/, '/'))));
  if (missing.length) {
    console.error(`scripts/areas.mjs names what is not there: ${missing.join(', ')}.`);
    process.exit(2);
  }
  let files = EVERYTHING;
  if (!args.includes('--all')) {
    try {
      files = changedFiles(base, head);
    } catch {
      // A branch's first push, for example: GitHub names no commit before it.
      console.error(`git cannot compare ${base} with ${head ?? 'the working tree'}: every check is chosen.`);
    }
  }
  const { specs, unit, itest } = checksFor(files);
  if (github) {
    console.log(`specs=${JSON.stringify(specs)}`);
    console.log(`unit=${unit}`);
    console.log(`itest=${itest}`);
  } else if (run) {
    let failed = 0;
    if (unit) {
      console.log("\n== the panel's unit tests");
      const result = spawnSync('npx vitest run --project panel', { cwd: root, stdio: 'inherit', shell: true });
      if (result.status !== 0) failed++;
    }
    for (const spec of specs) {
      console.log(`\n== ${spec}`);
      const result = spawnSync(process.execPath, [path.join('harness', 'tests', `${spec}.spec.mjs`)], {
        cwd: root,
        stdio: 'inherit',
      });
      if (result.status !== 0) failed++;
    }
    const ran = specs.length + (unit ? 1 : 0);
    console.log(`\n${ran - failed} of ${ran} passed${itest ? '; the change also needs npm run itest' : ''}`);
    process.exit(failed ? 1 : 0);
  } else {
    console.log(unit ? "The panel's unit tests: yes (npm run test:panel)" : "The panel's unit tests: no");
    console.log(specs.length ? `Browser specs: ${specs.join(', ')}` : 'No browser spec covers these changes.');
    console.log(itest ? 'The in-VS-Code suite: yes (npm run itest)' : 'The in-VS-Code suite: no');
  }
}
