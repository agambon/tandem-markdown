// The tab a title bar Show button acts on, over stand-ins for the groups' active tabs of its file.
import { describe, expect, it } from 'vitest';
import { actionsOnEveryGroup, showTargetOf, type DrawnTab } from '../../../src/host/model/showButtons';

const source = (column: number, markdown = true): DrawnTab => ({ view: 'source', column, markdown });
const richView = (column: number): DrawnTab => ({ view: 'view', column, markdown: true });
const richEditor = (column: number): DrawnTab => ({ view: 'edit', column, markdown: true });

describe('the tab a Show button acts on', () => {
  it('is the one tab it would change, whichever group is active and wherever the user is', () => {
    const tabs = [source(1), richEditor(2)];
    expect(showTargetOf('source', tabs, tabs[0])).toBe(tabs[1]);
    const views = [richView(1), richEditor(2)];
    expect(showTargetOf('edit', views, views[1])).toBe(views[0]);
    expect(showTargetOf('view', views, views[0])).toBe(views[1]);
  });

  it('is the tab the user is in when it would change several', () => {
    const tabs = [source(1), richEditor(2)];
    expect(showTargetOf('view', tabs, tabs[0])).toBe(tabs[0]);
    expect(showTargetOf('view', tabs, tabs[1])).toBe(tabs[1]);
    const sources = [source(1), source(2)];
    expect(showTargetOf('edit', sources, sources[1])).toBe(sources[1]);
  });

  it('is the first by column when it would change several and the user is in none of them', () => {
    const tabs = [richEditor(3), source(2)];
    expect(showTargetOf('view', tabs, undefined)).toBe(tabs[1]);
    const other = richView(1);
    expect(showTargetOf('view', [other, ...tabs], other)).toBe(tabs[1]);
  });

  it('leaves out a Source tab without the rich buttons: a .txt file or untitled plain text', () => {
    const tabs = [source(1, false), richEditor(2)];
    expect(showTargetOf('view', tabs, tabs[0])).toBe(tabs[1]);
    expect(showTargetOf('edit', [source(1, false)], undefined)).toBeUndefined();
  });

  it('is a rich tab when pressed on a rich tab’s title bar, and a Source tab when pressed on another', () => {
    const tabs = [source(1), richEditor(2)];
    expect(showTargetOf('view', tabs, tabs[0], 'rich')).toBe(tabs[1]);
    expect(showTargetOf('view', tabs, tabs[1], 'source')).toBe(tabs[0]);
    const viewing = [source(1), richView(2)];
    expect(showTargetOf('edit', viewing, viewing[0], 'rich')).toBe(viewing[1]);
    expect(showTargetOf('edit', viewing, viewing[1], 'source')).toBe(viewing[0]);
  });

  it('takes the tab the user is in, or the first by column, when two of its kind would both change', () => {
    const sources = [source(1), source(2)];
    expect(showTargetOf('view', sources, sources[1], 'source')).toBe(sources[1]);
    const rich = [richView(1), richEditor(2)];
    expect(showTargetOf('source', rich, rich[0], 'rich')).toBe(rich[0]);
    expect(showTargetOf('source', rich, undefined, 'rich')).toBe(rich[0]);
    const editors = [richEditor(1), richEditor(2)];
    expect(showTargetOf('view', editors, editors[1], 'rich')).toBe(editors[1]);
  });

  it('is none when it would change no tab', () => {
    expect(showTargetOf('view', [richView(1)], undefined)).toBeUndefined();
    expect(showTargetOf('source', [source(1), source(2)], undefined)).toBeUndefined();
    expect(showTargetOf('edit', [], undefined)).toBeUndefined();
    expect(showTargetOf('view', [source(1)], undefined, 'rich')).toBeUndefined();
    expect(showTargetOf('view', [richEditor(1)], undefined, 'source')).toBeUndefined();
  });
});

describe('the title bars VS Code draws the editor actions on', () => {
  const defaults = { location: 'default', showTabs: 'multiple', alwaysShow: false };

  it('are the active group’s alone by default', () => {
    expect(actionsOnEveryGroup(defaults)).toBe(false);
  });

  it('are every group’s with workbench.editor.alwaysShowEditorActions, with tabs or a single tab', () => {
    expect(actionsOnEveryGroup({ ...defaults, alwaysShow: true })).toBe(true);
    expect(actionsOnEveryGroup({ ...defaults, alwaysShow: true, showTabs: 'single' })).toBe(true);
  });

  it('are not every group’s with the actions in the window’s title bar or hidden, or with no tabs', () => {
    expect(actionsOnEveryGroup({ ...defaults, alwaysShow: true, location: 'titleBar' })).toBe(false);
    expect(actionsOnEveryGroup({ ...defaults, alwaysShow: true, location: 'hidden' })).toBe(false);
    expect(actionsOnEveryGroup({ ...defaults, alwaysShow: true, showTabs: 'none' })).toBe(false);
  });
});
