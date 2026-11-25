// Links, wikilinks and images, headless: what is replaced or hidden when
// not revealed and shown when revealed; nothing reveals in Rich view; reference links
// resolve against their definitions; what is asked of the host and what its answers draw.

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { FeatureRequest } from '../../../src/core/featureProtocol';
import { completionChange } from '../../../src/panel/complete/wikilinks';
import type { PanelContext } from '../../../src/panel/context';
import { createEditorState } from '../../../src/panel/editor';
import { linkAt } from '../../../src/panel/links/read';
import { describeImage, imageStore } from '../../../src/panel/render/images';
import { openTarget } from '../../../src/panel/render/links';
import { cardContent } from '../../../src/panel/ui/linkCard';
import { drawHeadless } from '../headless';
import { drawn, fakeContext, moveTo, stateOf, visibleText } from '../helpers';

/** stateOf with the cursor at the start: a `|` in the text (a wikilink's alias bar) stays text. */
function at0(text: string, options?: Parameters<typeof stateOf>[1]): EditorState {
  return stateOf('‸' + text, options);
}

/** A context whose host answers through `answer` and records every request. */
function hostContext(answer: (m: { type: string; [k: string]: unknown }) => unknown = () => ({})) {
  const base = fakeContext();
  const requests: { type: string; [k: string]: unknown }[] = [];
  const ctx: PanelContext = {
    ...base.ctx,
    request: <T>(message: FeatureRequest) => {
      const m = { ...message };
      requests.push(m);
      return Promise.resolve(answer(m) as T);
    },
  };
  return { ctx, requests };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Every widget a feature drew, with its range. */
function widgets(state: EditorState, feature: string): { from: number; to: number; widget: unknown; point: boolean }[] {
  const out: { from: number; to: number; widget: unknown; point: boolean }[] = [];
  for (const f of drawHeadless(state)) {
    if (f.feature !== feature) continue;
    f.decorations.between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.widget) out.push({ from, to, widget: deco.spec.widget, point: !deco.spec.widget || from === to });
    });
  }
  return out;
}

function classesAt(state: EditorState, pos: number): string[] {
  return drawn(state)
    .filter((d) => d.kind === 'mark' && d.from <= pos && d.to > pos)
    .flatMap((d) => d.className.split(' '));
}

describe('links', () => {
  const text = 'See [the docs](https://example.com/a "Docs") and <https://b.example> and www.c.example here.\n';

  it('show their text only while not revealed', () => {
    expect(visibleText(at0(text))).toBe('See the docs and https://b.example and www.c.example here.\n');
  });

  it('show their source when the cursor touches them', () => {
    const at = text.indexOf('docs');
    const state = moveTo(at0(text), at);
    expect(visibleText(state)).toContain('[the docs](https://example.com/a "Docs")');
    expect(visibleText(state)).not.toContain('<https');
  });

  it('nothing reveals in Rich view', () => {
    for (const pos of [text.indexOf('docs'), text.indexOf('b.example')]) {
      const shown = visibleText(moveTo(at0(text, { mode: 'view' }), pos));
      expect(shown).toBe('See the docs and https://b.example and www.c.example here.\n');
    }
  });

  it('a link with no text shows its address', () => {
    expect(visibleText(at0('Go [](<My Page.md>) now.'))).toBe('Go My Page.md now.');
  });

  it('a link over two lines hides its marks on both', () => {
    expect(visibleText(at0('A [two\nlines](x.md\n"t") b'))).toBe('A two\nlines\n b');
  });
});

describe('reference links', () => {
  const text = 'Read [the guide][g], [G][], [g] and [nothing][none] or [sic].\n\n[G]:   <guide one.md>  "The guide"\n';

  it('resolve against the definitions in the file, case and spacing aside', () => {
    const shown = visibleText(at0(text, { mode: 'edit' }));
    expect(shown.split('\n')[0]).toBe('Read the guide, G, g and [nothing][none] or [sic].');
    const state = at0(text);
    expect(linkAt(state, text.indexOf('the guide'))).toMatchObject({
      kind: 'file',
      href: 'guide one.md',
      title: 'The guide',
    });
    expect(linkAt(state, text.indexOf('[g]') + 1)).toMatchObject({ href: 'guide one.md' });
    expect(linkAt(state, text.indexOf('nothing'))).toBeNull();
    expect(linkAt(state, text.indexOf('sic'))).toBeNull();
  });

  it('are found past where the parse a state was made with ends', () => {
    // A new state's own parse covers about the first 3,000 characters (CodeMirror 6's first viewport).
    const long = `${'A paragraph of filler text.\n\n'.repeat(200)}Read [the guide](<guide one.md>).`;
    const state = createEditorState({ ctx: fakeContext().ctx, text: long, mode: 'view' });
    expect(syntaxTree(state).length).toBeLessThan(long.indexOf('the guide'));
    expect(linkAt(state, long.indexOf('the guide'))).toMatchObject({ href: 'guide one.md' });
  });

  it('their definitions are removed in Rich view and shown in Rich editor', () => {
    const view = visibleText(at0(text, { mode: 'view' }));
    expect(view).not.toContain('[G]:');
    expect(view.trimEnd().endsWith('[sic].')).toBe(true);
    expect(visibleText(at0(text))).toContain('[G]:   <guide one.md>  "The guide"');
  });

  it('a definition later in the file counts too', () => {
    const t = '[x][later]\n\n' + 'para\n\n'.repeat(50) + '[later]: https://later.example\n';
    expect(linkAt(at0(t), 1)).toMatchObject({ kind: 'web', href: 'https://later.example' });
  });
});

describe('what a link opens', () => {
  it('reads the kind from the address', () => {
    const t =
      '[a](https://x.y) [b](#Some-heading) [c](../Other.md#part) <me@example.com> www.site.example [[Note#Part|N]] ![[Doc.pdf]]';
    const state = at0(t);
    const at = (s: string) => linkAt(state, t.indexOf(s) + 1);
    expect(at('[a]')).toMatchObject({ kind: 'web', href: 'https://x.y' });
    expect(at('[b]')).toMatchObject({ kind: 'anchor', href: '#Some-heading' });
    expect(at('[c]')).toMatchObject({ kind: 'file', href: '../Other.md#part' });
    expect(at('me@')).toMatchObject({ kind: 'web', href: 'mailto:me@example.com' });
    expect(at('www.')).toMatchObject({ kind: 'web', href: 'http://www.site.example' });
    expect(at('Note')).toMatchObject({ kind: 'wikilink', href: 'Note#Part', target: 'Note' });
    expect(at('Doc.pdf')).toMatchObject({ kind: 'wikilink', href: 'Doc.pdf' });
  });

  it("a link inside a table is the table's, and an image is not a link", () => {
    const t = '| a |\n| - |\n| [x](y.md) |\n\n![pic](p.png)\n';
    const state = at0(t);
    expect(linkAt(state, t.indexOf('[x]') + 1)).toBeNull();
    expect(linkAt(state, t.indexOf('pic'))).toBeNull();
  });

  it('a linked image opens its link', () => {
    const t = '[![badge](b.svg)](https://ci.example)';
    expect(linkAt(at0(t), t.indexOf('badge'))).toMatchObject({ kind: 'web', href: 'https://ci.example' });
  });

  it('opening posts openLink with the view it was clicked in', async () => {
    const { ctx, requests } = hostContext();
    const t = 'A [link](Other.md) here';
    for (const mode of ['view', 'edit'] as const) {
      const state = at0(t, { ctx, mode });
      openTarget({ state } as EditorView, linkAt(state, t.indexOf('link'))!);
    }
    expect(requests).toEqual([
      { type: 'openLink', kind: 'file', href: 'Other.md', mode: 'view' },
      { type: 'openLink', kind: 'file', href: 'Other.md', mode: 'edit' },
    ]);
  });
});

describe('wikilinks', () => {
  const text = 'Go to [[Folder/Target]], [[Target|the alias]], [[Note#Part]], [[#Local]] and [[Gone]].\n';

  it('draw their alias, else their target, with a heading after ">"', () => {
    expect(visibleText(at0(text))).toBe(
      'Go to Folder/Target, the alias, Note[HeadingSeparator]Part, Local and Gone.\n',
    );
  });

  it('show their source when revealed, and never in Rich view', () => {
    const at = text.indexOf('the alias');
    expect(visibleText(moveTo(at0(text), at))).toContain('[[Target|the alias]]');
    expect(visibleText(moveTo(at0(text, { mode: 'view' }), at))).not.toContain('[[');
  });

  it('ask the host about the targets they draw, once each', async () => {
    const { ctx, requests } = hostContext(() => ({}));
    drawn(at0(text, { ctx }));
    drawn(at0(text, { ctx }));
    await tick();
    const asked = requests.filter((r) => r.type === 'resolveLinks').flatMap((r) => r.targets as string[]);
    expect(asked.sort()).toEqual(['Folder/Target', 'Gone', 'Note', 'Target']);
  });

  it('a missing target is drawn as missing, an ambiguous one as ambiguous', async () => {
    const { ctx } = hostContext((m) =>
      m.type === 'resolveLinks'
        ? {
            Gone: { status: 'missing', candidates: [] },
            Target: { status: 'ambiguous', path: 'a/Target.md', candidates: ['a/Target.md', 'b/Target.md'] },
            'Folder/Target': { status: 'ok', path: 'Folder/Target.md', candidates: ['Folder/Target.md'] },
          }
        : {},
    );
    drawn(at0(text, { ctx }));
    await tick();
    const state = at0(text, { ctx });
    const found = classesAt(state, text.indexOf('Folder'));
    const missing = classesAt(state, text.indexOf('Gone'));
    const ambiguous = classesAt(state, text.indexOf('the alias'));
    // A link the host found and a link to a heading here are drawn alike; a missing one and an
    // ambiguous one each their own way.
    expect(classesAt(state, text.indexOf('Local'))).toEqual(found);
    expect(missing).not.toEqual(found);
    expect(ambiguous).not.toEqual(found);
    expect(ambiguous).not.toEqual(missing);
  });

  it("draw Bear's Note/Heading as a link to a heading once the host reads it so", async () => {
    const bear = 'See [[Recipes/Bread]], [[/Monday]] and [[Recipes/Cake]].\n';
    const { ctx } = hostContext((m) =>
      m.type === 'resolveLinks'
        ? {
            'Recipes/Bread': { status: 'ok', path: 'Recipes.md', candidates: ['Recipes.md'], heading: 'Bread' },
            '/Monday': { status: 'ok', path: 'test.md', candidates: ['test.md'], heading: 'Monday' },
            'Recipes/Cake': { status: 'missing', candidates: [] },
          }
        : {},
    );
    drawn(at0(bear, { ctx }));
    await tick();
    expect(visibleText(at0(bear, { ctx }))).toBe('See Recipes[HeadingSeparator]Bread, Monday and Recipes/Cake.\n');
  });

  it('draw [[toc]] alone on its line as a contents list unless the host says a note answers it', async () => {
    const toc = '[[toc]]\n\n# A\n';
    const answered = (status: string) =>
      hostContext((m) => (m.type === 'resolveLinks' ? { toc: { status, candidates: [] } } : {})).ctx;
    const listed = (ctx: PanelContext) => widgets(at0(toc, { ctx, mode: 'view' }), 'contents').length;
    const missing = answered('missing');
    const note = answered('ok');
    expect(listed(missing)).toBe(1);
    expect(listed(note)).toBe(1);
    await tick();
    expect(listed(missing)).toBe(1);
    expect(listed(note)).toBe(0);
  });

  it('a wikilink in a table cell written with \\| is one link', () => {
    const t = 'A [[Target\\|Alias]] b';
    expect(visibleText(at0(t))).toBe('A Alias b');
  });
});

describe('images', () => {
  it('are replaced by the image when not revealed: a block alone on a line, inline in text', () => {
    const t =
      'Intro\n\n![Alt text](img/pic.png "Title")\n\nText ![badge](b.svg) more\n\n> - ![](<My Note-20261114.png>)\n';
    const state = at0(t);
    // (The quote and list marks are the quote and list features' to draw.)
    expect(visibleText(state)).toMatch(
      /^Intro\n\n\[ImageWidget\]\n\nText \[ImageWidget\] more\n\n.*\[ImageWidget\]\n$/,
    );
    const specs = widgets(state, 'images').map(
      (w) => (w.widget as { spec: { address: string; block: boolean; alt: string; title: string } }).spec,
    );
    expect(specs.map((s) => [s.address, s.block])).toEqual([
      ['img/pic.png', true],
      ['b.svg', false],
      ['My Note-20261114.png', true],
    ]);
    expect(specs[0]).toMatchObject({ alt: 'Alt text', title: 'Title' });
  });

  it('show their source when revealed, a block image still drawn after it', () => {
    const t = 'Intro\n\n![Alt](pic.png)\n';
    const state = moveTo(at0(t), t.indexOf('Alt'));
    expect(visibleText(state)).toBe(t);
    const drawnImages = widgets(state, 'images');
    expect(drawnImages).toHaveLength(1);
    expect(drawnImages[0]!.from).toBe(t.indexOf(')') + 1);
    expect((drawnImages[0]!.widget as { spec: { preview: boolean } }).spec.preview).toBe(true);
  });

  it('nothing reveals in Rich view', () => {
    const t = 'Intro\n\n![Alt](pic.png)\n';
    expect(visibleText(moveTo(at0(t, { mode: 'view' }), t.indexOf('Alt')))).toBe('Intro\n\n[ImageWidget]\n');
  });

  it('embeds of images draw the image, with an alias as their size; a note embedded in a line is a link', () => {
    const t = 'Intro\n\n![[pic.png|300]]\n\n![[photo.jpg|120x80]]\n\nSee ![[Other note]] here.\n';
    const state = at0(t);
    const specs = widgets(state, 'images').map(
      (w) => (w.widget as { spec: { address: string; width: number | null; height: number | null } }).spec,
    );
    expect(specs).toMatchObject([
      { address: '[[pic.png]]', width: 300, height: null },
      { address: '[[photo.jpg]]', width: 120, height: 80 },
    ]);
    expect(visibleText(state)).toContain('Other note');
    // Drawn as a wikilink to it is, with a mark of its own for the embed.
    const plain = 'See [[Other note]] here.\n';
    expect(classesAt(state, t.indexOf('Other'))).toEqual(
      expect.arrayContaining(classesAt(at0(plain), plain.indexOf('Other'))),
    );
  });

  it('reference images resolve against definitions; an undefined one stays text', () => {
    const t = 'A ![logo][l] and ![x][none]\n\n[l]: logo.png\n';
    const state = at0(t);
    const specs = widgets(state, 'images').map((w) => (w.widget as { spec: { address: string } }).spec.address);
    expect(specs).toEqual(['logo.png']);
    expect(visibleText(state)).toContain('![x][none]');
  });

  it('ask the host about each source once, and a failed one draws its path and the reason', async () => {
    const { ctx, requests } = hostContext((m) =>
      m.type === 'resolveImages'
        ? { 'gone.png': { reason: 'Not found' }, 'ok.png': { uri: 'https://file.vscode-resource.example/ok.png' } }
        : {},
    );
    const t = '![a](gone.png) ![b](ok.png) ![c](gone.png)\n';
    drawn(at0(t, { ctx }));
    await tick();
    const asked = requests.filter((r) => r.type === 'resolveImages').flatMap((r) => r.sources as string[]);
    expect(asked.sort()).toEqual(['gone.png', 'ok.png']);
    expect(describeImage('gone.png', { reason: 'Not found' })).toEqual({
      kind: 'failed',
      path: 'gone.png',
      reason: 'Not found',
    });
    expect(describeImage('[[pic.png]]', { reason: 'Outside the workspace' })).toEqual({
      kind: 'failed',
      path: 'pic.png',
      reason: 'Outside the workspace',
    });
    expect(describeImage('ok.png', { uri: 'https://x/ok.png' })).toEqual({ kind: 'image', src: 'https://x/ok.png' });
    expect(describeImage('ok.png', undefined)).toMatchObject({ kind: 'loading' });
  });

  it('an image the host never answers is drawn as one that could not be checked', async () => {
    const base = fakeContext();
    const ctx: PanelContext = { ...base.ctx, request: () => Promise.reject(new Error('No host')) };
    drawn(at0('![a](x.png)\n', { ctx }));
    await tick();
    expect(imageStore(ctx).get('x.png')).toEqual({ reason: 'Could not be checked' });
    expect(describeImage('x.png', imageStore(ctx).get('x.png'))).toMatchObject({
      kind: 'failed',
      reason: 'Could not be checked',
    });
  });

  it('an answer is kept, and drawing the image again does not ask again', async () => {
    const { ctx, requests } = hostContext((m) =>
      m.type === 'resolveImages' ? { 'a.png': { reason: 'Outside the workspace' } } : {},
    );
    drawn(at0('![a](a.png)\n', { ctx }));
    await tick();
    drawn(at0('![a](a.png)\n', { ctx }));
    await tick();
    expect(imageStore(ctx).get('a.png')).toEqual({ reason: 'Outside the workspace' });
    expect(requests.filter((r) => r.type === 'resolveImages')).toHaveLength(1);
  });
});

describe('the link card', () => {
  const base = { from: 0, to: 1 };
  it('shows the address, or which file a wikilink opens', () => {
    expect(cardContent({ ...base, kind: 'web', href: 'https://x.y', title: 'T' }, undefined)).toMatchObject({
      address: 'https://x.y',
      title: 'T',
      canOpen: true,
    });
    expect(
      cardContent({ ...base, kind: 'wikilink', href: 'Gone', target: 'Gone' }, { status: 'missing', candidates: [] }),
    ).toMatchObject({
      note: 'No file matches this link.',
      canOpen: false,
    });
    const ambiguous = cardContent(
      { ...base, kind: 'wikilink', href: 'T', target: 'T' },
      { status: 'ambiguous', path: 'a/T.md', candidates: ['a/T.md', 'b/T.md'] },
    );
    expect(ambiguous).toMatchObject({ address: 'a/T.md', others: ['b/T.md'], canOpen: true });
  });
});

describe('[[ completion', () => {
  const doc = (s: string) => ({ sliceString: (f: number, t?: number) => s.slice(f, t), length: s.length });

  it('adds the closing ]] when it is not there', () => {
    const s = 'See [[No and more';
    expect(completionChange(doc(s), 'Notes/Note', 6, 8)).toEqual({
      from: 6,
      to: 8,
      insert: 'Notes/Note]]',
      cursor: 6 + 10 + 2,
    });
  });

  it('inside an existing link, replaces the rest of the target and keeps what follows', () => {
    const s = 'See [[No]] x';
    expect(completionChange(doc(s), 'Note', 6, 8)).toEqual({ from: 6, to: 8, insert: 'Note', cursor: 12 });
    const t = 'See [[Nopq|alias]]';
    expect(completionChange(doc(t), 'Note', 6, 8)).toEqual({ from: 6, to: 10, insert: 'Note', cursor: 10 });
  });
});
