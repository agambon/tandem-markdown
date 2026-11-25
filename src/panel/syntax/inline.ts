// Marks inside a line and in lists: one tilde, comments, other task marks, colored highlight.

import { Subscript, Superscript } from '@lezer/markdown';
import { PercentComments } from '../markdown/comment';
import { TaskMarks } from '../markdown/taskMark';
import { OneTildeStrike, TildeAndCaret } from '../markdown/tilde';
import { OFF, type Syntax } from './types';

export const INLINE = [
  {
    id: 'tilde',
    default: 'both',
    description:
      "How to read a pair of single tildes or carets. `both` reads each pair as the program that writes it means it: one straight after a letter, a digit or a closing bracket (`)`, `]` or `}`) with no space inside (`H~2~O`, `x~i~`, `x^2^`) is subscript or superscript, as Pandoc, Quarto, Typora and Joplin read them, and any other `~text~` is struck through by GitHub's rule, so `~5 to ~10` stays text; `strikethrough` strikes every `~text~` through, as GitHub does; `subscript` reads every pair with no space inside as subscript or superscript, as Pandoc does; `off` shows them as typed. A space escaped with a backslash counts as no space, an escaped tilde or caret is text, and nothing in code is read. Two tildes always strike through.",
    choices: [
      {
        value: 'both',
        description:
          '`H~2~O` and `x^2^` as subscript and superscript, as Pandoc draws them, and any other `~text~` struck through, as GitHub draws it.',
        parse: [TildeAndCaret],
        draw: [],
      },
      {
        value: 'strikethrough',
        description: '`~text~` struck through, as GitHub draws it.',
        parse: [OneTildeStrike],
        draw: [],
      },
      {
        value: 'subscript',
        description: '`H~2~O` and `x^2^` as subscript and superscript, as Pandoc draws them.',
        parse: [Subscript, Superscript],
        draw: [],
      },
      { value: OFF, description: 'As typed.', parse: [], draw: [] },
    ],
  },
  {
    id: 'comments',
    default: true,
    description:
      "Fade Obsidian's comments, `%%text%%` and blocks between `%%` lines, in the Rich editor, and hide them in Rich view.",
    parse: [PercentComments],
    draw: ['comments'],
  },
  {
    id: 'taskMarks',
    default: true,
    description:
      'Draw tasks with another mark in the box, such as `- [?]` and `- [-]` (Obsidian), as boxes showing the mark. A click does not check them.',
    parse: [TaskMarks],
    draw: [],
  },
  {
    id: 'highlightColors',
    default: true,
    description:
      "Draw a highlight whose text starts with a color emoji, such as `==🔴Important==`, in that color, the emoji hidden (Obsidian's six colors; Bear writes five of them).",
    parse: [],
    draw: [],
  },
] as const satisfies readonly Syntax[];
