// The insert menu, headless: which entries it offers where, and what each one writes and where the
// cursor lands, on a line of its own and on a line with text. The menu itself, opened by typing
// and by the toolbar's Insert button, is checked in Chrome by harness/tests/editing.spec.mjs.

import { CompletionContext } from '@codemirror/autocomplete';
import { describe, expect, it } from 'vitest';
import type { PanelSettings } from '../../../src/core/protocol';
import { insertEntry, insertMenuSource } from '../../../src/panel/complete/insertMenu';
import { after, marked, stateWith, type StateOptions } from '../commands/helpers';

/** The marked text after choosing `label` with the menu open from the last `/` before the cursor. */
function choose(label: string, text: string, options: StateOptions = {}): string {
  const state = stateWith(text, options);
  const head = state.selection.main.head;
  const chosen = insertEntry(state, label, state.doc.sliceString(0, head).lastIndexOf('/'), head);
  if (!chosen) throw new Error(`No entry ${label}`);
  return marked(after(state.update(chosen.spec)));
}

/** The labels the menu offers at the cursor of the marked text, or null when it does not open. */
function offered(text: string, options: StateOptions = {}): string[] | null {
  const state = stateWith(text, options);
  const result = insertMenuSource(new CompletionContext(state, state.selection.main.head, false));
  return result ? result.options.map((o) => o.label) : null;
}

type Case = [label: string, before: string, after: string];

describe('what each entry writes', () => {
  const cases: Case[] = [
    ['Heading 1', '/h1‸', '# ‸'],
    ['Heading 2', 'Intro /h2‸', '## Intro‸'],
    ['Heading 3', '## Intro /h3‸', '### Intro‸'],
    ['Heading 4', '#### Intro /h4‸', '#### Intro‸'],
    ['Heading 6', '> /h6‸', '> ###### ‸'],
    ['Bullet list', '/ul‸', '- ‸'],
    ['Bullet list', 'Intro /ul‸', '- Intro‸'],
    ['Bullet list', '- Item /ul‸', '- Item‸'],
    ['Bullet list', '1. Item /ul‸', '- Item‸'],
    ['Numbered list', '/ol‸', '1. ‸'],
    ['Numbered list', 'Intro /ol‸', '1. Intro‸'],
    ['Numbered list', '1. One\n2. Two\n\n/ol‸', '1. One\n2. Two\n\n3. ‸'],
    ['Task list', '/todo‸', '- [ ] ‸'],
    ['Task list', 'Intro /todo‸', '- [ ] Intro‸'],
    ['Task list', '* Item /todo‸', '* [ ] Item‸'],
    ['Quote', '/quote‸', '> ‸'],
    ['Quote', 'Intro /quote‸', '> Intro‸'],
    ['Quote', '> Intro /quote‸', '> Intro‸'],
    ['Note callout', '/note‸', '> [!NOTE]\n> ‸'],
    ['Caution callout', 'Intro /caution‸', 'Intro\n\n> [!CAUTION]\n> ‸'],
    ['Code block', '/code‸', '```\n‸\n```'],
    ['Code block', 'Intro /code‸', 'Intro\n\n```\n‸\n```'],
    ['Mermaid diagram', '/mermaid‸', '```mermaid\nflowchart LR\n    A --> B‸\n```'],
    ['Math block', 'Intro /math‸', 'Intro\n\n$$\n‸\n$$'],
    ['Link', '/link‸', '[‸]()'],
    ['Link', 'Intro /link‸', 'Intro [‸]()'],
    ['Inline math', 'Area /math‸', 'Area $‸$'],
    ['Rule', '/rule‸', '---\n‸'],
    ['Rule', 'Intro /rule‸', 'Intro\n\n---\n‸'],
    ['Contents list', '/toc‸', '[TOC]\n‸'],
    ['Contents list', 'Intro /toc‸', 'Intro\n\n[TOC]\n‸'],
    ['Definition list', '/term‸', '‸\n: '],
    ['Definition list', 'Intro /term‸', 'Intro\n\n‸\n: '],
    ['Front matter', '/front‸', '---\n‸\n---'],
    ['Front matter', 'Title\n\nIntro /front‸', '---\n‸\n---\nTitle\n\nIntro'],
    ['Bold', '/bold‸', '**‸**'],
    ['Bold', 'Intro /b‸', 'Intro **‸**'],
    ['Italic', 'Intro /i‸', 'Intro *‸*'],
    ['Strikethrough', 'Intro /strike‸', 'Intro ~~‸~~'],
    ['Inline code', 'Intro /code‸', 'Intro `‸`'],
    ['Highlight', 'Intro /mark‸', 'Intro ==‸=='],
  ];
  for (const [label, before, expected] of cases)
    it(`${label}: ${JSON.stringify(before)}`, () => expect(choose(label, before)).toBe(expected));

  it('an inline entry goes at the / when a word follows the cursor, and leaves the word alone', () => {
    expect(choose('Bold', 'Some /b‸text')).toBe('Some **‸**text');
  });

  it('a line entry at the start of a line leaves no space before the words after it', () => {
    expect(choose('Heading 1', '/h1‸ trailing words')).toBe('# ‸trailing words');
    expect(choose('Bullet list', '/ul‸ trailing words')).toBe('- ‸trailing words');
    expect(choose('Task list', '/todo‸ trailing words')).toBe('- [ ] ‸trailing words');
    expect(choose('Quote', '/quote‸ trailing words')).toBe('> ‸trailing words');
    expect(choose('Heading 2', '- /h2‸ words')).toBe('- ## ‸words');
  });

  it('a block entry keeps what follows the cursor on its line', () => {
    expect(choose('Code block', 'One /code‸ two')).toBe('One  two\n\n```\n‸\n```');
  });

  it('a block goes inside the quote it is typed in', () => {
    expect(choose('Code block', '> /code‸')).toBe('> ```\n> ‸\n> ```');
    expect(choose('Note callout', '> /note‸')).toBe('> > [!NOTE]\n> > ‸');
  });

  it('nothing outside the line it is typed on changes', () => {
    expect(choose('Heading 2', 'Above.\n\nIntro /h2‸\n\nBelow.')).toBe('Above.\n\n## Intro‸\n\nBelow.');
  });

  it('a footnote is numbered one past the highest, and written at the end of the note', () => {
    expect(choose('Footnote', 'Intro /foot‸')).toBe('Intro [^1]\n\n[^1]: ‸');
    expect(choose('Footnote', 'A[^2] and /foot‸ b.\n\n[^2]: Two.\n')).toBe(
      'A[^2] and [^3] b.\n\n[^2]: Two.\n\n[^3]: ‸\n',
    );
    expect(choose('Footnote', 'A[^note] /foot‸\n\n[^note]: Text.\n\n')).toBe(
      'A[^note] [^1]\n\n[^note]: Text.\n\n[^1]: ‸\n',
    );
  });

  it('a table goes on its own lines, as the Table button puts it', () => {
    const result = choose('Table', 'Intro /table‸');
    expect(result.startsWith('Intro\n\n| ')).toBe(true);
    expect(result.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(4);
  });

  it('the image entry takes the typed text away and leaves the rest to the file picker', () => {
    expect(choose('Image', 'Intro /image‸')).toBe('Intro ‸');
  });
});

describe('where the menu opens and what it offers', () => {
  it('opens after a / at the start of a line or after a space, with every entry', () => {
    expect(offered('/‸')).toHaveLength(32);
    expect(offered('Intro /‸')).toHaveLength(32);
    expect(offered('Intro\t/‸')).toHaveLength(32);
  });

  it('narrows to the entries with a word starting with what was typed, in order', () => {
    expect(offered('/h‸')).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Heading 5',
      'Heading 6',
      'Rule',
      'Highlight',
    ]);
    expect(offered('/H2‸')).toEqual(['Heading 2']);
    expect(offered('/table‸')).toEqual(['Table', 'Contents list']);
  });

  it('does not open when nothing matches, after a letter, or in a path', () => {
    expect(offered('/zz‸')).toBeNull();
    expect(offered('a/‸')).toBeNull();
    expect(offered('/usr/bin‸')).toBeNull();
    expect(offered('/two words‸')).toBeNull();
  });

  it('does not open in code, a table, front matter, a code span or Rich view', () => {
    expect(offered('```\n/‸\n```')).toBeNull();
    expect(offered('    /‸')).toBeNull();
    expect(offered('| a | b |\n| - | - |\n| /‸ | c |')).toBeNull();
    expect(offered('---\ntitle: /‸\n---\n')).toBeNull();
    expect(offered('a `b /‸ c`')).toBeNull();
    expect(offered('/‸', { mode: 'view' })).toBeNull();
    expect(offered('/‸', { readOnly: true })).toBeNull();
  });

  it('offers an entry for an optional syntax only while it is on', () => {
    const off: Partial<PanelSettings['syntax']> = { callouts: false, math: false, highlight: false };
    const labels = offered('/‸', { settings: { syntax: off as PanelSettings['syntax'] } })!;
    expect(labels).not.toContain('Note callout');
    expect(labels).not.toContain('Math block');
    expect(labels).not.toContain('Inline math');
    expect(labels).not.toContain('Highlight');
    expect(labels).toContain('Footnote');
  });

  it('offers front matter only to a note that has none', () => {
    expect(offered('Intro /front‸')).toEqual(['Front matter']);
    expect(offered('---\ntitle: A\n---\nIntro /front‸')).toBeNull();
  });

  it('never offers a folding section, which would write HTML', () => {
    expect(offered('/details‸')).toBeNull();
    expect(offered('/‸')!.some((label) => /fold/i.test(label))).toBe(false);
  });
});
