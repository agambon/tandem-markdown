// Writes SYNTAX.md, the syntax reference, from the code's own data: the table of optional syntax
// (src/panel/syntax/), the settings' descriptions in package.json, and the cases in
// test/panel/syntax/cases/ that carry a `reference` (its fields are described in that folder's
// foundation.json). Each example printed is a case's text, so the tests that run the cases
// prove it.
//
//   node scripts/syntax-reference.mjs           write the file
//   node scripts/syntax-reference.mjs --check   exit 1 if the file is not what the data gives
//
// The table is bundled in memory with esbuild, so the script reads exactly what the panel reads.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.join(import.meta.dirname, '..');
const target = path.join(root, 'SYNTAX.md');
const caseFolder = path.join(root, 'test', 'panel', 'syntax', 'cases');
const PREFIX = 'tandemMarkdown.syntax.';

/**
 * The groups of the reference, in the order a reader looks for them. An `alwaysOn` group's entries
 * need no setting line. A `noSetting` group's entries are not drawn as their syntax, so they name
 * no setting and are no setting's example (test/panel/syntax/reference.test.ts knows them too).
 */
const GROUPS = [
  {
    id: 'standard',
    heading: 'Standard markdown',
    intro: 'CommonMark, which every markdown program writes. It is always on.',
    alwaysOn: true,
  },
  {
    id: 'github',
    heading: 'GitHub',
    intro:
      'What GitHub adds to standard markdown. Its tables, task lists, strikethrough with two tildes and bare ' +
      'addresses are always on; each of its other additions has a setting.',
  },
  {
    id: 'notes',
    heading: 'Notes tools',
    intro: 'What Obsidian, Foam, Logseq, Bear, Dendron and other notes programs write.',
  },
  {
    id: 'documents',
    heading: 'Document tools and site builders',
    intro:
      'What Pandoc, Quarto, R Markdown, MkDocs, VitePress, Docusaurus, Hugo, kramdown, GitLab and Azure DevOps write.',
  },
  {
    id: 'html',
    heading: 'HTML',
    intro:
      'HTML is drawn as GitHub draws it, through the same list of allowed elements. In a workspace VS Code does not trust, it shows as typed.',
  },
  {
    id: 'math',
    heading: 'Math and diagrams',
    intro: 'Math is drawn by KaTeX and diagrams by Mermaid, each loaded the first time a file needs it.',
  },
  {
    id: 'git',
    heading: 'Git',
    intro: 'What git leaves in a file it could not merge.',
  },
  {
    id: 'typed',
    heading: 'Shown as typed',
    intro:
      'What other programs write that is not drawn. It shows exactly as typed, or as the plain link it holds, and can be edited as text.',
    noSetting: true,
  },
  {
    id: 'wrong',
    heading: 'Drawn wrongly',
    intro: 'What is read differently from the way the program that writes it means it.',
    noSetting: true,
  },
];

/** The table of optional syntax, as the panel builds it. */
async function syntaxTable() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'panel', 'syntax', 'index.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'error',
  });
  const code = Buffer.from(result.outputFiles[0].text).toString('base64');
  return (await import(`data:text/javascript;base64,${code}`)).SYNTAX;
}

/** Every case, in the order the tests read them. */
function readCases() {
  return readdirSync(caseFolder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => JSON.parse(readFileSync(path.join(caseFolder, name), 'utf8')).cases);
}

/** A heading's link address, as GitHub makes it from the heading's text. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** `a`, `a and b`, `a, b and c`. */
function listed(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** A code block holding `text` exactly, its fence longer than any run of backticks inside. */
function codeBlock(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}markdown`, text, fence];
}

/** The cases marked for the reference, each checked and given its group. */
function entriesOf(cases, table) {
  const groups = new Map(GROUPS.map((g) => [g.id, g]));
  return cases
    .filter((c) => c.reference)
    .map((c) => {
      const { group, title, becomes, writers } = c.reference;
      const where = `The case "${c.name}"`;
      if (!groups.has(group)) throw new Error(`${where} names no group of the reference: ${group}.`);
      if (typeof title !== 'string' || !title || /[`*_[\]<>#\\|]/.test(title))
        throw new Error(`${where} needs a title of plain words.`);
      if (typeof becomes !== 'string' || !becomes) throw new Error(`${where} needs what it becomes.`);
      if (writers !== undefined && !(Array.isArray(writers) && writers.every((w) => typeof w === 'string')))
        throw new Error(`${where} names its writers in a list.`);
      const syntax = c.syntax === null ? null : table.find((s) => s.id === c.syntax);
      if (syntax === undefined) throw new Error(`${where} names no syntax in the table: ${c.syntax}.`);
      return { case: c, group: groups.get(group), title, becomes, writers, syntax };
    });
}

/** The sentence naming the setting an entry is drawn under. */
function settingLine(entry) {
  const { syntax } = entry;
  if (syntax === null) return 'Always on.';
  const name = `[\`${PREFIX}${syntax.id}\`](#${slug(PREFIX + syntax.id)})`;
  if (!('choices' in syntax)) return `Setting: ${name}, ${syntax.default ? 'on' : 'off'} by default.`;
  const value = entry.case.value;
  return value === syntax.default
    ? `Setting: ${name} at \`${value}\`, the default.`
    : `Setting: ${name} set to \`${value}\`; the default is \`${syntax.default}\`.`;
}

function renderEntry(entry) {
  const facts = [];
  if (entry.writers?.length) facts.push(`Written by ${listed(entry.writers)}.`);
  if (!entry.group.noSetting && !entry.group.alwaysOn) facts.push(settingLine(entry));
  const out = ['', `### ${entry.title}`, '', ...codeBlock(entry.case.example), '', entry.becomes];
  if (facts.length) out.push('', facts.join(' '));
  return out;
}

function renderSetting(syntax, declared, entries) {
  const id = PREFIX + syntax.id;
  const setting = declared[id];
  if (!setting?.markdownDescription) throw new Error(`package.json declares no setting ${id} with a description.`);
  if ('choices' in syntax && setting.markdownEnumDescriptions?.length !== syntax.choices.length)
    throw new Error(`package.json does not describe each value of ${id}.`);
  const byDefault =
    'choices' in syntax ? `\`${syntax.default}\` by default.` : `${syntax.default ? 'On' : 'Off'} by default.`;
  const out = ['', `### \`${id}\``, '', `${byDefault} ${setting.markdownDescription}`];
  if ('choices' in syntax) {
    out.push('');
    syntax.choices.forEach((choice, i) => out.push(`- \`${choice.value}\`: ${setting.markdownEnumDescriptions[i]}`));
  }
  const examples = entries.filter((e) => e.syntax === syntax && !e.group.noSetting);
  if (examples.length === 0) throw new Error(`No case of ${syntax.id} is marked for the reference.`);
  out.push('', `Examples: ${examples.map((e) => `[${e.title}](#${slug(e.title)})`).join(', ')}.`);
  return out;
}

function render(table, cases, manifest) {
  const entries = entriesOf(cases, table);
  const byGroup = GROUPS.map((group) => ({
    group,
    entries: entries.filter((e) => e.group === group).sort((a, b) => a.title.localeCompare(b.title, 'en')),
  }));
  const ordered = byGroup.flatMap((g) => g.entries);

  const headings = ['Contents', ...GROUPS.map((g) => g.heading), ...ordered.map((e) => e.title), 'Settings'];
  const slugs = [...headings.map(slug), ...table.map((s) => slug(PREFIX + s.id))];
  const repeated = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (repeated) throw new Error(`Two headings link to #${repeated}: give one another title.`);

  const link = (text) => `[${text}](#${slug(text)})`;
  const out = [
    '# Syntax reference',
    '',
    'What Tandem Markdown draws: for each piece of syntax, what you type, what it becomes, which programs write it, ' +
      'and the setting that switches it. Anything not listed is read as standard markdown reads it, and can be ' +
      'edited as text. However a file is drawn, the file stays the same.',
    '',
    'Every example below is one of the test cases in `test/panel/syntax/cases/`, which ' +
      '`harness/tests/syntax.spec.mjs` draws in Chrome to check what it shows. This file is generated from those ' +
      'cases, the table of optional syntax in `src/panel/syntax/` and the settings in `package.json` by ' +
      '`scripts/syntax-reference.mjs` (`npm run syntax-reference`). Change them, not this file.',
    '',
    '## Contents',
    '',
    ...byGroup.map(
      ({ group, entries: list }) => `- ${link(group.heading)}: ${list.map((e) => link(e.title)).join(', ')}`,
    ),
    `- ${link('Settings')}`,
  ];
  for (const { group, entries: list } of byGroup) {
    out.push('', `## ${group.heading}`, '', group.intro);
    for (const entry of list) out.push(...renderEntry(entry));
  }
  out.push(
    '',
    '## Settings',
    '',
    "Each of these settings switches syntax beyond standard markdown and GitHub's tables, task lists, " +
      'strikethrough and bare addresses, and can be set per workspace folder. With one off, its text is read as ' +
      'standard markdown reads it, and the file is the same either way.',
  );
  const declared = manifest.contributes.configuration.properties;
  for (const syntax of table) out.push(...renderSetting(syntax, declared, ordered));
  return { text: out.join('\n') + '\n', entries: ordered.length };
}

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const { text, entries } = render(await syntaxTable(), readCases(), manifest);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // A missing file is stale.
  }
  if (current !== text) {
    console.error('SYNTAX.md is out of date: run npm run syntax-reference.');
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
  console.log(`Wrote SYNTAX.md: ${entries} entries.`);
}
