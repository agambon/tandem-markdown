import { describe, expect, it } from 'vitest';
import { parserFor } from '../../../src/panel/markdown';
import { testSettings } from '../helpers';
import { findIn } from './treeHelpers';

function names(text: string, tilde: string, ...wanted: string[]): string[] {
  const parser = parserFor({ ...testSettings, syntax: { tilde } });
  return findIn(parser.parse(text), text, wanted).map((n) => `${n.name}:${n.text}`);
}

describe('one tilde, struck through as on GitHub', () => {
  const strikes = (text: string) => names(text, 'strikethrough', 'Strikethrough');

  it('strikes ~text~ and keeps ~~text~~', () => {
    expect(strikes('a ~gone~ and ~~two~~ b')).toEqual(['Strikethrough:~gone~', 'Strikethrough:~~two~~']);
    expect(names('~gone~', 'strikethrough', 'StrikethroughMark')).toEqual([
      'StrikethroughMark:~',
      'StrikethroughMark:~',
    ]);
  });

  it('never closes a strike with a tilde that follows a space', () => {
    expect(strikes('From ~5 to ~10 people.')).toEqual([]);
    expect(strikes('about ~5, ~6 or ~7')).toEqual([]);
  });

  it('closes with a tilde after a word, as GitHub does', () => {
    // GitHub strikes this from the second tilde to the one after "about".
    expect(strikes('~5 to ~10 and about~5')).toEqual(['Strikethrough:~10 and about~']);
  });

  it('does not pair one tilde with two, nor take a run of three', () => {
    expect(strikes('~a~~')).toEqual([]);
    expect(strikes('~~a~')).toEqual([]);
    expect(strikes('~~~a~~~')).toEqual([]);
  });

  it('reads no subscript or superscript', () => {
    expect(names('H~2~O x^2^', 'strikethrough', 'Subscript', 'Superscript')).toEqual([]);
  });
});

describe('one tilde as subscript, with superscript, as Pandoc reads them', () => {
  const marks = (text: string) => names(text, 'subscript', 'Subscript', 'Superscript', 'Strikethrough');

  it('reads H~2~O and x^2^', () => {
    expect(marks('H~2~O and x^2^')).toEqual(['Subscript:~2~', 'Superscript:^2^']);
  });

  it('allows no space inside, so ~5 to ~10 and 2^10 and 3^2 stay text', () => {
    expect(marks('From ~5 to ~10 people.')).toEqual([]);
    expect(marks('2^10 and 3^2')).toEqual([]);
  });

  it('keeps ~~text~~ a strike', () => {
    expect(marks('~~gone~~')).toEqual(['Strikethrough:~~gone~~']);
  });

  it('leaves footnotes to the footnote parser', () => {
    expect(names('A claim.[^1] and x^[a note]^', 'subscript', 'Superscript', 'FootnoteRef', 'InlineFootnote')).toEqual([
      'FootnoteRef:[^1]',
      'InlineFootnote:^[a note]',
    ]);
  });
});

describe('both readings, as each program writes it', () => {
  const marks = (text: string) => names(text, 'both', 'Subscript', 'Superscript', 'Strikethrough');

  it('reads a pair straight after a letter, a digit or a closing bracket as subscript or superscript', () => {
    expect(marks('H~2~O, 2^10^, x~i~, (OH)~2~, [x]~i~ and {n}^2^')).toEqual([
      'Subscript:~2~',
      'Superscript:^10^',
      'Subscript:~i~',
      'Subscript:~2~',
      'Subscript:~i~',
      'Superscript:^2^',
    ]);
  });

  it('strikes any other pair of one tilde through by GitHub rule, and leaves other carets as text', () => {
    expect(marks('A ~gone~ word and a ^note^ here')).toEqual(['Strikethrough:~gone~']);
    expect(marks('From ~5 to ~10 people.')).toEqual([]);
    expect(marks('~5 to ~10 and about~5')).toEqual(['Strikethrough:~10 and about~']);
  });

  it('allows no white space inside but an escaped space, and reads the escapes', () => {
    expect(marks('x~a b~ and X~long\\ text~')).toEqual(['Strikethrough:~a b~', 'Subscript:~long\\ text~']);
    expect(names('X~a\\ b~', 'both', 'Escape')).toEqual(['Escape:\\ ']);
    expect(marks('x^a\nb^')).toEqual([]);
  });

  it('never takes a tilde from a run of two or more, an escape or code', () => {
    expect(marks('H~2~~O')).toEqual([]);
    expect(marks('x^^2^^')).toEqual([]);
    expect(marks('This will ~~~not~~~ strike.')).toEqual([]);
    expect(marks('H\\~2~O')).toEqual([]);
    expect(marks('`x~i~` and x~`a`~')).toEqual([]);
  });

  it('reads a pair in a link text and a table cell, and not in a link address', () => {
    expect(marks('[H~2~O](https://example.com/~a~b~)')).toEqual(['Subscript:~2~']);
    expect(marks('| a |\n|---|\n| H~2~O |')).toEqual(['Subscript:~2~']);
  });

  it('leaves footnotes to the footnote parser', () => {
    expect(names('A claim[^1] and x^[a note]^', 'both', 'Superscript', 'FootnoteRef', 'InlineFootnote')).toEqual([
      'FootnoteRef:[^1]',
      'InlineFootnote:^[a note]',
    ]);
  });
});

describe('one tilde off', () => {
  it('reads one tilde as text and two as a strike', () => {
    expect(names('a ~b~ c ~~d~~ x^2^', 'off', 'Strikethrough', 'Subscript', 'Superscript')).toEqual([
      'Strikethrough:~~d~~',
    ]);
  });
});
