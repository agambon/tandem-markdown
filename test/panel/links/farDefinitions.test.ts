// Definitions past the stored parse (src/panel/links/farDefinitions.ts): a reference link and a
// footnote work wherever their definitions are, and the reading of the text past the stored parse
// says what the parse itself says wherever both exist.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { PanelSettings } from '../../../src/core/protocol';
import { createEditorState } from '../../../src/panel/editor';
import { footnoteIndex, footnotesKey } from '../../../src/panel/links/footnotes';
import { definitionLookup, linkAt, normalizeLabel } from '../../../src/panel/links/read';
import { withFullTree } from '../../../src/panel/render/framework';
import { OFF, SYNTAX, type SyntaxId } from '../../../src/panel/syntax';
import { drawn, fakeContext, visibleText } from '../helpers';

// A new state's own parse covers about the first 3,000 characters (CodeMirror 6's first
// viewport), so what comes after this filler is past it.
const FILLER = 'A paragraph of filler text.\n\n'.repeat(120);

function make(text: string, settings?: Partial<PanelSettings>, mode: 'view' | 'edit' = 'view'): EditorState {
  return createEditorState({ ctx: fakeContext({ settings }).ctx, text, mode });
}

describe('a reference link and a footnote defined past the stored parse', () => {
  const text = `Read [the guide][g] and a note.[^n]\n\n${FILLER}[g]: <guide one.md> "The guide"\n\n[^n]: The note.\n`;
  const guide = text.indexOf('the guide');
  const ref = text.indexOf('[^n]');

  it('draw as a link and a numbered note', () => {
    const state = make(text);
    expect(syntaxTree(state).length).toBeLessThan(text.indexOf('[g]:'));
    const items = drawn(state);
    // Drawn as a link: its brackets and label hidden.
    expect(visibleText(state).startsWith('Read the guide and a note.')).toBe(true);
    expect(items.some((d) => d.feature === 'footnotes' && d.from === ref && d.widget === 'FootnoteNumber')).toBe(true);
  });

  it('are followed to their definitions', () => {
    const state = make(text);
    expect(syntaxTree(state).length).toBeLessThan(text.indexOf('[g]:'));
    expect(linkAt(state, guide)).toMatchObject({ href: 'guide one.md', title: 'The guide' });
    expect(linkAt(state, ref + 1)?.footnote).toMatchObject({ role: 'reference', goTo: text.indexOf('The note.') });
  });

  it('are followed as the text is after an edit, before or past the stored parse', () => {
    let state = make(text, undefined, 'edit');
    expect(linkAt(state, guide)?.href).toBe('guide one.md');
    // Typed above, inside the stored parse: the definitions move with the text.
    state = state.update({ changes: { from: 0, insert: 'Say: ' } }).state;
    expect(linkAt(state, guide + 5)?.href).toBe('guide one.md');
    expect(linkAt(state, ref + 6)?.footnote?.goTo).toBe(state.doc.toString().indexOf('The note.'));
    // The definition changed where nothing is parsed.
    const at = state.doc.toString().indexOf('guide one.md');
    state = state.update({ changes: { from: at, to: at + 'guide one'.length, insert: 'other' } }).state;
    expect(linkAt(state, guide + 5)?.href).toBe('other.md');
    // A fence opened above the definitions makes them code.
    const filler = state.doc.toString().indexOf('A paragraph');
    state = state.update({ changes: { from: filler, insert: '```\n' } }).state;
    expect(linkAt(state, guide + 5)).toBeNull();
    expect(linkAt(state, ref + 6)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The reading past the stored parse and the parse itself

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

/** Every label written as `[label]:` in `text`, footnotes' aside, as a reference link's label is compared. */
function writtenLabels(text: string): string[] {
  return [...new Set([...text.matchAll(/\[([^\]^[][^\][]*)\]:/g)].map((m) => normalizeLabel(m[1]!)))].sort();
}

/**
 * What `state` reads: for each label written as a definition, what a reference link with that
 * label finds (the ones that are not definitions included), and the footnotes with where they are.
 */
function definitionsOf(state: EditorState): { links: unknown[]; notes: unknown[] } {
  const lookup = definitionLookup(state, true);
  const links = writtenLabels(state.doc.toString()).map((label) => {
    const d = lookup.get(label);
    return [label, d?.href ?? null, d?.title ?? null];
  });
  const index = footnoteIndex(state, true)!;
  const defined = footnotesKey(state).split(NUL)[1] ?? '';
  const notes = defined
    .split(SOH)
    .filter((label) => label)
    .map((label) => [label, index.definition(label)?.from ?? null]);
  return { links, notes };
}

/** Where each line of `text` starts, at most `most` of them spread through it, and -2: in the filler's last line. */
function lineStarts(text: string, most: number): number[] {
  const starts = [-2, 0];
  for (let i = text.indexOf('\n'); i >= 0 && i < text.length - 1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  if (starts.length <= most) return starts;
  return Array.from({ length: most }, (_, i) => starts[Math.floor((i * starts.length) / most)]!);
}

/**
 * Reads `text`, after the filler, with the stored parse ending at each of a number of its lines,
 * and expects the definitions the parse of the whole text gives each time.
 */
function expectAgreement(name: string, text: string, settings?: Partial<PanelSettings>, most = 30): void {
  const padded = FILLER + text;
  const whole = definitionsOf(withFullTree(make(padded, settings)));
  let short = 0;
  for (const at of lineStarts(text, most)) {
    const state = make(padded, settings);
    ensureSyntaxTree(state, FILLER.length + at, 10_000);
    const partial = state.update({}).state;
    if (syntaxTree(partial).length < padded.length) short++;
    expect(definitionsOf(partial), `${name}, the stored parse ending at ${at}`).toEqual(whole);
  }
  expect(short, name).toBeGreaterThan(0);
}

/** Every optional syntax on, a setting with choices at its first value that is not off. */
const ALL_ON: Partial<PanelSettings> = {
  syntax: Object.fromEntries(
    SYNTAX.map((s) => [s.id, 'choices' in s ? s.choices.find((c) => c.value !== OFF)!.value : true]),
  ) as PanelSettings['syntax'],
};

/** Where a definition can stand and where it cannot, and the definitions that run over lines. */
const PLACES = `[top]: /top "Top"

Uses [top], [mid], [quoted], [listed], [also], [multi], [mixed case], [dup], [^a], [^b], [^q], [^c].

\`\`\`
[fenced]: /not-a-definition
\`\`\`

~~~
[tilde]: /not-a-definition
~~~

    [indented]: /not-a-definition

<div>
[html]: /not-a-definition
</div>

<!--
[comment]: /not-a-definition
-->

> [quoted]: /quoted
> [^q]: A note in a quote.

- [listed]: /listed
  [also]: /also

1. [^c]: A note in a list.

[^a]: A note
    that goes on, indented,
    [^inner]: on a line of the note, not a note of its own.

[^b]: Another.

Paragraph text
[lazy]: /not-a-definition, the paragraph goes on

[multi]:
  /multi
  "Title on its own line"

[Mixed   CASE]: /first
[mixed case]: /second

| a | b |
|---|---|
| [cell]: /not-a-definition | y |

Underlined
===

[dup]: /one
[dup]: /two

[mid]: <a b.md> 'Single quotes'

$$
[math]: /not-a-definition
$$

\`\`\`
[unclosed]: /not-a-definition
`;

describe('the reading past the stored parse and the parse itself', () => {
  it('give the same definitions, wherever the stored parse ends (where definitions can stand)', () => {
    expectAgreement('places', PLACES, undefined, 200);
    expectAgreement('places, every syntax on', PLACES, ALL_ON, 200);
  });

  const samples = path.join(__dirname, '../../../harness/samples');
  for (const name of readdirSync(samples).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(path.join(samples, name), 'utf8').replace(/\r\n?/g, '\n');
    if (!text.includes(']:')) continue;
    it(`give the same definitions in harness/samples/${name}`, () => {
      expectAgreement(name, text);
      expectAgreement(`${name}, every syntax on`, text, ALL_ON);
    });
  }

  it('give the same definitions in every syntax case that writes one', () => {
    const folder = path.join(__dirname, '../syntax/cases');
    const cases = readdirSync(folder)
      .filter((n) => n.endsWith('.json'))
      .flatMap(
        (n) =>
          (
            JSON.parse(readFileSync(path.join(folder, n), 'utf8')) as {
              cases: { name: string; syntax: SyntaxId | null; example: string; value?: string }[];
            }
          ).cases,
      );
    const writing = cases.filter((c) => c.example.includes(']:'));
    expect(writing.length).toBeGreaterThan(0);
    for (const c of writing) {
      const settings = c.syntax ? { syntax: { [c.syntax]: c.value ?? true } } : undefined;
      expectAgreement(c.name, c.example, settings as Partial<PanelSettings> | undefined);
      expectAgreement(`${c.name}, every syntax on`, c.example, ALL_ON);
    }
  });
});
