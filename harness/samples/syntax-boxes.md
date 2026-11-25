+++
title = "Boxes and document tools"
date = 1979-05-27T07:32:00Z
tags = ["sample", "toml"]

[params]
author = "A. Writer"
+++

# Boxes and document tools {#top}

## Boxes

::: tip
A VitePress container takes its type's name as its title.
:::

::: danger STOP
A title after the name.
:::

:::note[A Docusaurus title, with **bold**]

The body is ordinary markdown:

- a list
- [a link](https://example.com)

:::

::: Warning
A Pandoc div.

::: Danger
A div inside a div.
:::
:::

::: {.callout-important title="A Quarto callout"}
With its title in its attributes.
:::

::: {.callout-tip collapse="true"}
## A Quarto callout that collapses
The heading that opens it is its title.
:::

::: details Click to open
VitePress folds a details container.
:::

::: {.columns}
A class that no program styles makes a plain box, labeled with the class.
:::

::: mermaid
graph LR;
A-->B
:::

!!! note "An admonition from MkDocs"

    Its body is indented four spaces.

    - a list inside
      lines up

??? question "One that folds"
    Hidden until opened.

???+ success
    Open until folded.

These stay text: a line of colons,

:::

a time, ::: 10:30, and ??? a question.

## Attributes and spans {.unnumbered}

A link to [the top](#top) jumps to the first heading. Pandoc writes [underlined]{.underline},
[small capitals]{.smallcaps} and [marked]{.mark} text, and leaves Word's bookmarks behind:
[]{#_Toc123 .anchor}here. Other braces stay: [red]{.red}, a paragraph {#id}.

## Definition lists

Apple
:   Pomaceous fruit of plants of the genus Malus.

Orange

:   The fruit of an evergreen tree.

    - with a list inside

## A grid table

+---------------+---------------+--------------------+
| Fruit         | Price         | Advantages         |
+===============+===============+====================+
| Bananas       | $1.34         | - built-in wrapper |
|               |               | - bright color     |
+---------------+---------------+--------------------+
| Oranges       | **$2.10**     | - cures scurvy     |
|               |               | - tasty            |
+---------------+---------------+--------------------+

## Abbreviations

The HTML specification is maintained by the W3C.

*[HTML]: Hyper Text Markup Language
*[W3C]: World Wide Web Consortium

## Code fence labels

```{.python filename="run.py"}
print("colored as Python")
```

```{r label, echo=FALSE}
plot(cars)
```

```js{1,4}
const a = 1;
```

## Math as chat assistants write it

The area is \(\pi r^2\), and Einstein wrote

\[
E = mc^2
\]

while Jupyter draws an environment:

\begin{align}
a &= b + c \\
d &= e
\end{align}

A web clipper's \[1\] stays a bracket.

## Off unless switched on

An {++added++}, a {--cut--} and an {~~old~>new~~} word, {==marked==}{>>with a comment<<}.

=== "Python"

    print(1)

=== "Shell"

    echo 1

>>>
A quote between GitLab's fences.
>>>

Doubled backslashes: \\(x^2\\).
