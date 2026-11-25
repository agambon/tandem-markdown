// Blocks drawn in place of their source: diagrams, a contents list, embedded notes, git's
// conflicts; and the block ids an embed or a link names a block by.

import { ConflictMarkers } from '../markdown/conflictMarkers';
import type { Syntax } from './types';

export const DRAWN = [
  {
    id: 'mermaid',
    default: true,
    description: 'Draw `mermaid` code blocks as Mermaid diagrams.',
    parse: [],
    draw: ['diagrams'],
    fences: ['mermaid'],
  },
  {
    id: 'contents',
    default: true,
    description:
      "Draw `[TOC]`, `[toc]`, `[[_TOC_]]` or `[[toc]]` (VitePress, in any letter case) on a line of its own as a list of the file's headings. `[[toc]]` stays a link when a note named toc answers it.",
    parse: [],
    draw: ['contents'],
  },
  {
    id: 'embeds',
    default: true,
    description:
      'Draw a note embedded with `![[Note]]`, `![[Note#Heading]]` or `![[Note#^id]]` on a line of its own as that note, its section or its block, read-only. Needs wikilinks.',
    parse: [],
    draw: ['embeds'],
  },
  {
    id: 'blockIds',
    default: true,
    description:
      'Fade a block id such as `^quote-1` at the end of a paragraph in Rich editor, and hide it in Rich view.',
    parse: [],
    draw: ['blockIds'],
  },
  {
    id: 'conflictMarkers',
    default: true,
    description:
      "Draw git's conflict markers, a block from a `<<<<<<<` line to a `>>>>>>>` line, as one conflict with its sides labeled and buttons to keep either side or both. Off, the lines are read as any other markdown.",
    parse: [ConflictMarkers],
    draw: ['conflicts'],
  },
] as const satisfies readonly Syntax[];
