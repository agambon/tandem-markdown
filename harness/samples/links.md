# Links, wikilinks and images

On the harness page this note is `notes/links.md` in a small made-up workspace (harness/fakes/links.ts).

## Links

An inline link to [the CommonMark spec](https://spec.commonmark.org/ "CommonMark"), a [file beside this one](Other%20note.md), one [from the root](/README.md), and [a heading in this file](#images).

Reference links: [the guide][guide], [Guide][] and [guide], but [nothing][undefined] stays as typed, and so does [sic].

[guide]: <Other note.md> "The guide"

Autolinks: <https://example.com/path> and <someone@example.com>. Bare: www.example.org and https://example.net/page.

A link with no text: [](https://example.com/empty).

## Wikilinks

[[Other note]], [[Folder/Topic|a topic with an alias]], [[Other note#Section]], [[Topic]] (two files match), [[#Images]] and [[Nowhere]] (no such file).

An embed of a note: ![[Doc.pdf]].

## Images

![A picture](img/pic.png "The picture")

Inline in text: ![badge](img/pic.png) then more text, and a linked one [![wide](img/wide.svg)](https://example.com/badge).

![[pic.png|200]]

![[wide.svg]]

![With spaces](<img/My Note-20261114.png>)

![Encoded](img/My%20Note-20261114.png)

![Backslashes](img\pic.png)

![Missing](img/missing.png)

![Outside](../../outside.png)

![Plain http](http://example.com/a.png)

![[missing.png]]

| Name | Link |
| --- | --- |
| Table | [inside a table](Other%20note.md) |

## Typing

Type a wikilink here:
