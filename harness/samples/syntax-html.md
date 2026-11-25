# HTML

HTML in a file is drawn as a browser draws it, through GitHub's allow-list. Markdown between the tag lines of a wrapper stays markdown.

<details>
<summary>A folded section, as GitHub READMEs write it</summary>

Inside is **markdown**, with a list:

- one
- two

</details>

<details open>
<summary>One written <code>open</code></summary>

Shown until its summary is clicked.

</details>

<div align="center">

## A centered heading

Centered words, and a picture on its own line:

![Logo](logo.png)

</div>

<center>

`<center>` aligns too.

</center>

<div class="grid cards" markdown>

- HTML marked `markdown`, as Material for MkDocs writes it

</div>

## Blocks

<p align="center">
  <img src="logo.png" width="120" alt="Logo">
</p>

<table>
  <tr><th>Name</th><th>Size</th></tr>
  <tr><td>notes.md</td><td>2 KB</td></tr>
</table>

<figure>
  <img src="chart.png" alt="Chart">
  <figcaption>A figure with its caption</figcaption>
</figure>

<aside>
💡 Notion writes its callouts as an aside.
</aside>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png">
  <img alt="A picture for each theme" src="logo-light.png">
</picture>

<a name="target"></a>

Tag-shaped text that names no element stays as typed: use <your-key> here.

## Links and cells

Read <a href="https://example.com/docs">the documentation</a>, or jump to [the named anchor](#target).

| Keys | Steps |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | <ul><li>save</li><li>close</li></ul> |
| ![[logo.png\|40]] | H<sub>2</sub>O |

## Pictures from other programs

![Engelbart|100x145](engelbart.jpg) sized after its alt text (Obsidian).

![](media/image1.png){width="3in"} sized in braces (Pandoc from Word).

![[logo.png|200|center]] sized and centered (Foam).

![Logo](logo-dark.png#gh-dark-mode-only)
![Logo](logo-light.png#gh-light-mode-only)

A picture stored in the file: ![dot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)

## Players (with `tandemMarkdown.syntax.media` on)

<video src="clip.mp4" controls></video>

![[talk.ogg]]
