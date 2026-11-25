---
title: Tables and frontmatter
version: 3.0
tags: [tables, frontmatter]
author:
  name: Sample Writer
  links:
    - one
    - two
summary: A long value that should wrap inside its cell rather than push the table wider than the column it sits in, however long it runs.
---

# Tables

A plain table with alignment from the delimiter row.

| Fruit | Color | Qty |
| :---- | :----: | --: |
| apple | red | 3 |
| pear | green | 10 |
| plum | purple | 7 |

## Inline content in cells

| Style | Example |
| --- | --- |
| Bold and italic | **bold** and *italic* and ***both*** |
| Code | `let x = 1` and `a\|b` |
| Strikethrough | ~~gone~~ |
| Highlight | ==marked== |
| Link | [GitHub](https://github.com) and <https://example.com> |
| Wikilink | [[Some Note]] and [[Folder/Other\|an alias]] |
| Line break | first line<br>second line |
| Escapes | \*not italic\* and a pipe \| here |

## Short and long rows

| A | B | C |
| - | - | - |
| only one |
| two | cells |
| four | cells | in | a row |

## A wide table

| Column one | Column two | Column three | Column four | Column five | Column six | Column seven | Column eight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a_rather_long_unbreakable_value_here | another_long_value_without_spaces | x | y | z | more_text_that_does_not_wrap | 7 | 8 |

## Tables inside other blocks

- A list item with a table under it:

  | Key | Value |
  | --- | --- |
  | one | 1 |

> A quote with a table:
>
> | Key | Value |
> | --- | --- |
> | two | 2 |

Text right above a table, with no blank line between.
| Touching | Table |
| --- | --- |
| x | y |

## Not drawn as a grid

A `---` line right under a table makes the parser read the table as a heading:

| Looks | Like |
| --- | --- |
| a | table |
---

End of the sample.
