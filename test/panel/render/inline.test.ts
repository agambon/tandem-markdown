import { describe, expect, it } from 'vitest';
import { drawHeadless } from '../headless';
import { moveTo, stateOf, visibleText } from '../helpers';

describe('emphasis and inline code', () => {
  const text = 'Start **bold** and *it* and ~~gone~~ and ==lit== and `code` end.\n';

  it('no mark of a styled phrase is visible when the selection is elsewhere', () => {
    const shown = visibleText(stateOf('‸' + text));
    expect(shown).toBe('Start bold and it and gone and lit and code end.\n');
  });

  it('the marks show when the cursor touches the phrase, at either edge or inside', () => {
    const bold = text.indexOf('**bold**');
    for (const pos of [bold, bold + 4, bold + 8]) {
      expect(visibleText(moveTo(stateOf(text), pos))).toContain('**bold**');
    }
    expect(visibleText(moveTo(stateOf(text), bold + 4))).not.toContain('*it*');
  });

  it('a cursor inside a nested phrase shows only its marks', () => {
    const t = 'a **b *c* d** e';
    const shown = visibleText(moveTo(stateOf(t), t.indexOf('c')));
    expect(shown).toBe('a b *c* d e');
  });

  it('Rich view shows no mark wherever the cursor is', () => {
    const bold = text.indexOf('bold');
    const shown = visibleText(moveTo(stateOf(text, { mode: 'view' }), bold));
    expect(shown).not.toMatch(/\*|~~|==|`/);
  });

  it('an escape shows its character without the backslash unless touched', () => {
    const t = 'A \\*star\\* here';
    expect(visibleText(stateOf('‸' + t))).toBe('A *star* here');
    expect(visibleText(moveTo(stateOf(t), 2))).toBe('A \\*star* here');
  });

  it('an entity CommonMark recognizes shows its character unless touched; any other is text', () => {
    const t = 'A &amp; B &nosuch; C &#8212; D &#x2014; E &nbsp;F';
    const state = stateOf('‸' + t);
    expect(visibleText(state)).toBe('A [EntityChar] B &nosuch; C [EntityChar] D [EntityChar] E [EntityChar]F');
    const chars: string[] = [];
    for (const f of drawHeadless(state)) {
      f.decorations.between(0, state.doc.length, (_from, _to, deco) => {
        const widget = deco.spec.widget as { char?: string } | undefined;
        if (widget?.char !== undefined) chars.push(widget.char);
      });
    }
    expect(chars).toEqual(['&', '\u2014', '\u2014', '\u00a0']);
    expect(visibleText(moveTo(stateOf(t), 3))).toBe('A &amp; B &nosuch; C [EntityChar] D [EntityChar] E [EntityChar]F');
  });

  it('marks inside code are text', () => {
    expect(visibleText(stateOf('Start `**not bold**` end‸'))).toBe('Start **not bold** end');
  });
});

describe('footnotes and inline HTML', () => {
  it("a reference shows its note's number unless touched", () => {
    const t = 'Text[^1] more.\n\n[^1]: Note.\n';
    expect(visibleText(stateOf('‸' + t, { mode: 'view' }))).toContain('Text[FootnoteNumber] more.');
    expect(visibleText(moveTo(stateOf(t), 6))).toContain('Text[^1] more.');
  });

  it('an inline comment is hidden in Rich view and shown in Rich editor', () => {
    const t = 'Before <!-- note --> after.';
    expect(visibleText(stateOf(t, { mode: 'view' }))).toBe('Before  after.');
    expect(visibleText(stateOf('‸' + t, { mode: 'edit' }))).toBe(t);
  });
});
