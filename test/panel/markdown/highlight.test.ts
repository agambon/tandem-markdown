import { describe, expect, it } from 'vitest';
import { find } from './treeHelpers';

describe('highlight', () => {
  it('reads ==text== with its marks', () => {
    expect(find('a ==b c== d', 'Highlight', 'HighlightMark').map((n) => `${n.name}:${n.text}`)).toEqual([
      'Highlight:==b c==',
      'HighlightMark:==',
      'HighlightMark:==',
    ]);
  });

  it('nests with emphasis', () => {
    expect(find('==**b**==', 'Highlight', 'StrongEmphasis').map((n) => n.name)).toEqual([
      'Highlight',
      'StrongEmphasis',
    ]);
  });

  it('follows the strikethrough flanking rules', () => {
    expect(find('a == b == c', 'Highlight')).toEqual([]);
    expect(find('x==y==z', 'Highlight').length).toBe(1);
  });

  it('takes a run of exactly two = as a mark, as GitHub takes a run of two ~', () => {
    expect(find('===a===', 'Highlight')).toEqual([]);
    expect(find('==a===', 'Highlight')).toEqual([]);
  });

  it("leaves a grid table's separator row as text", () => {
    expect(find('+===+===+', 'Highlight')).toEqual([]);
    expect(find('+==+==+', 'Highlight')).toEqual([]);
    const grid = ['+-----+-----+', '| a   | b   |', '+=====+=====+', '| 1   | 2   |', '+-----+-----+'].join('\n');
    expect(find(grid, 'Highlight')).toEqual([]);
  });

  it('leaves tracked-change marks as text', () => {
    expect(find('a {==marked==} b', 'Highlight')).toEqual([]);
    expect(find('{==a==}{>>note<<} and ==b==', 'Highlight').map((n) => n.text)).toEqual(['==b==']);
  });

  it('is not read inside code', () => {
    expect(find('`==a==`', 'Highlight')).toEqual([]);
    expect(find('```\n==a==\n```', 'Highlight')).toEqual([]);
  });

  it('a Setext underline stays a heading', () => {
    expect(find('Title\n==', 'SetextHeading1', 'Highlight').map((n) => n.name)).toEqual(['SetextHeading1']);
  });
});
