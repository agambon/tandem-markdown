// The toolbar's pressed states, read headless (the bar itself is checked in Chrome by
// harness/tests/editing.spec.mjs).

import { describe, expect, it } from 'vitest';
import { formatsAt, type Formats } from '../../../src/panel/ui/toolbar';
import { stateWith } from '../commands/helpers';

function on(text: string): Partial<Formats> {
  const f = formatsAt(stateWith(text));
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== false && v !== 0));
}

describe('what the toolbar shows pressed', () => {
  const cases: [string, string, Partial<Formats>][] = [
    ['nothing in plain text', 'Plain te‸xt', {}],
    ['Bold inside bold', 'a **bo‸ld** b', { bold: true }],
    ['not Bold just after the bold', 'a **bold**‸ b', {}],
    ['Bold and Italic inside both', '***bo‸th***', { bold: true, italic: true }],
    ['Inline code inside a code span', 'a `co‸de` b', { code: true }],
    ['Link inside a link', '[te‸xt](https://x.y)', { link: true }],
    ['Bullet list on an item', '- It‸em', { bullet: true }],
    ["Bullet list on an item's second line", '- Item\n  mo‸re', { bullet: true }],
    ['Numbered list on a numbered item', '1. It‸em', { ordered: true }],
    ['Task list on a task', '- [ ] Ta‸sk', { task: true }],
    ['Quote in a quote', '> Quo‸te', { quote: true }],
    ['Code block in a fence', '```\nco‸de\n```', { codeBlock: true }],
    ['the heading level on a heading', '## Ti‸tle', { heading: 2 }],
    ['the heading level on a Setext heading', 'Ti‸tle\n---', { heading: 2 }],
    ['a selection inside bold', '**a «b» c**', { bold: true }],
  ];
  for (const [name, text, expected] of cases) it(name, () => expect(on(text)).toEqual(expected));
});
