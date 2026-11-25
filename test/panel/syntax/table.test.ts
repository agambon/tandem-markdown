// The table of optional syntax against what is declared for it elsewhere: the settings in
// package.json, the entries under "Settings" in SYNTAX.md and the features list.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../../../package.json';
import { features } from '../../../src/panel/features';
import { OFF, SYNTAX, syntaxFeatures } from '../../../src/panel/syntax';

const PREFIX = 'tandemMarkdown.syntax.';
const declared = manifest.contributes.configuration.properties as Record<string, Record<string, unknown>>;
const reference = readFileSync(path.join(__dirname, '..', '..', '..', 'SYNTAX.md'), 'utf8');
/** SYNTAX.md from its "Settings" heading on, where each setting has an entry. */
const settingsPart = reference.slice(reference.indexOf('\n## Settings\n'));

describe('the table of optional syntax', () => {
  it('has one setting in package.json per entry, with its default and description', () => {
    const settings = Object.keys(declared).filter((key) => key.startsWith(PREFIX));
    expect(settings.sort()).toEqual(SYNTAX.map((s) => PREFIX + s.id).sort());
    for (const s of SYNTAX) {
      const common = { default: s.default, markdownDescription: s.description, scope: 'resource' };
      if ('choices' in s) {
        expect(declared[PREFIX + s.id], s.id).toMatchObject({
          ...common,
          type: 'string',
          enum: s.choices.map((c) => c.value),
          markdownEnumDescriptions: s.choices.map((c) => c.description),
        });
      } else {
        expect(declared[PREFIX + s.id], s.id).toMatchObject({ ...common, type: 'boolean' });
      }
    }
  });

  it('has one entry per setting under Settings in SYNTAX.md, with its default and description', () => {
    expect(settingsPart.startsWith('\n## Settings\n')).toBe(true);
    const headings = settingsPart.split(/\n(?=#)/);
    for (const s of SYNTAX) {
      // The entry is the heading that names the setting and what follows it, up to the next heading.
      const entries = headings.filter((h) => h.split('\n')[0]!.includes(`\`${PREFIX}${s.id}\``));
      expect(entries, s.id).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry, s.id).toContain(s.description);
      // The default is stated where the entry opens, before its description.
      const opening = entry.split('\n').find((line, i) => i > 0 && line.trim() !== '')!;
      const stated = opening.slice(0, opening.indexOf(s.description));
      if ('choices' in s) {
        expect(
          s.choices.map((c) => c.value).filter((value) => stated.includes(`\`${value}\``)),
          s.id,
        ).toEqual([s.default]);
      } else {
        expect(stated, s.id).toMatch(s.default ? /\bon\b/i : /\boff\b/i);
        expect(stated, s.id).not.toMatch(s.default ? /\boff\b/i : /\bon\b/i);
      }
    }
  });

  it('gives every setting with choices an off value that reads nothing, and a default among them', () => {
    for (const s of SYNTAX) {
      if (!('choices' in s)) continue;
      const values = s.choices.map((c) => c.value);
      expect(values, s.id).toContain(s.default);
      expect(
        s.choices.find((c) => c.value === OFF),
        s.id,
      ).toMatchObject({ parse: [], draw: [] });
    }
  });

  it('names only features that exist', () => {
    const ids = new Set(features.map((f) => f.id));
    for (const s of SYNTAX)
      for (const feature of syntaxFeatures(s)) expect(ids.has(feature), `${s.id}: ${feature}`).toBe(true);
  });
});
