// What Use Tandem Markdown by Default and Use Source by Default ask and answer: where each kind of
// markdown file opens now and why, how to undo the change, and where an entry they do not write
// still decides where markdown files open. Which of the words table's sentences each case takes,
// in what order, and what fills them in; the sentences themselves are DEFAULTS_WORDS'.

import { describe, expect, it } from 'vitest';
import { listed } from '../../../src/core/listText';
import {
  afterWriting,
  alreadySet,
  alreadyThere,
  DEFAULTS_WORDS as W,
  fromNowOn,
  type Comparisons,
  type NamedEditor,
  type Now,
  question,
  type RichView,
  settingsToOpen,
  type SourceHeld,
  type Winner,
} from '../../../src/host/model/defaultsWords';
import { fill } from '../../../src/host/model/templates';

const RICH: RichView = { name: 'Rich editor', readOnly: false };
const VIEW: RichView = { name: 'Rich view', readOnly: true };
const FILE = '.vscode/settings.json';
const SOURCE: NamedEditor = { kind: 'source', name: '', label: '' };
const OURS: NamedEditor = { kind: 'rich', name: '', label: '' };
const WRITER: NamedEditor = {
  kind: 'other',
  name: 'Markdown Writer (markdownWriter.editor)',
  label: 'Markdown Writer',
};
const NOTEBOOK: NamedEditor = { kind: 'other', name: 'Docs Notebook (docsNotebook.notebook)', label: 'Docs Notebook' };
const GONE: NamedEditor = { kind: 'other', name: 'gone.editor', label: 'gone.editor' };
/** How VS Code's list of editors names its text editor and this extension's. */
const TEXT_EDITOR_LABEL = 'Text Editor';
const OUR_LABEL = 'Rich Editor';

/** The Rich editor as a screen names it the first time, and after that. */
const RICH_FIRST = fill(W.richFirst, { rich: RICH.name });
const RICH_AGAIN = fill(W.richAgain, { rich: RICH.name });
const MD = fill(W.kindFiles, { kinds: '.md' });
const MARKDOWN = fill(W.kindFiles, { kinds: '.markdown' });
const yours = (files: string) => fill(W.yourFiles, { files });
const both = (first: string, last: string) => listed([first, last]);
/** VS Code's steps that make the editor its list names `label` the default for `pattern`. */
const REOPEN = (pattern: string, label: string) => fill(W.steps, { kind: pattern.slice(1), pattern, label });

const NOTHING_SET: Now[] = [
  { pattern: '*.md', opens: SOURCE, by: 'vscode' },
  { pattern: '*.markdown', opens: SOURCE, by: 'vscode' },
];
/** For Use Source by Default's answers: the command took out entries for another editor for both kinds of markdown file. */
const CLEARED: SourceHeld = { chosen: [], cleared: ['*.md', '*.markdown'] };
/** The same, where the user's settings hold no entry of their own that gives Source. */
const NONE_HELD: SourceHeld = { chosen: [], cleared: [] };

/** Comparisons that stay where they are, for both kinds of markdown file. */
const STAY: Comparisons = { replaced: [], left: [], written: ['*.md', '*.markdown'] };
const RICH_SET: Now[] = [
  { pattern: '*.md', opens: OURS, by: 'settings' },
  { pattern: '*.markdown', opens: OURS, by: 'settings' },
];

const workspaceSource: Winner = {
  level: 'workspace',
  pattern: '*.md',
  editor: SOURCE,
  want: 'tandemMarkdown.editor',
  covers: ['*.md'],
  removable: true,
};
const workspaceOurs: Winner = { ...workspaceSource, editor: OURS, want: 'default' };
const userLonger: Winner = { ...workspaceSource, level: 'user', pattern: '**/*.md', editor: WRITER, removable: false };

/** The workspace's settings file still deciding .md files: where they open, and how to change its entry. */
const workspaceFile = (editor: string, value: string) =>
  [
    fill(W.workspaceStillFile, { files: MD, editor, file: FILE }),
    W.sharedFile,
    fill(W.changeItsEntry, { pattern: '*.md', value }),
    W.whoDecides,
    W.buttonOpensFile,
  ].join(' ');
const OUR_VALUE = fill(W.valueRich, { value: 'tandemMarkdown.editor', rich: RICH_AGAIN });

function detail(...args: Parameters<typeof question>): string {
  return question(...args).detail;
}

describe('the question', () => {
  it('names the Rich editor in full, says what it is, where files open now and how to undo it', () => {
    expect(question('rich', RICH, NOTHING_SET, [], STAY, null, FILE)).toEqual({
      message: fill(W.question, { files: W.markdownFiles, place: RICH_FIRST }),
      detail: [
        fill(W.richEditable, { rich: RICH.name }),
        fill(W.openNow, { files: W.markdownFilesStart, editor: W.sourceFirst }),
        W.linesNotKept,
        W.comparisonsStay,
        fill(W.switchButton, { place: W.source }),
        fill(W.undoCommand, { command: W.command.source }),
      ].join(' '),
      button: fill(W.useRich, { rich: RICH.name }),
    });
  });

  it('says that the Rich view is read-only, and names it in the title and the button', () => {
    const asked = question('rich', VIEW, NOTHING_SET, [], STAY, null, FILE);
    expect(asked.message).toBe(
      fill(W.question, { files: W.markdownFiles, place: fill(W.richFirst, { rich: VIEW.name }) }),
    );
    expect(asked.detail.startsWith(`${fill(W.richReadOnly, { rich: VIEW.name })} `)).toBe(true);
    expect(asked.button).toBe(fill(W.useRich, { rich: VIEW.name }));
  });

  it('names the editor the settings choose for each kind of file, and the steps back to it', () => {
    const now: Now[] = [{ pattern: '*.md', opens: WRITER, by: 'settings' }, NOTHING_SET[1]!];
    const asked = detail('rich', RICH, now, [], STAY, null, FILE);
    expect(asked).toContain(
      `${fill(W.settingsOpenNow, { chosen: fill(W.filesIn, { files: MD, editor: WRITER.name }) })} ` +
        fill(W.openNow, { files: yours(MARKDOWN), editor: W.sourceFirst }),
    );
    expect(asked).toContain(
      fill(W.undoCommandThen, { command: W.command.source, steps: REOPEN('*.md', WRITER.label) }),
    );
  });

  it('gives the steps in a file of each kind where two editors are chosen, and one line for one', () => {
    const two: Now[] = [
      { pattern: '*.md', opens: WRITER, by: 'settings' },
      { pattern: '*.markdown', opens: NOTEBOOK, by: 'settings' },
    ];
    expect(detail('rich', RICH, two, [], STAY, null, FILE)).toContain(
      fill(W.undoSteps, {
        steps: `${REOPEN('*.md', WRITER.label)}, ${fill(W.stepsAgain, { kind: '.markdown', label: NOTEBOOK.label })}`,
      }),
    );
    const same: Now[] = two.map((n) => ({ ...n, opens: WRITER }));
    expect(detail('rich', RICH, same, [], STAY, null, FILE)).toContain(
      fill(W.settingsOpenNow, { chosen: fill(W.filesIn, { files: W.markdownFiles, editor: WRITER.name }) }),
    );
  });

  it('says where files open where VS Code passes over the editor the settings choose', () => {
    const now: Now[] = [{ ...NOTHING_SET[0]!, passedOver: GONE }, NOTHING_SET[1]!];
    const asked = detail('rich', RICH, now, [], STAY, null, FILE);
    expect(asked).toContain(
      `${fill(W.passedOver, { passed: GONE.name, files: MD, editor: W.sourceFirst })} ` +
        fill(W.openNow, { files: yours(MARKDOWN), editor: W.source }),
    );
    expect(asked.endsWith(fill(W.undoCommand, { command: W.command.source }))).toBe(true);
  });

  it('names an editor that opens markdown files by itself', () => {
    const now: Now[] = [{ pattern: '*.md', opens: NOTEBOOK, by: 'itself' }, NOTHING_SET[1]!];
    expect(detail('rich', RICH, now, [], STAY, null, FILE)).toContain(
      fill(W.opensByItself, { editor: NOTEBOOK.name, files: MD }),
    );
  });

  it('gives the steps where the other command would also change a kind of file this one kept', () => {
    const now: Now[] = [{ pattern: '*.md', opens: SOURCE, by: 'settings' }];
    expect(
      detail('rich', RICH, now, ['*.markdown'], STAY, null, FILE).endsWith(
        fill(W.undoSteps, { steps: REOPEN('*.md', TEXT_EDITOR_LABEL) }),
      ),
    ).toBe(true);
  });

  it('names the comparisons editors it replaces, which VS Code passes over', () => {
    expect(detail('rich', RICH, NOTHING_SET, [], { ...STAY, replaced: [GONE] }, null, FILE)).toContain(
      `${W.comparisonsStay} ${fill(W.replacesOne, { editors: GONE.name })}`,
    );
    expect(
      detail('rich', RICH, NOTHING_SET, [], { ...STAY, replaced: [GONE, { ...GONE, name: 'also.gone' }] }, null, FILE),
    ).toContain(fill(W.replacesMany, { editors: both(GONE.name, 'also.gone') }));
  });

  it('says where only comparisons change, and how to undo that', () => {
    const asked = detail('rich', RICH, [], [], STAY, null, FILE);
    expect(asked).toContain(`${fill(W.onlyComparisons, { files: W.markdownFiles, rich: RICH_AGAIN })} `);
    expect(asked.endsWith(fill(W.undoComparisons, { patterns: both('*.md', '*.markdown') }))).toBe(true);
  });

  it('says that comparisons leave the Rich editor where a VS Code release opens them there now', () => {
    expect(detail('rich', RICH, [], [], { ...STAY, left: [OURS] }, null, FILE)).toContain(
      fill(W.comparisonsLeave, { editors: RICH_AGAIN }),
    );
  });

  it('names each editor comparisons leave where workspace folders open the files in different ones', () => {
    expect(detail('rich', RICH, [], [], { ...STAY, left: [OURS, WRITER] }, null, FILE)).toContain(
      fill(W.comparisonsLeave, { editors: both(RICH_AGAIN, WRITER.name) }),
    );
    expect(detail('rich', RICH, NOTHING_SET, [], { ...STAY, left: [WRITER] }, null, FILE)).toContain(
      fill(W.comparisonsLeave, { editors: WRITER.name }),
    );
  });

  it('says this workspace keeps its own editor, and that the message after says how to change it', () => {
    expect(detail('rich', RICH, NOTHING_SET, [], STAY, workspaceSource, FILE)).toContain(
      fill(W.workspaceWillStayFile, { files: MD, editor: W.source, file: FILE }),
    );
    expect(detail('rich', RICH, NOTHING_SET, [], STAY, workspaceSource, null)).toContain(
      fill(W.workspaceWillStayOwn, { files: MD, editor: W.source }),
    );
  });

  it('names only the files it reaches where a longer entry of the user’s keeps the others, and why', () => {
    const asked = question('rich', RICH, [NOTHING_SET[1]!], [], STAY, userLonger, FILE);
    expect(asked.message).toBe(fill(W.question, { files: MARKDOWN, place: RICH_FIRST }));
    const stays = fill(W.willStay, { files: yours(MD), editor: WRITER.name, whose: W.userChoose, pattern: '**/*.md' });
    expect(asked.detail.startsWith(`${stays} ${fill(W.richEditable, { rich: RICH.name })}`)).toBe(true);
  });

  it('for Source, names the Rich editor it replaces and the command that undoes it', () => {
    expect(question('source', RICH, RICH_SET, [], STAY, null, FILE)).toEqual({
      message: fill(W.question, { files: W.markdownFiles, place: W.sourceFirst }),
      detail: [
        fill(W.settingsOpenNow, { chosen: fill(W.filesIn, { files: W.markdownFiles, editor: RICH_FIRST }) }),
        fill(W.switchButton, { place: RICH_AGAIN }),
        fill(W.undoCommand, { command: W.command.rich }),
      ].join(' '),
      button: W.useSource,
    });
  });

  it('for Source, says that removing an editor VS Code passes over changes nothing it opens', () => {
    const now: Now[] = [{ ...NOTHING_SET[0]!, passedOver: GONE }];
    const asked = detail('source', RICH, now, ['*.markdown'], STAY, null, FILE);
    expect(asked).toContain(fill(W.passedOverRemoved, { passed: GONE.name, files: MD, editor: W.source }));
    expect(asked.endsWith(fill(W.chooseAgain, { steps: REOPEN('*.md', W.chooseIt) }))).toBe(true);
  });

  it('for Source, gives the steps back to Tandem Markdown where the other command would change more', () => {
    expect(
      detail('source', RICH, [RICH_SET[0]!], ['*.markdown'], STAY, null, FILE).endsWith(
        fill(W.undoSteps, { steps: REOPEN('*.md', OUR_LABEL) }),
      ),
    ).toBe(true);
  });
});

describe("the undo where the workspace's settings set where files open", () => {
  /** The undo by hand: each pattern's entry set back to `entry`, or taken out where it is null. */
  const byHand = (...entries: [string, string | null][]) =>
    fill(W.undoByHand, {
      changes: listed(
        entries.map(([pattern, entry]) =>
          entry === null ? fill(W.entryOut, { pattern }) : fill(W.entryBack, { pattern, entry }),
        ),
      ),
    });

  it("gives the user settings' entries to edit, never VS Code's steps, which would write the workspace's", () => {
    const now: Now[] = [
      { pattern: '*.md', opens: WRITER, by: 'settings', entry: 'markdownWriter.editor' },
      NOTHING_SET[1]!,
    ];
    const asked = detail('rich', RICH, now, [], STAY, null, FILE, true);
    expect(asked.endsWith(byHand(['*.md', 'markdownWriter.editor'], ['*.markdown', null]))).toBe(true);
    expect(asked).not.toContain(REOPEN('*.md', WRITER.label));
  });

  it('for Source, gives the entry back for an editor VS Code passes over', () => {
    const now: Now[] = [{ ...NOTHING_SET[0]!, passedOver: GONE, entry: 'gone.editor' }];
    expect(
      detail('source', RICH, now, ['*.markdown'], STAY, null, FILE, true).endsWith(byHand(['*.md', 'gone.editor'])),
    ).toBe(true);
  });

  it('still names the other command where it undoes the change, since it writes the user settings', () => {
    expect(detail('rich', RICH, NOTHING_SET, [], STAY, null, FILE, true)).toContain(
      fill(W.undoCommand, { command: W.command.source }),
    );
  });
});

describe('the answers when nothing else decides', () => {
  it('confirms what now opens markdown files, and that open tabs stay', () => {
    expect(fromNowOn('rich', RICH, NONE_HELD)).toBe(
      `${fill(W.nowOpenRich, { files: W.markdownFiles, rich: RICH_FIRST })} ${W.tabsStay}`,
    );
    expect(fromNowOn('source', RICH, CLEARED)).toBe(
      `${fill(W.nowOpenCleared, { files: W.markdownFilesStart, source: W.sourceFirst })} ${W.tabsStay}`,
    );
  });

  it('for Source, says what the command did to each kind: set Source, or took out another editor', () => {
    expect(fromNowOn('source', RICH, { chosen: ['*.md'], cleared: [] })).toBe(
      `${fill(W.nowOpenChosen, { files: MD, source: W.sourceFirst })} ${W.tabsStay}`,
    );
    expect(fromNowOn('source', RICH, { chosen: ['*.markdown'], cleared: ['*.md'] })).toBe(
      [
        fill(W.nowOpenCleared, { files: yours(MD), source: W.sourceFirst }),
        fill(W.nowOpenChosen, { files: MARKDOWN, source: W.source }),
        W.tabsStay,
      ].join(' '),
    );
  });

  it('says that nothing was changed, and why', () => {
    expect(alreadyThere('rich', RICH, NONE_HELD)).toBe(
      fill(W.alreadyByUser, { files: W.markdownFiles, place: RICH_FIRST }),
    );
    expect(alreadyThere('source', RICH, NONE_HELD)).toBe(
      fill(W.alreadyByNone, { files: W.markdownFiles, source: W.sourceFirst }),
    );
  });

  it('for Source, says the user settings open the files there where an entry of theirs decides', () => {
    expect(alreadyThere('source', RICH, { chosen: ['*.md', '*.markdown'], cleared: [] })).toBe(
      fill(W.alreadyByUser, { files: W.markdownFiles, place: W.sourceFirst }),
    );
    expect(alreadyThere('source', RICH, { chosen: ['*.md'], cleared: [] })).toBe(
      fill(W.alreadyMixed, { files: W.markdownFiles, source: W.sourceFirst, chosen: MD, none: MARKDOWN }),
    );
  });
});

describe('the answers when an entry the command does not write still decides', () => {
  it("confirms the change, then names the workspace's file, the value to set, and what each choice does", () => {
    expect(afterWriting('rich', RICH, workspaceSource, FILE, NONE_HELD)).toBe(
      `${fill(W.nowOpenRich, { files: W.markdownFiles, rich: RICH_FIRST })} ${workspaceFile(W.sourceFirst, OUR_VALUE)}`,
    );
    expect(afterWriting('source', RICH, workspaceOurs, FILE, CLEARED)).toBe(
      `${fill(W.nowOpenCleared, { files: W.markdownFilesStart, source: W.sourceFirst })} ` +
        workspaceFile(RICH_FIRST, fill(W.valueSource, { value: 'default', source: W.source })),
    );
  });

  it("says of an untitled workspace's own settings that the button opens them", () => {
    expect(afterWriting('rich', RICH, workspaceSource, null, NONE_HELD)).toBe(
      `${fill(W.nowOpenRich, { files: W.markdownFiles, rich: RICH_FIRST })} ` +
        fill(W.workspaceStillOwn, { files: MD, editor: W.sourceFirst, pattern: '*.md', value: OUR_VALUE }),
    );
  });

  it('confirms only what changed, then names the user’s longer entry, why it wins, and what to set', () => {
    const stays = fill(W.stillOpen, { files: yours(MD), editor: WRITER.name, whose: W.userChoose, pattern: '**/*.md' });
    expect(afterWriting('rich', RICH, userLonger, FILE, NONE_HELD)).toBe(
      [
        fill(W.nowOpenRich, { files: MARKDOWN, rich: RICH_FIRST }),
        stays,
        fill(W.changeEntry, { place: RICH_AGAIN, want: 'tandemMarkdown.editor' }),
      ].join(' '),
    );
    expect(
      afterWriting('rich', RICH, { ...userLonger, removable: true }, FILE, NONE_HELD).endsWith(
        fill(W.changeOrRemoveEntry, { place: RICH_AGAIN, want: 'tandemMarkdown.editor' }),
      ),
    ).toBe(true);
  });

  it("names a default's entry, the line to add over it in the user's settings, and where those are", () => {
    const stays = (whose: string) =>
      fill(W.stillOpen, { files: yours(MD), editor: WRITER.name, whose, pattern: '**/*.md' });
    expect(
      afterWriting('rich', RICH, { ...userLonger, level: 'default', extension: 'Notes Kit' }, FILE, NONE_HELD),
    ).toBe(
      [
        fill(W.nowOpenRich, { files: MARKDOWN, rich: RICH_FIRST }),
        stays(fill(W.extensionChooses, { extension: 'Notes Kit' })),
        fill(W.addLine, { place: RICH_AGAIN, pattern: '**/*.md', want: 'tandemMarkdown.editor' }),
      ].join(' '),
    );
    expect(afterWriting('rich', RICH, { ...userLonger, level: 'default' }, FILE, NONE_HELD)).toContain(
      stays(W.defaultChooses),
    );
  });

  it('says that nothing was changed, then names what still decides in this workspace', () => {
    expect(
      alreadySet('rich', RICH, workspaceSource, FILE, NONE_HELD).startsWith(
        `${fill(W.alreadyByUser, { files: W.markdownFiles, place: RICH_FIRST })} ` +
          fill(W.workspaceStillFile, { files: MD, editor: W.sourceFirst, file: FILE }),
      ),
    ).toBe(true);
    expect(
      alreadySet('source', RICH, workspaceOurs, FILE, NONE_HELD).startsWith(
        `${fill(W.alreadyByNone, { files: W.markdownFiles, source: W.sourceFirst })} ` +
          fill(W.workspaceStillFile, { files: MD, editor: RICH_FIRST, file: FILE }),
      ),
    ).toBe(true);
  });

  it('says only that nothing was changed where a longer entry decides every markdown file', () => {
    const every: Winner = {
      ...userLonger,
      pattern: '*.{md,markdown}',
      want: 'default',
      covers: ['*.md', '*.markdown'],
      removable: true,
    };
    expect(alreadySet('source', RICH, every, FILE, NONE_HELD)).toBe(
      [
        W.nothingChanged,
        fill(W.stillOpen, {
          files: W.markdownFilesStart,
          editor: WRITER.name,
          whose: W.userChoose,
          pattern: '*.{md,markdown}',
        }),
        fill(W.changeOrRemoveEntry, { place: W.sourceFirst, want: 'default' }),
      ].join(' '),
    );
  });

  it('names by its pattern an entry that decides only some files of a kind, opening the sentence with it', () => {
    const matching = fill(W.filesMatching, { pattern: '**/docs/**/*.md' });
    const opening = `${matching.charAt(0).toUpperCase()}${matching.slice(1)}`;
    expect(
      afterWriting('rich', RICH, { ...userLonger, pattern: '**/docs/**/*.md', covers: [] }, FILE, NONE_HELD),
    ).toContain(
      fill(W.stillOpen, { files: opening, editor: WRITER.name, whose: W.userChoose, pattern: '**/docs/**/*.md' }),
    );
  });
});

describe("the answer's button", () => {
  it("opens the workspace's settings where its entry decides, else the user's, else none", () => {
    expect(settingsToOpen(workspaceSource)).toBe('workspace');
    expect(settingsToOpen(userLonger)).toBe('user');
    expect(settingsToOpen({ ...userLonger, level: 'default' })).toBeNull();
    expect(settingsToOpen(null)).toBeNull();
  });
});
