# Marks in a line and in lists

## Footnotes

A claim with a numbered note.[^1] A second claim with a named note.[^source] A note written in place.^[Pandoc and Obsidian write notes this way, with *styling* inside.] The first note again.[^1]

A reference to a label nothing defines stays as typed: [^missing]. So does MultiMarkdown's [^This is the note].

[^1]: The first note. Hover a number to read its note, and follow it with the keys a link opens with.

[^source]: The named note, numbered by where it is first referred to.
    Its second line is indented by four spaces.

[^unused]: A note nothing refers to keeps its label as typed.

## One tilde

GitHub strikes ~one tilde~ through, as it does ~~two~~. It takes ~5 to ~10 minutes: a tilde after a space never closes a strike.

Pandoc's subscript and superscript follow a letter, a digit or a bracket: water is H~2~O, Ca(OH)~2~ and x^2^ is a square, while Press ^C^C stays text.

## Comments

Visible text %%with a hidden comment%% around it.

%%
A comment block, over several lines.

Hidden in Rich view, faded in the Rich editor.
%%

## Tasks with other marks

- [ ] To do
- [x] Done
- [?] A question
- [-] Dropped
- [/] Half done
- [>] Moved on
- [~] GitLab's "does not apply" stays as typed

## Colored highlight

==🔴Important==, ==🟠Follow up==, ==🟡Remember this==, ==🟢Completed==, ==🔵Reference== and ==🟣Idea==, beside a plain ==highlight==.

## Wikilinks

[[Other note]], [[Other note|with shown text]] and [[Other note#A heading]]. Bear's [[Other note/Part two]] goes to the heading. A wiki's [[_TOSP_]] marker is no link; [[toc]] links to a note called toc.

| Picture | Link |
| --- | --- |
| ![[picture.png\|100]] | [[Other note\|in a cell]] |

## Emoji and highlight inside other syntax

In a:b:smile: the code is `:smile:`. A grid row +===+===+ and a tracked change {==marked==} are not highlight.
