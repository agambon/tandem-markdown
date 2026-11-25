// Wikilinks: `[[Target]]`, `[[Folder/Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`,
// and embeds: `![[image.png]]`. `[[...]]` on one line, with no `[` or `]` inside; it wins over an
// ordinary link because this parser runs before the Link parser, and is never found inside code.
// `WikilinkTextFirst` reads `[[shown text|Target]]`, as Dendron and GitLab wikis write it; an
// embed keeps its target first in either order.
//
// Nodes:
//   Wikilink or Embed    the whole `[[...]]` or `![[...]]`
//     WikilinkMark       `[[` or `![[`, `]]`, and the `|` (or `\|`, as written inside a table)
//     WikilinkTarget     the target, heading included (`Note#Part`); read with `wikilinkOf`
//     WikilinkAlias      the shown text; left out when empty

import { tags } from '@lezer/highlight';
import type { Element, InlineContext, MarkdownConfig } from '@lezer/markdown';
import { CODE_BACKSLASH, CODE_CLOSE_BRACKET, CODE_LF, CODE_OPEN_BRACKET, CODE_PIPE } from '../../core/markdownText';
import { CODE_BANG } from './chars';

function isBlank(cx: InlineContext, from: number, to: number): boolean {
  return cx.slice(from, to).trim() === '';
}

function wikilinkParser(textFirst: boolean) {
  return (cx: InlineContext, next: number, pos: number): number => {
    const start = pos;
    let open = pos;
    if (next === CODE_BANG) {
      if (cx.char(pos + 1) !== CODE_OPEN_BRACKET || cx.char(pos + 2) !== CODE_OPEN_BRACKET) return -1;
      open = pos + 1;
    } else if (next !== CODE_OPEN_BRACKET || cx.char(pos + 1) !== CODE_OPEN_BRACKET) {
      return -1;
    }
    const embed = start !== open;
    const inner = open + 2;
    let bar = -1;
    for (let i = inner; i < cx.end; i++) {
      const ch = cx.char(i);
      if (ch === CODE_LF || ch === CODE_OPEN_BRACKET) return -1;
      if (ch === CODE_PIPE && bar < 0) bar = i;
      if (ch !== CODE_CLOSE_BRACKET) continue;
      if (cx.char(i + 1) !== CODE_CLOSE_BRACKET) return -1;
      const children: Element[] = [cx.elt('WikilinkMark', start, inner)];
      if (bar < 0) {
        if (isBlank(cx, inner, i)) return -1;
        children.push(cx.elt('WikilinkTarget', inner, i));
      } else {
        const barStart = cx.char(bar - 1) === CODE_BACKSLASH && bar - 1 >= inner ? bar - 1 : bar;
        const before = { from: inner, to: barStart };
        const after = { from: bar + 1, to: i };
        const [target, alias] = textFirst && !embed ? [after, before] : [before, after];
        if (isBlank(cx, target.from, target.to)) return -1;
        const parts = [cx.elt('WikilinkTarget', target.from, target.to), cx.elt('WikilinkMark', barStart, bar + 1)];
        if (alias.to > alias.from) parts.push(cx.elt('WikilinkAlias', alias.from, alias.to));
        children.push(...parts.sort((a, b) => a.from - b.from));
      }
      children.push(cx.elt('WikilinkMark', i, i + 2));
      return cx.addElement(cx.elt(embed ? 'Embed' : 'Wikilink', start, i + 2, children));
    }
    return -1;
  };
}

const nodes = [
  { name: 'Wikilink', style: tags.link },
  { name: 'Embed', style: tags.link },
  { name: 'WikilinkMark', style: tags.processingInstruction },
  { name: 'WikilinkTarget', style: tags.url },
  { name: 'WikilinkAlias', style: tags.link },
];

export const Wikilink: MarkdownConfig = {
  defineNodes: nodes,
  parseInline: [{ name: 'Wikilink', parse: wikilinkParser(false), before: 'Link' }],
};

export const WikilinkTextFirst: MarkdownConfig = {
  defineNodes: nodes,
  parseInline: [{ name: 'Wikilink', parse: wikilinkParser(true), before: 'Link' }],
};
