// The cases of test/panel/syntax/cases/ (one file per family of syntax), parsed: each construct's
// nodes with its syntax on (or at the value a case of a setting with choices names), none of them
// with it off, and nothing drawn by its features while it is off; and every kind a case counts is
// one src/panel/syntax/kinds.ts knows. What Rich view shows for each case, and how many of each
// kind, is checked in Chrome by harness/tests/syntax.spec.mjs.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PanelSettings } from '../../../src/core/protocol';
import { createEditorState } from '../../../src/panel/editor';
import { parserFor } from '../../../src/panel/markdown';
import { withFullTree } from '../../../src/panel/render/framework';
import { OFF, SYNTAX, syntaxFeatures, type SyntaxId } from '../../../src/panel/syntax';
import { isKind, KINDS } from '../../../src/panel/syntax/kinds';
import { drawn, fakeContext, testSettings } from '../helpers';

interface Case {
  name: string;
  syntax: SyntaxId | null;
  example: string;
  nodes: string[];
  /** How many of each kind the reader sees in Rich view. */
  drawn: Record<string, number>;
  /** For a setting with choices, the value the case is read under. */
  value?: string;
}

const folder = path.join(__dirname, 'cases');
const cases = readdirSync(folder)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => (JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as { cases: Case[] }).cases);

/** The construct nodes of each syntax: every name its cases expect. */
const constructNodes = new Map<string, Set<string>>();
for (const c of cases) {
  if (!c.syntax) continue;
  const names = constructNodes.get(c.syntax) ?? new Set<string>();
  for (const name of c.nodes) names.add(name);
  constructNodes.set(c.syntax, names);
}

/** The value that turns a case's syntax on, or off. */
function valueFor(c: Case, on: boolean): boolean | string {
  if (c.value === undefined) return on;
  return on ? c.value : OFF;
}

function settingsWith(c: Case & { syntax: SyntaxId }, on: boolean): PanelSettings {
  return { ...testSettings, syntax: { [c.syntax]: valueFor(c, on) } };
}

function namesIn(text: string, settings: PanelSettings | undefined, wanted: Set<string>): string[] {
  const out: string[] = [];
  parserFor(settings)
    .parse(text)
    .iterate({
      enter(node) {
        if (wanted.has(node.name)) out.push(node.name);
      },
    });
  return out;
}

const optional = cases.filter((c): c is Case & { syntax: SyntaxId } => c.syntax !== null);

it('every kind a case counts is a kind the page draws, and every kind is counted by a case', () => {
  for (const c of cases) for (const name of Object.keys(c.drawn)) expect(isKind(name), `${c.name}: ${name}`).toBe(true);
  const counted = new Set(cases.flatMap((c) => Object.keys(c.drawn)));
  expect(Object.keys(KINDS).filter((name) => !counted.has(name))).toEqual([]);
});

it('the cases cover every optional syntax', () => {
  const covered = new Set(cases.map((c) => c.syntax));
  for (const s of SYNTAX) expect(covered.has(s.id), s.id).toBe(true);
});

it('a case of a setting with choices names one of its values, and no other case names one', () => {
  for (const c of cases) {
    const syntax = SYNTAX.find((s) => s.id === c.syntax);
    if (syntax && 'choices' in syntax)
      expect(
        syntax.choices.map((choice) => choice.value).filter((v) => v !== OFF),
        c.name,
      ).toContain(c.value);
    else expect(c.value, c.name).toBeUndefined();
  }
});

describe('with its syntax on, a case parses to its nodes', () => {
  for (const c of optional) {
    it(`${c.syntax}: ${c.name}`, () => {
      expect(namesIn(c.example, settingsWith(c, true), constructNodes.get(c.syntax)!)).toEqual(c.nodes);
    });
  }
});

describe('with its syntax off, a case has none of those nodes', () => {
  for (const c of optional) {
    it(`${c.syntax}: ${c.name}`, () => {
      expect(namesIn(c.example, settingsWith(c, false), constructNodes.get(c.syntax)!)).toEqual([]);
    });
  }
});

describe("with its syntax off, the syntax's features draw nothing and the text is unchanged", () => {
  for (const c of optional) {
    it(`${c.syntax}: ${c.name}`, () => {
      const features = new Set<string>(syntaxFeatures(SYNTAX.find((s) => s.id === c.syntax)!));
      const { ctx } = fakeContext({ settings: { syntax: { [c.syntax]: valueFor(c, false) } } });
      const state = withFullTree(createEditorState({ ctx, text: c.example, mode: 'view' }));
      expect(drawn(state).filter((d) => features.has(d.feature))).toEqual([]);
      expect(state.doc.toString()).toBe(c.example);
    });
  }
});
