import { describe, expect, it } from 'vitest';
import { pairWrappers, readHtmlBlock, readTags, type TagBlock } from '../../../src/panel/html/blocks';
import { countingText } from '../../countingText';

describe('readTags', () => {
  it('reads start and end tags with their attributes, in order', () => {
    const { tags, text } = readTags('<div align="center" markdown>\n<img src=a.png alt=\'a > b\'/></div>');
    expect(tags.map((t) => [t.name, t.closing, t.selfClosing])).toEqual([
      ['div', false, false],
      ['img', false, true],
      ['div', true, false],
    ]);
    expect([...tags[0]!.attributes]).toEqual([
      ['align', 'center'],
      ['markdown', ''],
    ]);
    expect(tags[1]!.attributes.get('alt')).toBe('a > b');
    expect(text).toEqual([]);
  });

  it('skips comments, declarations and the content of raw-text elements', () => {
    const html = '<!-- <b> --><!DOCTYPE html><style>p > <i> {}</style><script>if (a<b) x()</script>ok';
    const { tags, text } = readTags(html);
    expect(tags.map((t) => `${t.closing ? '/' : ''}${t.name}`)).toEqual(['style', '/style', 'script', '/script']);
    expect(text.map((r) => html.slice(r.from, r.to))).toEqual(['ok']);
  });

  it('reads a `<` that starts no tag as text, and drops a tag the text ends inside', () => {
    const html = 'a < b <c d="unclosed';
    const { tags, text } = readTags(html);
    expect(tags).toEqual([]);
    expect(text.map((r) => html.slice(r.from, r.to))).toEqual(['a', '<', 'b']);
  });

  it('marks tags inside SVG and MathML as foreign', () => {
    const { tags } = readTags('<svg><linearGradient/></svg><b>');
    expect(tags.map((t) => [t.name, t.foreign])).toEqual([
      ['svg', false],
      ['lineargradient', true],
      ['svg', true],
      ['b', false],
    ]);
  });

  it('reads a long run of unclosed comments and tags a bounded number of times per character', () => {
    const html = countingText('<!--x'.repeat(20_000) + '<a b="'.repeat(20_000));
    readTags(html.text);
    expect(html.read()).toBeLessThan(10 * html.text.length);
  });
});

describe('readHtmlBlock', () => {
  it('leaves nothing open after an element the HTML parser never fills', () => {
    expect(readHtmlBlock('<input> <keygen> <param name=a> <img src=b> text').kind).toBe('drawing');
  });

  it('reads a details opener with its summary', () => {
    const html = '<details>\n<summary>More <b>here</b></summary>';
    const shape = readHtmlBlock(html);
    expect(shape).toMatchObject({ kind: 'opener', name: 'details', pure: true, open: false });
    if (shape.kind !== 'opener') throw new Error('not an opener');
    expect(html.slice(shape.summary!.from, shape.summary!.to)).toBe('More <b>here</b>');
  });

  it('reads `open`, an alignment, `<center>` and an element marked `markdown`', () => {
    expect(readHtmlBlock('<details open>')).toMatchObject({ kind: 'opener', open: true, summary: null });
    expect(readHtmlBlock('<div align="CENTER">')).toMatchObject({ kind: 'opener', align: 'center', pure: true });
    expect(readHtmlBlock('<p align=right>')).toMatchObject({ kind: 'opener', name: 'p', align: 'right' });
    expect(readHtmlBlock('<center>')).toMatchObject({ kind: 'opener', align: 'center' });
    expect(readHtmlBlock('<section class="grid" markdown="1">')).toMatchObject({ kind: 'opener', name: 'section' });
  });

  it('reads an opener that holds more than its tag as not pure', () => {
    expect(readHtmlBlock('<div align="center">\n  <img src="logo.png">')).toMatchObject({
      kind: 'opener',
      pure: false,
    });
    expect(readHtmlBlock('<details>\nText').kind).toBe('code');
  });

  it('reads one end tag alone as a closer, and anything more as something else', () => {
    expect(readHtmlBlock('</details>')).toEqual({ kind: 'closer', name: 'details' });
    expect(readHtmlBlock('  </DIV >')).toEqual({ kind: 'closer', name: 'div' });
    expect(readHtmlBlock('</div>\n<div align="left">').kind).toBe('code');
    expect(readHtmlBlock('</details>\nmore').kind).toBe('drawing');
    expect(readHtmlBlock('</td>\n</tr>\n</table>').kind).toBe('code');
  });

  it('reads a complete block as a drawing, an empty one as invisible', () => {
    expect(readHtmlBlock('<p align="center">\n  <img src="a.png">\n</p>').kind).toBe('drawing');
    expect(readHtmlBlock('<table><tr><td>a</td></tr></table>').kind).toBe('drawing');
    expect(readHtmlBlock('<ul><li>one<li>two</ul>').kind).toBe('drawing');
    expect(readHtmlBlock('<a name="top"></a>').kind).toBe('invisible');
    expect(readHtmlBlock('<br />').kind).toBe('drawing');
  });

  it('reads a block that leaves elements open for later blocks as code', () => {
    expect(readHtmlBlock('<details>\n<summary>').kind).toBe('code');
    expect(readHtmlBlock('<table>\n<tr>\n<td>').kind).toBe('code');
  });

  it('reads a standalone summary block as summary', () => {
    const html = '<summary>More <b>here</b></summary>';
    const shape = readHtmlBlock(html);
    expect(shape).toEqual({
      kind: 'summary',
      inner: { from: '<summary>'.length, to: html.length - '</summary>'.length },
      empty: false,
    });
    expect(readHtmlBlock('<summary></summary>')).toMatchObject({ kind: 'summary', empty: true });
    expect(readHtmlBlock('<summary>One</summary>\n<p>Two</p>').kind).toBe('drawing');
  });

  it('reads tag-shaped text that names no element as text', () => {
    expect(readHtmlBlock('<name>').kind).toBe('text');
    expect(readHtmlBlock('<my-widget>\n</my-widget>').kind).toBe('text');
  });
});

describe('pairWrappers', () => {
  const block = (from: number, html: string): TagBlock => ({ from, to: from + 1, shape: readHtmlBlock(html) });

  it('pairs each closer with the nearest opener of its name', () => {
    const blocks = [
      block(0, '<details>'),
      block(1, '<div align="center">'),
      block(2, '</div>'),
      block(3, '</details>'),
    ];
    expect(pairWrappers(blocks).map((w) => [w.opener.from, w.closer.from])).toEqual([
      [0, 3],
      [1, 2],
    ]);
  });

  it('leaves an opener with no closer, and a closer with no opener, unpaired', () => {
    const blocks = [block(0, '</div>'), block(1, '<details>'), block(2, '<div>'), block(3, '</details>')];
    expect(pairWrappers(blocks).map((w) => [w.opener.from, w.closer.from])).toEqual([[1, 3]]);
  });

  it('attaches a standalone summary block to a details opener when nothing separates them', () => {
    const blocks = [block(0, '<details>'), block(10, '<summary>More</summary>'), block(40, '</details>')];
    const paired = pairWrappers(blocks, (from, to) => from === 1 && to === 10);
    expect(paired).toHaveLength(1);
    expect(paired[0]!.summary?.from).toBe(10);
    const blocked = pairWrappers(blocks, () => false);
    expect(blocked[0]!.summary).toBeUndefined();
  });
});
