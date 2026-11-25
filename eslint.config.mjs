import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const LAYERS = [
  'The core imports neither VS Code nor the host or the panel.',
  'The host and the panel import the core, not each other.',
  'src/host/model does not import VS Code. Nothing in src imports test code.',
].join(' ');

/** Forbids importing the named packages, and any path through the named folders; `more` adds paths with their own messages. */
function forbid(packages, folders, more = []) {
  return [
    'error',
    {
      paths: [...packages.map((name) => ({ name, message: LAYERS })), ...more],
      patterns: folders.length ? [{ regex: `(^|/)(${folders.join('|')})(/|$)`, message: LAYERS }] : [],
    },
  ];
}

const OUTSIDE_SRC = ['test', 'harness', 'itest'];

/** The one file through which HTML from a document reaches the panel's page. */
const DOOR = 'src/panel/html/door.ts';
const THROUGH_THE_DOOR = `HTML from a document reaches the page only through ${DOOR}.`;

/** What builds the page from markup, which the panel never does. */
function noMarkup({ srcdoc = true } = {}) {
  return [
    'error',
    {
      selector: `AssignmentExpression[left.property.name=/^(innerHTML|outerHTML${srcdoc ? '|srcdoc' : ''})$/]`,
      message: `Build elements with the DOM; never assign markup. ${THROUGH_THE_DOOR}`,
    },
    {
      selector: 'CallExpression[callee.property.name=/^(insertAdjacentHTML|createContextualFragment)$/]',
      message: `Build elements with the DOM; never insert markup. ${THROUGH_THE_DOOR}`,
    },
    {
      selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
      message: `Build elements with the DOM; never write markup. ${THROUGH_THE_DOOR}`,
    },
  ];
}

/** The diagram frame, whose document is the panel's own fixed markup and holds no text from a file. */
const DIAGRAM_FRAME = 'src/panel/render/diagramFrame.ts';

/** Where an import's path sorts: node's own modules, then packages, then parent folders, then the file's own. */
function importGroup(path) {
  if (path.startsWith('node:')) return 0;
  if (path.startsWith('../')) return 2;
  if (path.startsWith('./')) return 3;
  return 1;
}

/** True when the import of `path` belongs before the one of `previous`: by group, then by path, letter case ignored. */
function importsBefore(path, previous) {
  const group = importGroup(path) - importGroup(previous);
  return group < 0 || (group === 0 && path.toLowerCase() < previous.toLowerCase());
}

/** The repository's own rule for the order of a file's imports (`importsBefore`). */
const importOrder = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      order:
        "Import '{{path}}' before '{{previous}}': node's own modules, then packages, then '../' paths, then './' paths, each by path.",
    },
  },
  create(context) {
    return {
      Program(program) {
        let previous = null;
        for (const node of program.body) {
          if (node.type !== 'ImportDeclaration') continue;
          const path = node.source.value;
          if (previous !== null && importsBefore(path, previous))
            context.report({ node, messageId: 'order', data: { path, previous } });
          previous = path;
        }
      },
    };
  },
};

export default defineConfig(
  globalIgnores(['dist/', 'out/', '.vscode-test/', 'test/**/fixtures/', 'itest/fixtures/']),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
    },
  },
  {
    files: ['**/*.mjs'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
    },
  },
  {
    files: ['src/core/**'],
    rules: { 'no-restricted-imports': forbid(['vscode'], ['host', 'panel', ...OUTSIDE_SRC]), 'no-console': 'error' },
  },
  {
    files: ['src/host/**'],
    rules: { 'no-restricted-imports': forbid([], ['panel', ...OUTSIDE_SRC]), 'no-console': 'error' },
  },
  {
    files: ['src/host/model/**'],
    rules: { 'no-restricted-imports': forbid(['vscode'], ['panel', ...OUTSIDE_SRC]) },
  },
  {
    files: ['src/host/log.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/panel/**'],
    rules: {
      'no-restricted-imports': forbid(
        ['vscode'],
        ['host', ...OUTSIDE_SRC],
        [{ name: 'dompurify', message: THROUGH_THE_DOOR }],
      ),
      'no-restricted-syntax': noMarkup(),
    },
  },
  {
    files: [DOOR],
    rules: { 'no-restricted-imports': forbid(['vscode'], ['host', ...OUTSIDE_SRC]) },
  },
  {
    files: [DIAGRAM_FRAME],
    rules: { 'no-restricted-syntax': noMarkup({ srcdoc: false }) },
  },
  {
    files: [
      'src/core/**',
      'src/panel/**',
      'src/host/**',
      'test/core/**',
      'test/sync/**',
      'test/panel/**',
      'test/host/**',
      'harness/**',
      'itest/**',
      'scripts/**',
      'esbuild.mjs',
    ],
    plugins: { local: { rules: { 'import-order': importOrder } } },
    rules: { 'local/import-order': 'error' },
  },
);
