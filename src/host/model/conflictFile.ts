// Conflict file rendering, Problems warning spots, and status/agent-instruction strings.
// Produces one factual markdown template covering clashes, safe handoffs, and truncated clean-note follows.

import type { ClashPassage, CoreNotice, Place } from '../../core/reconcile/types';
import { localTime } from './timestamp';

// ---------------------------------------------------------------------------
// Types

export type PartFacts =
  | {
      kind: 'clash';
      passages: readonly ClashPassage[];
      restMerged: boolean;
      savedOver: boolean;
      backupPath: string | null;
    }
  | {
      kind: 'handoff';
      reason: 'handoff' | 'noBase' | 'truncated' | 'encoding' | 'closedWithPending';
      savedOver: boolean;
      diskText: string | null;
      backupPath: string | null;
    }
  | {
      kind: 'truncatedFollow';
      previousText: string;
      diskText: string;
      backupPath: string | null;
    };

export interface Part {
  n: number;
  time: string;
  facts: PartFacts;
}

export interface ProblemSpot {
  /** Zero-based line number in the note. */
  line: number;
  text: string;
}

export interface ConflictFileDocument {
  note: string;
  closedAt: string | null;
  parts: readonly Part[];
}

// ---------------------------------------------------------------------------
// Status bar, Problems, and Copy Prompt for Agent copy

export const STATUS = 'Tandem: «changes»';
export const STATUS_NAME = 'Tandem';
export const CHANGES_ONE = '1 change';
export const CHANGES_MANY = '«count» changes';
export const STATUS_TIP_ONE = '«conflictFile» tells your agent about «changes» to «note». Click to open it.';
export const STATUS_TIP_MANY = '«count» conflict files tell your agent about «changes». Click to choose one to open.';
export const STATUS_TIP_FILE = '«conflictFile» — «changes»';
export const STATUS_TIP_MORE = '… and «count» more';
export const QUICK_PICK_PLACEHOLDER = 'Choose a conflict file to open';

export const PROBLEMS_SOURCE = 'Tandem Markdown';
export const PROBLEM_LINK = 'conflict file';

export const PROMPT_ONE = 'Tandem Markdown wrote "«conflictFile»" beside "«note»". Read it and do what it says.';
export const PROMPT_MANY =
  'Tandem Markdown wrote a conflict file beside each of «notes» notes. Read each of these files and do what it says: «files».';
export const PROMPT_COPIED = 'A prompt for your agent is on the clipboard.';
export const NOTHING_TO_READ = 'Your agent has nothing to read right now, so no prompt was copied.';

// ---------------------------------------------------------------------------
// Add Agent Instructions copy

export const AGENTS_FILE = 'AGENTS.md';
export const RULE_FILE = '.claude/rules/tandem-markdown.md';
export const OPEN_A_FOLDER = 'Open a folder first, then run Add Agent Instructions.';
export const WHICH_FOLDER = 'Choose the folder to add Tandem Markdown agent instructions to';
export const ADD_TO_FOLDER = 'Add Tandem Markdown agent instructions to «folder»?';
export const ADD_THE_INSTRUCTIONS = 'Add the instructions';
export const INSTRUCTIONS_COPIED = 'The agent instructions are on your clipboard.';
export const LINES_GO = 'These lines go into «places».';
export const AGENTS_PLACE = { new: 'a new AGENTS.md', end: 'the end of AGENTS.md' } as const;
export const RULE_PLACE = {
  new: 'a new .claude/rules/tandem-markdown.md that Claude Code reads for markdown files',
  other: '.claude/rules/tandem-markdown.md, replacing what this command wrote there before',
} as const;
export const CLAUDE_MD_UNCHANGED = 'CLAUDE.md and .gitignore are not changed.';
export const AGENTS_HAS = 'AGENTS.md already has them.';
export const RULE_HAS = '.claude/rules/tandem-markdown.md already has them.';
export const AGENTS_EDITED =
  'AGENTS.md has a section "Tandem Markdown" that was changed by hand, so it is left as it is.';
export const AGENTS_LINK = 'AGENTS.md is a link to another file, so it is left as it is.';
export const AGENTS_HARD_LINK = 'AGENTS.md is linked to another file (a hard link), so it is left as it is.';
export const AGENTS_NOT_UTF8 = 'AGENTS.md is not saved as UTF-8 text, so it is left as it is.';

export const INSTRUCTIONS_WRITTEN = 'AGENTS.md and .claude/rules/tandem-markdown.md now have the instructions.';
export const ALREADY_BOTH = 'AGENTS.md and .claude/rules/tandem-markdown.md already have the instructions.';
export const AGENTS_LEFT = 'AGENTS.md was left as it is, because «why»; .claude/rules/tandem-markdown.md «rule».';
export const AGENTS_LEFT_BECAUSE = {
  edited: 'its Tandem Markdown section was edited by hand',
  link: 'it is a link to another file',
  linked: 'it is linked to another file (a hard link)',
  notUtf8: "it isn't saved as UTF-8",
} as const;
export const RULE_NOW = {
  written: 'now has the instructions',
  had: 'already has the instructions',
} as const;
export const ONE_NOT_WRITTEN = '«written» now has the instructions, but «reason»; «todo»';
export const NONE_WRITTEN = 'Nothing was written, because «reason»; «todo»';
export const RUN_AGAIN = '«what», then run Add Agent Instructions again.';
export const ON_CLIPBOARD_INSTEAD = 'the instructions are on your clipboard instead, to add by hand where you can.';
export const WRITE_FAILED = {
  denied: {
    file: "Tandem Markdown isn't allowed to write «path»",
    folder: "Tandem Markdown isn't allowed to write in «path»",
    what: 'make sure that folder can be written to',
  },
  busy: {
    file: '«path» is in use by another program',
    folder: '«path» is in use by another program',
    what: 'close it there',
  },
  readOnly: {
    file: "«path» is on a drive that can't be written to",
    folder: "«path» is on a drive that can't be written to",
    what: null,
  },
  full: { file: 'the disk holding «path» is full', folder: 'the disk holding «path» is full', what: 'free some space' },
  other: {
    file: '«path» could not be written («code»)',
    folder: '«path» could not be written («code»)',
    what: 'make sure it can be written to',
  },
} as const;

export const INSTRUCTIONS_HEADING = '## Tandem Markdown';
export const INSTRUCTIONS = `## Tandem Markdown

Markdown files here may be open in the Tandem Markdown editor while you edit
them, and your edits are merged into the open note automatically. Two habits
keep that working:

- Read a note again just before you write to it.
- Before and after you write to a note, look for a file beside it with the same
  name plus ".conflict" (for "Field notes.md", "Field notes.md.conflict"). If it
  is there, read it and do what it says before going on.
`;

export const RULE_HEADER = `---
paths:
  - "**/*.md"
  - "**/*.markdown"
  - "**/*.txt"
---

`;

// ---------------------------------------------------------------------------
// Building parts and Problems spots from CoreNotice

const MAX_QUOTE_LINES = 40;
const MAX_QUOTE_CHARS = 2000;
const EDGE_LINES = 10;

export function partTime(date: Date): string {
  const t = localTime(date);
  return `${t.year}-${t.month}-${t.day} ${t.hours}:${t.minutes}`;
}

export function partForNotice(
  notice: CoreNotice,
): { facts: PartFacts; problems: ProblemSpot[]; backup: string | null } | null {
  switch (notice.kind) {
    case 'conflict': {
      if (notice.reason === 'clash' && notice.passages.length > 0) {
        return {
          facts: {
            kind: 'clash',
            passages: notice.passages,
            restMerged: notice.restMerged,
            savedOver: notice.savedOver,
            backupPath: notice.backupPath,
          },
          problems: notice.passages.map((p) => ({
            line: p.lineNumber,
            text: 'Both you and another program edited here; your text was kept.',
          })),
          backup: notice.backupPath,
        };
      }
      const problemMsg =
        notice.reason === 'noBase'
          ? 'Another program changed this note while you had unsaved changes from an earlier session; your text was kept.'
          : notice.reason === 'truncated'
            ? 'Another program left this file cut short while you had unsaved changes; your text was kept.'
            : notice.reason === 'encoding'
              ? 'Another program changed this file in an encoding Tandem Markdown could not merge; your text was kept.'
              : 'Another program changed this note in a way Tandem Markdown could not safely merge; your text was kept.';
      return {
        facts: {
          kind: 'handoff',
          reason: notice.reason === 'clash' ? 'handoff' : notice.reason,
          savedOver: notice.savedOver,
          diskText: notice.diskText,
          backupPath: notice.backupPath,
        },
        problems: [{ line: 0, text: problemMsg }],
        backup: notice.backupPath,
      };
    }

    case 'truncatedFollow':
      return {
        facts: {
          kind: 'truncatedFollow',
          previousText: notice.previousText,
          diskText: notice.diskText,
          backupPath: notice.backupPath,
        },
        problems: [
          {
            line: Math.max(0, notice.diskText.split('\n').length - 1),
            text: 'The file on disk looks cut short; your earlier version is backed up.',
          },
        ],
        backup: notice.backupPath,
      };

    case 'closedWithPending':
      return {
        facts: {
          kind: 'handoff',
          reason: 'closedWithPending',
          savedOver: false,
          diskText: notice.diskText,
          backupPath: notice.backupPath,
        },
        problems: [],
        backup: notice.backupPath,
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering the `.conflict` Markdown file

export function conflictFileText(doc: ConflictFileDocument): string {
  const lines: string[] = [
    `# Unsettled changes to "${doc.note}"`,
    '',
    doc.closedAt === null
      ? `"${doc.note}" is open in Tandem Markdown. Most external edits merge into the user's editor automatically; this file lists what could not be settled automatically.`
      : `"${doc.note}" was closed in Tandem Markdown at ${doc.closedAt}. This file lists what could not be settled automatically before it closed.`,
    '',
    'If you are the user, this file is for your AI agent: ask it to read this file.',
    'Nothing has been lost: every text involved is quoted below or kept in a backup.',
    `To finish: read "${doc.note}" again, apply any changes still needed directly in "${doc.note}", then delete this file. Do not edit this file.`,
  ];

  for (const part of doc.parts) {
    lines.push('', ...renderPart(part, doc.note));
  }

  return `${lines.join('\n')}\n`;
}

function renderPart(part: Part, note: string): string[] {
  const f = part.facts;
  switch (f.kind) {
    case 'clash': {
      const out = [
        `## ${part.n}. Overlapping edits (${part.time})`,
        '',
        f.savedOver
          ? `Both you and the user edited the same text in "${note}", and the user's save wrote over the file on disk. The user's text was kept at the clash${f.restMerged ? '; your other non-overlapping edits were merged in' : ''}.`
          : `Both you and the user edited the same text in "${note}". The user's text was kept at the clash${f.restMerged ? '; your other non-overlapping edits were merged in' : ''}.`,
      ];
      if (f.backupPath) out.push('', `Full disk version backup: \`${f.backupPath}\``);
      for (const p of f.passages) {
        out.push(
          '',
          `### Line ${p.lineNumber + 1} (${placeLabel(p)})`,
          '',
          'User kept:',
          ...quoteBlock(p.yours, '(deleted)'),
          '',
          'Your version on disk:',
          ...quoteBlock(p.theirs, '(deleted)'),
        );
      }
      return out;
    }

    case 'handoff': {
      const titles: Record<typeof f.reason, string> = {
        handoff: 'Could not merge safely',
        noBase: 'Changed while note had unsaved edits from a previous session',
        truncated: 'File on disk was cut short',
        encoding: 'Unreadable or non-UTF encoding change on disk',
        closedWithPending: 'Unmerged change pending when note closed',
      };
      const explanations: Record<typeof f.reason, string> = {
        handoff: `An external write to "${note}" could not be merged safely without risking unsaved user edits, so the user's editor text was left untouched.`,
        noBase: `The user reopened "${note}" with unsaved edits from an earlier session, and the file on disk had changed, so the user's editor text was left untouched.`,
        truncated: `"${note}" on disk stayed cut short after a retry while the user had unsaved edits, so the user's editor text was left untouched.`,
        encoding: `"${note}" on disk changed in bytes or an encoding that could not be decoded cleanly, so the user's editor text was left untouched.`,
        closedWithPending: `An external write to "${note}" was still waiting to merge when the note closed.`,
      };
      const out = [`## ${part.n}. ${titles[f.reason]} (${part.time})`, '', explanations[f.reason]];
      if (f.savedOver) out.push('', 'A save from the user subsequently overwrote the file on disk.');
      if (f.backupPath) out.push('', `Disk version backup: \`${f.backupPath}\``);
      if (f.diskText !== null) {
        out.push('', 'Version on disk:', ...quoteBlock(f.diskText, '(empty file)'));
      }
      return out;
    }

    case 'truncatedFollow': {
      const out = [
        `## ${part.n}. File on disk looks cut short (${part.time})`,
        '',
        `"${note}" had no unsaved edits, so the editor followed the file on disk, but the file remained cut short after a retry. Check whether the end of "${note}" was lost unintentionally and restore what is needed.`,
      ];
      if (f.backupPath) out.push('', `Earlier version backup: \`${f.backupPath}\``);
      out.push(
        '',
        'Earlier version before the cut:',
        ...quoteBlock(f.previousText, '(empty)'),
        '',
        'Current version on disk:',
        ...quoteBlock(f.diskText, '(empty file)'),
      );
      return out;
    }
  }
}

function placeLabel(place: Place): string {
  if (place.at === 'start') return 'at the start of the file';
  if (place.at === 'end') return 'at the end of the file';
  const snippet = (place.line ?? '').trim();
  const short = snippet.length > 60 ? `${snippet.slice(0, 60)}…` : snippet;
  return `after "${short}"`;
}

function quoteBlock(text: string, emptyLabel: string): string[] {
  if (text === '') return [emptyLabel];
  const rawLines = text.split('\n');
  let display = rawLines;
  if (rawLines.length > MAX_QUOTE_LINES || text.length > MAX_QUOTE_CHARS) {
    display = [
      ...rawLines.slice(0, EDGE_LINES),
      `... (${rawLines.length - EDGE_LINES * 2} lines omitted; see backup for full text) ...`,
      ...rawLines.slice(-EDGE_LINES),
    ];
  }
  const fence = fenceFor(display);
  return [fence, ...display, fence];
}

function fenceFor(lines: readonly string[]): string {
  let maxTicks = 2;
  for (const line of lines) {
    const m = /^(`+)/.exec(line.trimStart());
    if (m && m[1]!.length > maxTicks) maxTicks = m[1]!.length;
  }
  return '`'.repeat(maxTicks + 1);
}
