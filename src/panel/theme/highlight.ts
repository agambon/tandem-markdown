// Syntax colors for code inside code blocks: GitHub's light and dark palettes (Primer's
// "prettylights") as two CodeMirror HighlightStyles. Which one applies follows the theme
// kind VS Code puts on <body> (`vscode-light`, `vscode-dark`, `vscode-high-contrast`,
// `vscode-high-contrast-light`), and changes when VS Code changes it.
//
// Only code is colored: the text of code blocks, in their languages, and of HTML blocks, whose
// source the page shows as code. Markdown's own syntax (headings, emphasis, links, marks, an
// escape, an entity, inline HTML and comments) is left alone: the render features draw it, the
// same in a line as in a table's cell.
//
// The two palettes' colors are Primer's `prettylights` syntax colors, from primer/primitives
// (MIT). Its notice:
//
//   Copyright (c) 2018 GitHub Inc.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies
//   or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { HighlightStyle, syntaxTree } from '@codemirror/language';
import { Compartment, Prec, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { IterMode, type Tree, type TreeCursor } from '@lezer/common';
import { highlightTree, tags as t } from '@lezer/highlight';
import { onThemeChange } from './themeChanges';

interface Palette {
  comment: string;
  constant: string;
  entity: string;
  tag: string;
  keyword: string;
  string: string;
  variable: string;
  regexp: string;
  invalid: string;
}

const light: Palette = {
  comment: '#6e7781',
  constant: '#0550ae',
  entity: '#6639ba',
  tag: '#116329',
  keyword: '#cf222e',
  string: '#0a3069',
  variable: '#953800',
  regexp: '#116329',
  invalid: '#82071e',
};

const dark: Palette = {
  comment: '#8b949e',
  constant: '#79c0ff',
  entity: '#d2a8ff',
  tag: '#7ee787',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  variable: '#ffa657',
  regexp: '#7ee787',
  invalid: '#ffa198',
};

function style(p: Palette, themeType: 'light' | 'dark'): HighlightStyle {
  return HighlightStyle.define(
    [
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment },
      {
        tag: [
          t.keyword,
          t.controlKeyword,
          t.definitionKeyword,
          t.moduleKeyword,
          t.operatorKeyword,
          t.modifier,
          t.operator,
        ],
        color: p.keyword,
      },
      { tag: [t.string, t.special(t.string), t.character, t.docString, t.attributeValue], color: p.string },
      { tag: [t.regexp, t.escape], color: p.regexp },
      {
        tag: [
          t.number,
          t.integer,
          t.float,
          t.bool,
          t.null,
          t.atom,
          t.unit,
          t.constant(t.name),
          t.standard(t.name),
          t.typeName,
          t.propertyName,
        ],
        color: p.constant,
      },
      {
        tag: [
          t.function(t.variableName),
          t.function(t.propertyName),
          t.className,
          t.macroName,
          t.attributeName,
          t.annotation,
        ],
        color: p.entity,
      },
      { tag: [t.tagName, t.namespace], color: p.tag },
      { tag: [t.definition(t.variableName), t.self, t.special(t.variableName)], color: p.variable },
      { tag: t.invalid, color: p.invalid },
    ],
    { themeType },
  );
}

const lightStyle = style(light, 'light');
const darkStyle = style(dark, 'dark');

/** True when VS Code's theme kind on `body` is dark (dark or dark high contrast). */
function bodyIsDark(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  const classes = doc?.body?.classList;
  if (!classes) return false;
  if (classes.contains('vscode-high-contrast-light') || classes.contains('vscode-light')) return false;
  return classes.contains('vscode-dark') || classes.contains('vscode-high-contrast');
}

const themeKind = new Compartment();

/** Follows the body class: re-reads it whenever VS Code changes the theme. */
const followBodyClass = ViewPlugin.fromClass(
  class {
    private readonly stopWatching: () => void;
    constructor(view: EditorView) {
      this.stopWatching = onThemeChange(view.dom.ownerDocument, () => {
        const dark = bodyIsDark(view.dom.ownerDocument);
        if (dark !== view.state.facet(EditorView.darkTheme)) {
          view.dispatch({ effects: themeKind.reconfigure(EditorView.darkTheme.of(dark)) });
        }
      });
    }
    destroy(): void {
      this.stopWatching();
    }
  },
);

function styleFor(state: EditorState): HighlightStyle {
  return state.facet(EditorView.darkTheme) ? darkStyle : lightStyle;
}

/** The blocks whose text is colored, by the language parsed in them. */
const CODE_BLOCKS: ReadonlySet<string> = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock']);

/**
 * Colors the code in the visible text, as CodeMirror's `syntaxHighlighting` does, but walks
 * only the blocks in view: `highlightTree` over the whole tree steps through every block before
 * the viewport, a large part of each keystroke in a long file. Each code block is highlighted on
 * its own, which gives the same classes: no style rule depends on what holds a block.
 */
const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private tree: Tree;
    private style: HighlightStyle;
    private decoratedTo: number;
    private readonly marks = new Map<string, Decoration>();

    constructor(view: EditorView) {
      this.tree = syntaxTree(view.state);
      this.style = styleFor(view.state);
      this.decorations = this.build(view);
      this.decoratedTo = view.viewport.to;
    }

    update(update: ViewUpdate): void {
      const tree = syntaxTree(update.state);
      const style = styleFor(update.state);
      const { viewport } = update.view;
      const decoratedTo = update.changes.mapPos(this.decoratedTo, 1);
      // A tree that does not reach the viewport yet: keep what was drawn until it does.
      if (tree.length < viewport.to && style === this.style && decoratedTo >= viewport.to) {
        this.decorations = this.decorations.map(update.changes);
        this.decoratedTo = decoratedTo;
      } else if (tree !== this.tree || update.viewportChanged || style !== this.style) {
        this.tree = tree;
        this.style = style;
        this.decorations = this.build(update.view);
        this.decoratedTo = viewport.to;
      }
    }

    private build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      if (!this.tree.length) return builder.finish();
      const cursor = this.tree.cursor(IterMode.IgnoreMounts);
      for (const { from, to } of view.visibleRanges) {
        if (!cursor.childAfter(from)) continue;
        do {
          if (cursor.from >= to) break;
          this.color(cursor, from, to, builder);
        } while (cursor.nextSibling());
        cursor.parent();
      }
      return builder.finish();
    }

    /** Colors the code blocks among the block at `cursor` and the blocks it holds, within [from, to]. */
    private color(cursor: TreeCursor, from: number, to: number, builder: RangeSetBuilder<Decoration>): void {
      if (CODE_BLOCKS.has(cursor.name)) {
        const start = cursor.from;
        highlightTree(
          cursor.node.toTree(),
          this.style,
          (a, b, className) => builder.add(start + a, start + b, this.mark(className)),
          Math.max(0, from - start),
          Math.min(to, cursor.to) - start,
        );
        return;
      }
      if (!cursor.type.is('BlockContext') || !cursor.firstChild()) return;
      do if (cursor.type.is('Block') && cursor.to > from && cursor.from < to) this.color(cursor, from, to, builder);
      while (cursor.nextSibling());
      cursor.parent();
    }

    private mark(className: string): Decoration {
      let mark = this.marks.get(className);
      if (!mark) this.marks.set(className, (mark = Decoration.mark({ class: className })));
      return mark;
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The two palettes, and the theme kind they are chosen by. */
export function syntaxColors(): Extension {
  return [
    themeKind.of(EditorView.darkTheme.of(bodyIsDark())),
    followBodyClass,
    Prec.high(highlighter),
    EditorView.styleModule.of(lightStyle.module!),
    EditorView.styleModule.of(darkStyle.module!),
  ];
}
