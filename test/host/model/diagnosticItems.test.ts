// The problems a panel is sent: VS Code's diagnostics as offsets in the panel's LF text.

import { describe, expect, it } from 'vitest';
import { textOf } from '../../../src/core/positions';
import {
  MAX_DIAGNOSTICS,
  MAX_MESSAGE_CHARS,
  diagnosticItems,
  widenEmpty,
  type RawDiagnostic,
} from '../../../src/host/model/diagnosticItems';

const TEXT = '# Title\n\nA mispeled word and a [link](gone.md).\n';

function raw(start: [number, number], end: [number, number], extra: Partial<RawDiagnostic> = {}): RawDiagnostic {
  return {
    range: { start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] } },
    severity: 1,
    message: 'A problem',
    ...extra,
  };
}

describe('the problems a panel is sent', () => {
  it('turns line and character into offsets of the LF text', () => {
    const doc = textOf(TEXT);
    const [item] = diagnosticItems(doc, [raw([2, 2], [2, 10], { source: 'cSpell', code: 'unknown-word' })]);
    expect(TEXT.slice(item!.from, item!.to)).toBe('mispeled');
    expect(item).toMatchObject({ severity: 'warning', source: 'cSpell', code: 'unknown-word' });
  });

  it('holds a range that runs past a line or the text inside the text', () => {
    const doc = textOf(TEXT);
    const [past] = diagnosticItems(doc, [raw([2, 30], [2, 500])]);
    expect(past!.to).toBe(TEXT.indexOf(').') + 2);
    const [beyond] = diagnosticItems(doc, [raw([2, 2], [40, 0])]);
    expect(beyond!.to).toBe(TEXT.length);
  });

  it('widens an empty range to the word it stands in, as VS Code draws one', () => {
    const doc = textOf(TEXT);
    const at = TEXT.indexOf('word') + 2;
    expect(widenEmpty(doc, at)).toEqual({ from: TEXT.indexOf('word'), to: TEXT.indexOf('word') + 4 });
    const [item] = diagnosticItems(doc, [raw([2, 13], [2, 13])]);
    expect(TEXT.slice(item!.from, item!.to)).toBe('word');
  });

  it('widens an empty range with no word to one character beside it, and leaves an empty line empty', () => {
    const doc = textOf(TEXT);
    const paren = TEXT.indexOf('](') + 1;
    expect(widenEmpty(doc, paren)).toEqual({ from: paren, to: paren + 1 });
    const end = TEXT.indexOf(').') + 2;
    expect(widenEmpty(doc, end)).toEqual({ from: end - 1, to: end });
    expect(widenEmpty(doc, TEXT.indexOf('\n\n') + 1)).toEqual({
      from: TEXT.indexOf('\n\n') + 1,
      to: TEXT.indexOf('\n\n') + 1,
    });
  });

  it('names each severity and reads the tags for unused and deprecated text', () => {
    const doc = textOf(TEXT);
    const items = diagnosticItems(doc, [
      raw([0, 2], [0, 7], { severity: 0 }),
      raw([2, 0], [2, 1], { severity: 2, tags: [1] }),
      raw([2, 2], [2, 10], { severity: 3, tags: [2] }),
    ]);
    expect(items.map((i) => i.severity)).toEqual(['error', 'information', 'hint']);
    expect(items.map((i) => [i.unnecessary, i.deprecated])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });

  it('reads a code given as a value with a link, and leaves a missing one empty', () => {
    const doc = textOf(TEXT);
    const items = diagnosticItems(doc, [
      raw([0, 0], [0, 1], { code: { value: 'MD041' } }),
      raw([0, 2], [0, 3], { code: 12 }),
      raw([0, 4], [0, 5]),
    ]);
    expect(items.map((i) => i.code)).toEqual(['MD041', '12', '']);
  });

  it('cuts a long message and ends it with an ellipsis', () => {
    const doc = textOf(TEXT);
    const [item] = diagnosticItems(doc, [raw([0, 0], [0, 1], { message: 'x'.repeat(MAX_MESSAGE_CHARS * 2) })]);
    expect(item!.message.length).toBe(MAX_MESSAGE_CHARS);
    expect(item!.message.endsWith('…')).toBe(true);
  });

  it('keeps at most MAX_DIAGNOSTICS, the most severe first, ordered by where they start', () => {
    const doc = textOf(TEXT);
    const many = Array.from({ length: MAX_DIAGNOSTICS + 50 }, (_, i) => raw([2, i % 20], [2, (i % 20) + 1]));
    many.push(raw([0, 2], [0, 7], { severity: 0, message: 'The one error' }));
    const items = diagnosticItems(doc, many);
    expect(items).toHaveLength(MAX_DIAGNOSTICS);
    expect(items.some((i) => i.message === 'The one error')).toBe(true);
    for (let i = 1; i < items.length; i++) expect(items[i]!.from).toBeGreaterThanOrEqual(items[i - 1]!.from);
  });
});
