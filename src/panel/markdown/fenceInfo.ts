// What a code fence's info string says, read as the programs that write it mean it, beyond
// CommonMark's first word:
//
//   ```{.python filename="run.py"}   Pandoc and Quarto: the first class, and a file name
//   ```{r label, echo=FALSE}         R Markdown and Quarto code that runs: the first word
//   ```js{1,4}  ```go {linenos=x}    VitePress, Hugo: the language up to a brace or a space
//   ```js title="app.js" {1,4-6}     Docusaurus, Material: a title
//
// Content meant for one output format (```{=latex}) keeps its info string as its label.

import { readAttributes } from '../../core/attributes';

export interface FenceInfo {
  /** The language, as written; '' when the fence names none. */
  language: string;
  /** A title or file name the fence gives; null for none. */
  title: string | null;
}

const WORD = /^[\w+#.-]+/;
const TITLE = /(?:^|\s)(?:title|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/;

function titleIn(text: string): string | null {
  const match = TITLE.exec(text);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/** The language and title in `info`, a fence's info string. */
export function fenceInfo(info: string): FenceInfo {
  const text = info.trim();
  if (text.startsWith('{')) {
    const close = text.indexOf('}');
    const inside = close < 0 ? text.slice(1) : text.slice(1, close);
    if (inside.startsWith('=')) return { language: text, title: null };
    const attributes = close < 0 ? null : readAttributes(text.slice(0, close + 1));
    const language = attributes?.classes[0] ?? WORD.exec(inside.replace(/^\./, ''))?.[0] ?? '';
    return { language, title: titleIn(inside) };
  }
  const language = /^[^\s{]*/.exec(text)![0];
  return { language, title: titleIn(text.slice(language.length)) };
}
