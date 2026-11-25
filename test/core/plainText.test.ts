// Inline markdown read as plain text, and the reading heading anchors are made from.
import fc from 'fast-check';
import { nameToEmoji } from 'gemoji';
import { describe, expect, it } from 'vitest';
import { anchorText, plainText } from '../../src/core/plainText';
import { seeded } from '../random';

describe('plainText', () => {
  it('decodes the common named entities and numeric ones', () => {
    expect(plainText('A &amp; B')).toBe('A & B');
    expect(plainText('&lt;tag&gt; &quot;q&quot; &copy; &nbsp;x')).toBe('<tag> "q" \u00a9 \u00a0x');
    expect(plainText('&#169; &#xA9; &#X2713;')).toBe('\u00a9 \u00a9 \u2713');
  });

  it('leaves names it does not know, and malformed ones, as typed', () => {
    expect(plainText('&notanentity; &amp &#xZZ;')).toBe('&notanentity; &amp &#xZZ;');
  });

  it('turns a zero, a surrogate or a number past the last code point into the replacement character', () => {
    expect(plainText('&#0; &#xD800; &#1114112;')).toBe('\ufffd \ufffd \ufffd');
  });

  it('leaves an entity as typed in code or after a backslash, as the page shows it', () => {
    expect(plainText('Use `&amp;` here')).toBe('Use &amp; here');
    expect(plainText('A \\&amp; B')).toBe('A &amp; B');
    expect(plainText('Code `&lt;` and &amp;')).toBe('Code &lt; and &');
  });

  it('leaves comments out, HTML and Obsidian alike, and keeps one never closed', () => {
    expect(plainText('A <!-- note --> B %%hidden%% C')).toBe('A B C');
    expect(plainText('A <!--> B <!---> C')).toBe('A B C');
    expect(plainText('50%% off')).toBe('50%% off');
    expect(plainText('`%%code%%` and \\%%not\\%%')).toBe('%%code%% and %%not%%');
  });

  it("keeps an HTML element's text without its tags, a line break as a space and a picture as its alt", () => {
    expect(plainText('Press <kbd>Ctrl</kbd>+<kbd>S</kbd>')).toBe('Press Ctrl+S');
    expect(plainText('<span class="x">Shown</span> and H<sub>2</sub>O')).toBe('Shown and H2O');
    expect(plainText('one<br>two<br/>three')).toBe('one two three');
    expect(plainText('A <img src="logo.png" alt="Logo"> here')).toBe('A Logo here');
    expect(plainText('use <name> here and a < b')).toBe('use <name> here and a < b');
    expect(plainText('`<kbd>x</kbd>` stays')).toBe('<kbd>x</kbd> stays');
  });

  it('reads an entity after the tags are gone, so a written tag stays text', () => {
    expect(plainText('&lt;kbd&gt;x&lt;/kbd&gt;')).toBe('<kbd>x</kbd>');
  });

  it('keeps emoji codes and math as typed without the emoji list', () => {
    expect(plainText('Launch :rocket: when $x^2$ holds')).toBe('Launch :rocket: when $x^2$ holds');
  });

  it('keeps every formula the page draws exactly as typed: no mark, escape, entity, code or comment read', () => {
    expect(plainText('The $a*b*c$ case')).toBe('The $a*b*c$ case');
    expect(plainText('$a\\_b$, $x &amp; y$, $a %%b%% c$ and $`a*b*`$')).toBe(
      '$a\\_b$, $x &amp; y$, $a %%b%% c$ and $`a*b*`$',
    );
    expect(plainText('$$a **b** c$$ and \\(a *b* c\\)')).toBe('$$a **b** c$$ and \\(a *b* c\\)');
    expect(plainText('\\[ x *y* z \\]')).toBe('\\[ x *y* z \\]');
    expect(plainText('\\begin{align} a &amp; *b* \\end{align}')).toBe('\\begin{align} a &amp; *b* \\end{align}');
    expect(plainText('**Bold** $a  b$ [in a *link* $c*d*e$](x)')).toBe('Bold $a  b$ in a link $c*d*e$');
  });

  it("keeps a wikilink's text exactly as typed, as the page shows it", () => {
    expect(plainText('See [[*a*]] and [[Plan|the `real` **plan**]]')).toBe('See *a* and the `real` **plan**');
    expect(plainText('![[my_pic_1.png]] in *italics*')).toBe('my_pic_1.png in italics');
    expect(plainText('`[[*a*]]` and <!-- [[*b*]] --> [[Note#Part *two*]]')).toBe('[[*a*]] and Note > Part *two*');
  });

  it('reads as text what the page does not draw as math', () => {
    expect(plainText('Costs $5 and *more* than $10')).toBe('Costs $5 and more than $10');
    expect(plainText('\\$a *b* c$ and $ a *b* $')).toBe('$a b c$ and $ a b $');
    expect(plainText('A \\[ *b* \\] in the middle')).toBe('A [ b ] in the middle');
    expect(plainText('`$a*b*$` and [[$a$]] and <https://x.co/$a$>')).toBe('$a*b*$ and $a$ and https://x.co/$a$');
  });

  it('reads correctly however many pieces it sets aside, past one character of the private use area each', () => {
    const many = 7000;
    expect(plainText('\\* '.repeat(many))).toBe(Array<string>(many).fill('*').join(' '));
    expect(plainText('`x` $a*b$ &nbsp;'.repeat(3000))).toBe(Array<string>(3000).fill('x $a*b$  ').join(''));
    expect(plainText(':x: '.repeat(many), { names: nameToEmoji })).toBe(
      Array<string>(many).fill(nameToEmoji['x']!).join(' '),
    );
  });

  it('gives back a private-use character typed in code as itself, beside white space an entity stands for', () => {
    expect(plainText('`` and &nbsp;x')).toBe(' and  x');
  });
});

describe('plainText with the emoji list', () => {
  const emoji = { names: nameToEmoji };
  const read = (source: string) => plainText(source, emoji);

  it('gives a code on the list as its emoji, and one off it as typed', () => {
    expect(read('Launch :rocket:')).toBe('Launch 🚀');
    expect(read('a:rocket:b and :+1: :-1:')).toBe(`a🚀b and ${nameToEmoji['+1']} ${nameToEmoji['-1']}`);
    expect(read('Not :not_a_name: and 12:30:45')).toBe('Not :not_a_name: and 12:30:45');
  });

  it('reads codes from the left, the first shape winning a shared colon, as the page does', () => {
    expect(read('a:b:smile:')).toBe(`a${nameToEmoji['b']}smile:`);
    expect(read(':smile::rocket:')).toBe(`${nameToEmoji['smile']}🚀`);
  });

  it('keeps an emoji whole when marks are read around it, a keycap holding `#` or `*` included', () => {
    expect(read('**Launch :rocket:** and _:smile:_')).toBe(`Launch 🚀 and ${nameToEmoji['smile']}`);
    expect(read(':hash: and :asterisk: *x*')).toBe(`${nameToEmoji['hash']} and ${nameToEmoji['asterisk']} x`);
    expect(read('[Launch :rocket:](plan.md) and ~~:x:~~')).toBe(`Launch 🚀 and ${nameToEmoji['x']}`);
  });

  it('keeps a code as typed in code, after a backslash or written with entities', () => {
    expect(read('Run `:rocket:` now')).toBe('Run :rocket: now');
    expect(read('\\:rocket: and :rocket\\:')).toBe(':rocket: and :rocket:');
    expect(read('&#58;rocket&#58;')).toBe(':rocket:');
  });

  it("keeps a code as typed in a link's address, never joining one across a link's edge", () => {
    expect(read('[Plan](https://example.com/:rocket:)')).toBe('Plan');
    expect(read('[:smile](plan.md):')).toBe(':smile:');
  });

  it('keeps a code as typed in an autolink, a bare web address, a tag and its alt text', () => {
    expect(read('<https://example.com/:rocket:> and <x-app:rocket:>')).toBe(
      'https://example.com/:rocket: and <x-app:rocket:>',
    );
    expect(read('See https://example.com/:rocket: and www.example.com/:rocket:')).toBe(
      'See https://example.com/:rocket: and www.example.com/:rocket:',
    );
    expect(read('<img src="a.png" alt="Logo :rocket:"> <span title=":x:">go</span>')).toBe('Logo :rocket: go');
  });

  it('keeps a code as typed in a wikilink, a picture, a footnote label and a span’s attributes', () => {
    expect(read('[[Plan|Launch :rocket:]] and ![[pic :x:.png]]')).toBe('Launch :rocket: and pic :x:.png');
    expect(read('![Logo :rocket:](logo.png) :rocket:')).toBe('Logo :rocket: 🚀');
    expect(read('Text[^a:b:c] :b:')).toBe(`Text[^a:b:c] ${nameToEmoji['b']}`);
    expect(read('[]{#fig:a:b .anchor}[shown :x:]{.mark}')).toBe(`shown ${nameToEmoji['x']}`);
  });

  it('keeps math as typed, codes and all', () => {
    expect(read('Ratio $a:b:c$ is :b:')).toBe(`Ratio $a:b:c$ is ${nameToEmoji['b']}`);
    expect(read('$$x :b: y$$ and \\(a:b:c\\)')).toBe('$$x :b: y$$ and \\(a:b:c\\)');
    expect(read('Costs $5 :b: and $10')).toBe(`Costs $5 ${nameToEmoji['b']} and $10`);
    expect(read('\\[ a:b:c \\]')).toBe('\\[ a:b:c \\]');
  });

  it('asks for the list for a code it meets before the list has loaded, and keeps the code meanwhile', () => {
    let asked = 0;
    const early = { names: undefined, wanted: () => asked++ };
    expect(plainText('Launch :rocket:', early)).toBe('Launch :rocket:');
    expect(asked).toBe(1);
    asked = 0;
    expect(plainText('`:rocket:` <!-- :x: --> and [[Plan :x:]]', early)).toBe(':rocket: and Plan :x:');
    expect(asked).toBe(0);
  });

  it('leaves the anchor reading as typed', () => {
    expect(anchorText('Launch :rocket:')).toBe('Launch :rocket:');
  });

  it('changes nothing but codes: with no name on the list, it reads as it does without one', () => {
    const piece = fc.constantFrom(
      ...[':', 'a', 'b', ' ', '`', '\\', '$', '[', ']', '(', ')', '<', '>', '!', '*', '_', '{', '}'],
      ...['#', '.', '%', '-', '^', '~', '=', '&', ';', '|', '\n', 'https://x.co/', 'www.', '<!--', '-->'],
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
        const source = pieces.join('');
        expect(plainText(source, { names: {} })).toBe(plainText(source));
      }),
      seeded({ numRuns: 3000 }),
    );
  });
});

describe('anchorText', () => {
  it('reads marks and links as plainText does, and leaves entities, tags and comments as typed', () => {
    const source = '**A** &amp; <kbd>B</kbd> %%c%% [link](x) ==m==';
    expect(plainText(source)).toBe('A & B link m');
    expect(anchorText(source)).toBe('A &amp; <kbd>B</kbd> %%c%% link m');
  });
});

describe('plainText syntax options', () => {
  it('honors wikilinks mode: noteFirst, textFirst, and off', () => {
    const source = 'See [[Target|Label]] and [[Other]]';
    expect(plainText(source, { wikilinks: 'noteFirst' })).toBe('See Label and Other');
    expect(plainText(source, { wikilinks: 'textFirst' })).toBe('See Target and Other');
    expect(plainText(source, { wikilinks: 'off' })).toBe('See [[Target|Label]] and [[Other]]');
  });

  it('honors math: false by reading emphasis inside dollar signs as ordinary markdown', () => {
    const source = 'Cost $a *b* c$ here';
    expect(plainText(source, { math: true })).toBe('Cost $a *b* c$ here');
    expect(plainText(source, { math: false })).toBe('Cost $a b c$ here');
  });
});
