---
title: Everything
tags: [lab, sample]
note: "A quoted value with a colon: in it."
---

# Everything Tandem Markdown draws

Every construct the panel draws, each once plainly and once in an awkward form. A paragraph is long enough to wrap at the column width, so the wrapping, the line height and the measure of the text can be judged against the preview, which this page is meant to match line for line.
A second line of the same paragraph, joined by a single line break.

## Headings

### Level three
#### Level four
##### Level five
###### Level six

Setext level one
================

Setext level two
----------------

## A heading with **bold**, `code` and a closing run ##

#

#not-a-heading (no space after the mark)

   ### Indented three spaces

## Emphasis and inline code

Plain: **bold**, *italic*, ***bold italic***, ~~struck~~, ==highlighted==, `inline code`.

Awkward: __bold__ and _italic_ with underscores, intra*word*emphasis, **bold with *italic* inside**, a `` code span with a ` backtick ``, \*escaped stars\*, a backslash hard break\
on the next line, ~~struck **and bold**~~, ==a highlight with `code`==, and a lone * that stays.

## Lists

- First bullet
- Second bullet, long enough to wrap onto a second line so the hanging indent shows whether wrapped lines line up with the text of the item
  - Nested bullet (circle)
    - Deeper bullet (square)
      - Deeper still
- Back at the top

1. One
2. Two
10. Ten, numbered as written
3) Three, with a parenthesis

* Star bullet
+ Plus bullet

- Loose item one

- Loose item two

  A second paragraph inside item two.

-
- An item after an empty one

- [ ] An open task
- [x] A checked task
- [X] A checked task with a capital X
  - [ ] A nested task
1. [ ] A task in a numbered list

## Quotes

> A plain quote.
> Its second line.

> A quote with two paragraphs.
>
> The second paragraph.
>
> > A nested quote.
> > > Nested three deep.
>
> - A list in a quote
> - Second item
>
> ```js
> const inQuote = true;
> ```

> Lazy continuation:
this line has no marker but belongs to the quote.

- A list item holding a quote:
  > quoted inside the list

## Code

```js
// Fenced, with a language
function greet(name) {
  return `Hello, ${name}!`;
}
```

~~~python
# Tildes and another language
def greet(name: str) -> str:
    return f"Hello, {name}!"
~~~

```
A fence with no language.

A blank line inside a code block stays an ordinary line.
```

````md
A longer fence holding a shorter one:
```
inner
```
````

    Indented code, four spaces.
    A second indented line.

- A list item with code:

  ```sh
  echo "inside a list"
  ```

```
```

## Rules

---

***

___

- - -

## HTML

<div align="center">
  <b>An HTML block</b>, shown as its source.
</div>

<!-- A comment block: hidden in Rich view, faded in Rich editor. -->

Inline HTML: press <kbd>Ctrl</kbd>+<kbd>S</kbd>. An inline comment <!-- hidden in Rich view --> sits here.

## Footnotes

A reference[^1] and a named one[^note].

[^1]: The first footnote.
[^note]: A longer footnote that
continues lazily.

    And has a second paragraph, indented.

## Links, images and a table

A [link](https://example.com), a [[Wikilink]], an aliased [[Folder/Note|alias]], an embed ![[image.png]], an image ![alt](pic.png).

| Column | Other |
|---|:---:|
| cell | **bold** cell |

## Spacing

A paragraph followed by two blank lines.


A paragraph followed by four blank lines.




Text directly after it.
- A list touching the paragraph above.
> A quote touching the list above.
## A heading touching the quote above
The last line of the file, touching the heading.
