// The syntax reference, SYNTAX.md, against the table of optional syntax: every entry of the
// table, and every value of a setting with choices, has an example there, the text of a case
// marked for the reference. scripts/syntax-reference.mjs writes the file from the marked cases;
// its --check fails when the file on disk is not what they give.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { OFF, SYNTAX } from '../../../src/panel/syntax';

interface Case {
  syntax: string | null;
  value?: string;
  example: string;
  reference?: { group: string };
}

/** The groups of the reference whose entries are not drawn as their syntax: shown as typed, drawn wrongly. */
const NOT_DRAWN = new Set(['typed', 'wrong']);

const folder = path.join(__dirname, 'cases');
const cases = readdirSync(folder)
  .filter((name) => name.endsWith('.json'))
  .flatMap((name) => (JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as { cases: Case[] }).cases);
const reference = readFileSync(path.join(__dirname, '..', '..', '..', 'SYNTAX.md'), 'utf8');

it('shows an example of every optional syntax, and of each value of a setting with choices', () => {
  for (const s of SYNTAX) {
    const values = 'choices' in s ? s.choices.map((c) => c.value).filter((v) => v !== OFF) : [undefined];
    for (const value of values) {
      const examples = cases
        .filter((c) => c.syntax === s.id && c.value === value && c.reference && !NOT_DRAWN.has(c.reference.group))
        .map((c) => c.example);
      expect(
        examples.some((example) => reference.includes(example)),
        value ? `${s.id}: ${value}` : s.id,
      ).toBe(true);
    }
  }
});
