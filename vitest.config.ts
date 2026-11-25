import { defineConfig } from 'vitest/config';

// Unit tests run in plain Node. Nothing under test/ may need a browser or VS Code:
// code that needs either is tested in itest/ (inside VS Code) or through harness/ (in Chrome).
//
// Two projects, by home (CONTRIBUTING.md, "Where each check runs"). `core` runs on every
// commit: the document core and the simulation, the host's modules, and the panel's code that
// writes to the document or decides what reaches it (commands, paste, replace, table edits,
// ranges from the host, typing pushed before a close or a command key, the editor state's text,
// what HTML may reach the page), with the checks that keep the settings and SYNTAX.md in
// step. `panel` runs when the panel changes: how markdown is read and drawn,
// which a person using the editor sees at once. `npm test` runs both.

/** The panel's unit tests that are core: each guards text written to the document or what reaches the page. */
const PANEL_CORE = [
  'test/panel/commands/blocks.test.ts',
  'test/panel/commands/inline.test.ts',
  'test/panel/commands/lists.test.ts',
  'test/panel/commands/typing.test.ts',
  'test/panel/paste/**/*.test.ts',
  'test/panel/ui/search.test.ts',
  'test/panel/ui/reveal.test.ts',
  'test/panel/tables/commands.test.ts',
  'test/panel/tables/edits.test.ts',
  'test/panel/focus.test.ts',
  'test/panel/hostRanges.test.ts',
  'test/panel/reports.test.ts',
  'test/panel/ui/keys.test.ts',
  'test/panel/render/framework.test.ts',
  'test/panel/html/addresses.test.ts',
  'test/panel/html/renameInline.test.ts',
  'test/panel/syntax/reference.test.ts',
  'test/panel/syntax/table.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          include: ['test/core/**/*.test.ts', 'test/sync/**/*.test.ts', 'test/host/**/*.test.ts', ...PANEL_CORE],
        },
      },
      {
        extends: true,
        test: { name: 'panel', include: ['test/panel/**/*.test.ts'], exclude: PANEL_CORE },
      },
    ],
  },
});
