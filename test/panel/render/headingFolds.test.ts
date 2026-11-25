// Heading section folding: folding, unfolding, foldAll/unfoldAll, cursor auto-unfold,
// revealHeading auto-unfold in both Rich editor and Rich view, and incremental edit safety.

import { describe, expect, it } from 'vitest';
import { runCommand } from '../../../src/panel/commands/registry';
import { redrawFeatureEffect } from '../../../src/panel/render/framework';
import { foldedHeadings, toggleHeadingFoldEffect } from '../../../src/panel/render/headingFolds';
import { revealHeadingSpec } from '../../../src/panel/ui/reveal';
import { drawn, standInView, stateOf, visibleText } from '../helpers';

const DOC = ['# One', '', 'Intro text.', '', '## Sub', '', 'Sub body.', '', '# Two', '', 'Second body.', ''].join('\n');

describe('headingFolds', () => {
  it('folds a heading subtree and hides its body lines while keeping later peer headings visible', () => {
    const start = stateOf('‸' + DOC, { mode: 'view' });
    expect(visibleText(start)).toContain('Intro text.');
    expect(visibleText(start)).toContain('Sub body.');

    const folded = start.update({
      effects: [toggleHeadingFoldEffect.of(0), redrawFeatureEffect.of('headingFolds')],
    }).state;
    expect(folded.field(foldedHeadings).has(0)).toBe(true);
    const shown = visibleText(folded);
    expect(shown).toContain('One');
    expect(shown).not.toContain('Intro text.');
    expect(shown).not.toContain('Sub body.');
    expect(shown).toContain('Two');
    expect(shown).toContain('Second body.');

    const unfolded = folded.update({
      effects: [toggleHeadingFoldEffect.of(0), redrawFeatureEffect.of('headingFolds')],
    }).state;
    expect(unfolded.field(foldedHeadings).size).toBe(0);
    expect(visibleText(unfolded)).toContain('Intro text.');
    expect(visibleText(unfolded)).toContain('Sub body.');
  });

  it('auto-unfolds when the cursor moves into a folded body in Rich editor', () => {
    const start = stateOf('‸' + DOC, { mode: 'edit' });
    const folded = start.update({
      effects: [toggleHeadingFoldEffect.of(0), redrawFeatureEffect.of('headingFolds')],
    }).state;
    expect(folded.field(foldedHeadings).has(0)).toBe(true);

    const subOffset = DOC.indexOf('Sub body.');
    const moved = folded.update({ selection: { anchor: subOffset } }).state;
    expect(moved.field(foldedHeadings).size).toBe(0);
    expect(visibleText(moved)).toContain('Sub body.');
  });

  it('auto-unfolds enclosing sections on revealHeading in both Rich view and Rich editor', () => {
    for (const mode of ['view', 'edit'] as const) {
      const start = stateOf('‸' + DOC, { mode });
      const folded = start.update({
        effects: [toggleHeadingFoldEffect.of(0), redrawFeatureEffect.of('headingFolds')],
      }).state;
      const subHeadingPos = DOC.indexOf('## Sub');
      const revealed = folded.update(revealHeadingSpec(folded, subHeadingPos)).state;
      expect(revealed.field(foldedHeadings).size).toBe(0);
      expect(visibleText(revealed)).toContain('Sub body.');
    }
  });

  it('supports toggleFold, foldAll, and unfoldAll commands cleanly', () => {
    const view = standInView(stateOf('‸' + DOC, { mode: 'edit' }));
    // Put cursor inside `# One` body; toggleFold folds `# One` and moves cursor onto `# One` so it sticks.
    view.dispatch({ selection: { anchor: DOC.indexOf('Intro text.') } });
    expect(runCommand(view, 'toggleFold')).toBe(true);
    expect(view.state.field(foldedHeadings).has(0)).toBe(true);
    expect(visibleText(view.state)).not.toContain('Intro text.');

    // foldAll folds every foldable heading (`# One`, `## Sub`, `# Two`).
    expect(runCommand(view, 'foldAll')).toBe(true);
    expect(view.state.field(foldedHeadings).size).toBe(3);
    expect(visibleText(view.state)).not.toContain('Second body.');

    // unfoldAll restores everything.
    expect(runCommand(view, 'unfoldAll')).toBe(true);
    expect(view.state.field(foldedHeadings).size).toBe(0);
    expect(visibleText(view.state)).toContain('Second body.');
  });

  it('does not add a fold button to an empty heading directly before a peer heading', () => {
    const emptyDoc = '# Empty\n\n# Full\n\nBody.\n';
    const state = stateOf('‸' + emptyDoc, { mode: 'view' });
    const buttons = drawn(state).filter((d) => d.feature === 'headingFolds' && d.kind === 'widget');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.from).toBe(emptyDoc.indexOf('# Full'));
  });
});
