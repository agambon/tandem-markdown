import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { codeText } from '../../../src/panel/render/code';
import { toggleTaskAt } from '../../../src/panel/render/lists';
import { drawHeadless } from '../headless';
import { drawn, fakeContext, lineClasses, moveTo, standInView, stateOf, visibleText } from '../helpers';

describe('headings', () => {
  it('hide # unless the cursor is on the line', () => {
    const t = '# Title\n\nText\n';
    expect(visibleText(stateOf(t + '‸'))).toBe('Title\n\nText\n');
    expect(visibleText(moveTo(stateOf(t), 3))).toBe(t);
  });

  it('remove a Setext underline unless the heading is revealed', () => {
    const t = 'Title\n=====\n\nText\n';
    expect(visibleText(stateOf(t + '‸'))).toBe('Title\n\nText\n');
    expect(visibleText(moveTo(stateOf(t), 2))).toBe(t);
  });
});

describe('lists and tasks', () => {
  it('nesting comes from the tree, not from counting spaces', () => {
    // Three spaces and five spaces both nest one level under a "- " item: drawn alike, and
    // apart from the items they nest under.
    const state = stateOf('‸- a\n   - b\n- c\n     - d\n');
    expect(lineClasses(state, 2)).toEqual(lineClasses(state, 4));
    expect(lineClasses(state, 2)).not.toEqual(lineClasses(state, 3));
    expect(visibleText(state)).not.toMatch(/^ /m);
  });

  it("names a checkbox by what its task's text draws, a reference link by a definition far below", () => {
    const t =
      '- [ ] Buy **milk** &amp; [bread][b] [^1]\n\n' +
      'Text.\n\n'.repeat(40) +
      '[b]: https://example.com\n[^1]: A note.\n';
    const state = stateOf('‸' + t, { mode: 'view' });
    const names: string[] = [];
    for (const f of drawHeadless(state))
      f.decorations.between(0, state.doc.length, (_from, _to, deco) => {
        const widget = deco.spec.widget as { name?: { text: string } } | undefined;
        if (widget?.constructor.name === 'TaskBox') names.push(widget.name!.text);
      });
    expect(names).toEqual(['Buy milk & bread 1']);
  });

  it('a checked task draws a checkbox, and clicking flips the marker', () => {
    const t = '- [x] done\n- [ ] todo\n';
    const state = stateOf('‸' + t, { mode: 'view' });
    expect(drawn(state).filter((d) => d.widget === 'TaskBox').length).toBe(2);

    const view = standInView(state);
    expect(toggleTaskAt(view, t.indexOf('[ ]'))).toBe(true);
    expect(view.state.doc.toString()).toBe('- [x] done\n- [x] todo\n');
    expect(view.specs[view.specs.length - 1]?.userEvent).toBe('input.toggle');
    expect(toggleTaskAt(view, 2)).toBe(true);
    expect(view.state.doc.toString()).toBe('- [ ] done\n- [x] todo\n');
    expect(toggleTaskAt(view, 0)).toBe(false);
  });

  it('a task does nothing when the document is read-only', () => {
    const ctx = fakeContext({ readOnly: true }).ctx;
    const view = standInView(stateOf('- [ ] todo\n', { ctx }));
    expect(toggleTaskAt(view, 2)).toBe(false);
    expect(view.state.doc.toString()).toBe('- [ ] todo\n');
  });
});

describe('footnotes', () => {
  it("a definition's further lines hide their four-space indent and are drawn in one step", () => {
    const t = 'Text[^1].\n\n[^1]: First line\n    goes on.\n\n    A second paragraph.\n\nAfter.\n';
    const state = stateOf(t, { mode: 'view' });
    expect(visibleText(state)).not.toMatch(/^ /m);
    // The further lines are drawn alike, as part of the note, and the paragraph after it is not.
    expect(lineClasses(state, 4)).toEqual(lineClasses(state, 6));
    expect(lineClasses(state, 4)).not.toEqual(lineClasses(state, 8));
  });
});

describe('quotes', () => {
  it('hide > unless the cursor is on the line', () => {
    const t = '> one\n> two\n';
    expect(visibleText(stateOf(t + '‸', { mode: 'view' }))).toBe('one\ntwo\n');
    expect(visibleText(moveTo(stateOf(t), 2))).toBe('> one\ntwo\n');
  });
});

describe('code blocks', () => {
  const t = 'Before\n\n```js\nlet x = 1;\n```\n\nAfter\n';

  it('replace the fences with a header unless the cursor is in the block', () => {
    const away = visibleText(stateOf('‸' + t));
    expect(away).toBe('Before\n\n[CodeHeader]\nlet x = 1;\n\nAfter\n');
    const inside = moveTo(stateOf(t), t.indexOf('x ='));
    expect(visibleText(inside)).toBe(t);
    const onFence = moveTo(stateOf(t), t.indexOf('```js'));
    expect(visibleText(onFence)).toBe(t);
  });

  it('copy gives the code without fences or quote markers', () => {
    const quoted = '> ```\n> a\n>   b\n> ```\n';
    const state = stateOf(quoted);
    let block = syntaxTree(state).resolveInner(quoted.indexOf('a'), 1);
    while (block.name !== 'FencedCode') block = block.parent!;
    expect(codeText(state.doc, block)).toBe('a\n  b');
  });
});

describe('rules, HTML blocks, front matter', () => {
  it('a rule hides its dashes unless its line is revealed', () => {
    const t = 'a\n\n---\n\nb\n';
    expect(visibleText(stateOf('‸' + t))).toBe('a\n\n\n\nb\n');
    expect(visibleText(moveTo(stateOf(t), t.indexOf('---')))).toBe(t);
  });

  it('a comment block is removed in Rich view with the blank line after it', () => {
    const t = 'a\n\n<!-- hidden -->\n\nb\n';
    expect(visibleText(stateOf(t, { mode: 'view' }))).toBe('a\n\nb\n');
    expect(visibleText(stateOf('‸' + t, { mode: 'edit' }))).toBe(t);
  });

  it('frontmatter is never drawn as a heading or a rule', () => {
    const text = '---\ntitle: x\n---\nBody\n';
    const state = stateOf(`‸${text}`);
    const end = text.indexOf('Body');
    expect(drawn(state).filter((d) => (d.feature === 'headings' || d.feature === 'rules') && d.from < end)).toEqual([]);
    expect(drawn(state).some((d) => d.feature === 'frontmatter')).toBe(true);
  });
});

describe('spacing', () => {
  const t = 'a\n\n\n\nb\n```\n\n\n```\nc\n';

  it('Rich view removes each run of extra blank lines with one replace', () => {
    const state = stateOf(t, { mode: 'view' });
    const hidden = drawn(state).filter((d) => d.feature === 'spacing' && d.kind === 'hideLines');
    expect(hidden.length).toBe(1);
    expect(visibleText(state).startsWith('a\n\nb\n')).toBe(true);
  });

  it('Rich editor keeps every blank line', () => {
    const state = stateOf('‸' + t, { mode: 'edit' });
    expect(drawn(state).filter((d) => d.feature === 'spacing' && d.kind === 'hideLines')).toEqual([]);
    expect(visibleText(state).startsWith('a\n\n\n\nb\n')).toBe(true);
  });
});

describe('drawn blocks inside quotes', () => {
  it('carry quote classes on math, Mermaid, and HTML blocks and strip quote prefixes from block math', () => {
    const doc = [
      '> $$',
      '> a + b',
      '> $$',
      '',
      '> ```mermaid',
      '> graph TD;',
      '>   A-->B;',
      '> ```',
      '',
      '> <table><tr><td>hi</td></tr></table>',
      '',
    ].join('\n');
    const state = stateOf('‸' + doc, { mode: 'view' });
    const layouts: Record<string, string[]> = {};
    let mathText = '';
    for (const f of drawHeadless(state)) {
      if (!['math', 'diagrams', 'htmlBlocks'].includes(f.feature)) continue;
      f.decorations.between(0, state.doc.length, (_from, _to, deco) => {
        const w = deco.spec.widget as { layout?: string; text?: string } | undefined;
        if (w && typeof w.layout === 'string') {
          (layouts[f.feature] ??= []).push(w.layout);
          if (f.feature === 'math' && typeof w.text === 'string') mathText = w.text;
        }
      });
    }
    expect(layouts['math']?.[0]?.split(' ')).toEqual(expect.arrayContaining(['tm-quote', 'tm-qd1']));
    expect(layouts['diagrams']?.[0]?.split(' ')).toEqual(expect.arrayContaining(['tm-quote', 'tm-qd1']));
    expect(layouts['htmlBlocks']?.[0]?.split(' ')).toEqual(expect.arrayContaining(['tm-quote', 'tm-qd1']));
    expect(mathText.trim()).toBe('a + b');
  });
});

describe('display math blocks with blank lines', () => {
  it('draws a $$ block containing blank lines as one math block', () => {
    const doc = 'Before.\n\n$$\na = 1\n\nb = 2\n$$\n\nAfter.\n';
    const state = stateOf('‸' + doc, { mode: 'view' });
    let drawnMath = '';
    for (const f of drawHeadless(state)) {
      if (f.feature !== 'math') continue;
      f.decorations.between(0, state.doc.length, (_from, _to, deco) => {
        const w = deco.spec.widget as { text?: string } | undefined;
        if (w?.text) drawnMath = w.text;
      });
    }
    expect(drawnMath.trim()).toBe('a = 1\n\nb = 2');
  });

  it('does not swallow the rest of the document when $$ is unclosed', () => {
    const doc = '$$\na = 1\n\nStill normal text.\n';
    const state = stateOf('‸' + doc, { mode: 'view' });
    let count = 0;
    for (const f of drawHeadless(state)) {
      if (f.feature !== 'math') continue;
      f.decorations.between(0, state.doc.length, () => {
        count++;
      });
    }
    expect(count).toBe(0);
    expect(visibleText(state)).toContain('Still normal text.');
  });

  it('matches a fresh parse after incrementally inserting a blank line or closing $$', () => {
    const start = stateOf('‸$$\na = 1\nb = 2\n$$\n', { mode: 'view' });
    const insertAt = start.doc.toString().indexOf('\nb = 2');
    const edited = start.update({ changes: { from: insertAt, insert: '\n' } }).state;
    const fresh = stateOf('‸' + edited.doc.toString(), { mode: 'view' });
    expect(syntaxTree(edited).toString()).toBe(syntaxTree(fresh).toString());
  });

  it('reparses cleanly without hanging when editing a document starting with a blank line', () => {
    const start = stateOf('‸\nParagraph one.\n\nParagraph two.\n', { mode: 'edit' });
    const edited = start.update({ changes: { from: start.doc.length, insert: '\nMore.' } }).state;
    const fresh = stateOf('‸' + edited.doc.toString(), { mode: 'edit' });
    expect(syntaxTree(edited).toString()).toBe(syntaxTree(fresh).toString());
  });
});
