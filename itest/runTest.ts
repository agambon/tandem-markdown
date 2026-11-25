// Starts a separate test copy of VS Code and runs the suite inside it.
//
//   npm run itest                    every file in itest/suite
//   npm run itest -- statusOutline   only the files whose names contain one of the words
//
// VSCODE_TEST_VERSION names the version (a number or `stable`; DEFAULT_VERSION when unset), which
// is downloaded once into .vscode-test. The copy loads no other extension but the test helper
// (itest/helper) and keeps its user data, extensions and workspace (a fresh copy of
// itest/fixtures) in the system's temporary folder, or in TM_ITEST_DIR when that is set. It opens
// a real window while it runs. TM_ITEST_EXTENSIONS, a comma-separated list of .vsix files or
// Marketplace ids, installs those into the copy's own extensions folder first, and the copy then
// starts with that folder's extensions enabled (the facts files need one: itest/suite/facts.ts).

import { cpSync, createWriteStream, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';
import { name, publisher } from '../package.json';

const DEFAULT_VERSION = '1.146.0';
// Read before main() clears every VSCODE_* variable.
const VERSION = process.env.VSCODE_TEST_VERSION || DEFAULT_VERSION;
const INSTALL = (process.env.TM_ITEST_EXTENSIONS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

/** On Windows the copy's command line runs through the shell, which splits an argument at a space. */
const forCommandLine = (arg: string) => (process.platform === 'win32' && /\s/.test(arg) ? `"${arg}"` : arg);

async function main(): Promise<number> {
  // A terminal inside a running VS Code inherits ELECTRON_RUN_AS_NODE and VSCODE_* variables.
  // With them the test copy starts as plain Node, or talks to the running VS Code.
  for (const variable of Object.keys(process.env)) {
    if (variable === 'ELECTRON_RUN_AS_NODE' || variable.startsWith('VSCODE_')) delete process.env[variable];
  }

  const repo = path.resolve(__dirname, '..', '..');
  const requested = process.env.TM_ITEST_DIR || path.join(os.tmpdir(), `${name}-itest`);
  mkdirSync(requested, { recursive: true });
  // The real path (no 8.3 short names, no symbolic links), as VS Code reports its folders.
  const root = realpathSync.native(requested);
  const workspace = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  const extensions = path.join(root, 'extensions');
  for (const dir of [workspace, userData]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(extensions, { recursive: true });
  cpSync(path.join(repo, 'itest', 'fixtures'), workspace, { recursive: true });
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'window.restoreWindows': 'none',
        'workbench.startupEditor': 'none',
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.tips.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'security.workspace.trust.enabled': false,
        'git.enabled': false,
      },
      null,
      2,
    ),
  );

  // Everything the run prints also goes to a log file, so it can be read while it runs.
  const logFile = path.join(root, 'last-run.log');
  const logStream = createWriteStream(logFile);
  const tee = (target: NodeJS.WriteStream) =>
    new Writable({
      write(chunk, _encoding, done) {
        target.write(chunk);
        logStream.write(chunk, done);
      },
    });
  console.log(`In-VS-Code suite: VS Code ${VERSION}, workspace ${workspace}, log ${logFile}`);

  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  try {
    for (const extension of INSTALL) {
      console.log(`Installing ${extension} into ${extensions}`);
      // The copy's command line, run as a program with no window: it installs and exits.
      const { stdout } = await runVSCodeCommand(
        [
          '--install-extension',
          forCommandLine(extension),
          '--force',
          `--extensions-dir=${forCommandLine(extensions)}`,
          `--user-data-dir=${forCommandLine(userData)}`,
        ],
        { version: VERSION, cachePath: path.join(repo, '.vscode-test') },
      );
      console.log(stdout.trim());
    }
    return await runTests({
      version: VERSION,
      cachePath: path.join(repo, '.vscode-test'),
      // This extension, and beside it the helper that reports problems as a spell checker does.
      extensionDevelopmentPath: [repo, path.join(repo, 'out', 'itest', 'helper')],
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        workspace,
        // Only the copy's own extensions folder is read, which holds what TM_ITEST_EXTENSIONS installed.
        ...(INSTALL.length > 0 ? [] : ['--disable-extensions']),
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--new-window',
        // Headless Windows and macOS CI runners can mark the test window occluded and throttle
        // requestAnimationFrame / timers inside webviews, stalling CodeMirror layout measurements.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        // The reconciler's every decision goes to the Tandem Markdown log at trace level.
        `--log=${publisher}.${name}:trace`,
      ],
      extensionTestsEnv: {
        TM_ITEST_ONLY: only.join(','),
        TM_ITEST_WORKSPACE: workspace,
        TM_ITEST_USER_DATA: userData,
      },
      stdout: tee(process.stdout),
      stderr: tee(process.stderr),
    });
  } finally {
    logStream.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
