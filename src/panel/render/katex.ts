// KaTeX, loaded the first time a formula is drawn, and the one function that draws a formula
// with it (docs/ARCHITECTURE.md, "Libraries loaded on demand").
//
// KaTeX runs with `trust` off, so no command can make a link, a picture, a class, an id or a
// style; with its expansion limit, and with sizes a formula asks for capped. It builds its
// output as nodes and sets their styles through the style object, which the page's content
// policy allows. Two of its MathML builders (`\pmb`, `\fcolorbox`) set a `style` attribute
// instead, which the policy reports as a violation, so the formula is built from KaTeX's own
// tree with those styles moved to the style object.

import type Katex from 'katex';
import { errorMessage } from '../../core/errors';
import { addStylesheet } from '../assets';
import { onDemand, whenIdle } from '../onDemand';
import { LruCache } from './lruCache';

type KatexModule = typeof Katex;

/** KaTeX, with its stylesheet. */
export const katex = onDemand<KatexModule>(async () => {
  await whenIdle();
  const [module] = await Promise.all([import('katex'), addStylesheet('katex/katex.min.css')]);
  return module.default;
});

/** The most macro expansions one formula may make: KaTeX's own default, stated here so it cannot change unseen. */
const MAX_EXPANSIONS = 1000;
/** The largest size, in ems, a formula may ask for (`\rule`, `\kern`, `\rlap`...). */
const MAX_SIZE_EM = 20;
/** Formulas kept drawn, by their text. */
const CACHE_SIZE = 300;

/** A node of KaTeX's tree, as far as it is read here. */
interface TreeNode {
  attributes?: Record<string, string>;
  children?: TreeNode[];
  toNode(): Node;
}

/** Moves every `style` attribute of a MathML node in `node`'s tree to the built element's style object. */
function stylesThroughStyleObject(node: TreeNode): void {
  const css = node.attributes?.style;
  if (typeof css === 'string') {
    delete node.attributes!.style;
    const build = node.toNode.bind(node);
    node.toNode = () => {
      const element = build() as Element & ElementCSSInlineStyle;
      element.style.cssText = css;
      return element;
    };
  }
  for (const child of node.children ?? []) stylesThroughStyleObject(child);
}

type Formula = { node: HTMLElement } | { error: string };

const cache = new LruCache<string, Formula>(CACHE_SIZE);

/**
 * `tex` drawn by KaTeX as display math (`display`) or in a line, or what is wrong with it.
 * Throws nothing. Null until KaTeX has loaded (`katex`). Each call gives nodes of its own.
 */
export function drawFormula(tex: string, display: boolean): Formula | null {
  const k = katex.loaded();
  if (!k) return null;
  const key = `${display ? 'D' : 'I'}${tex}`;
  let formula = cache.get(key);
  if (!formula) {
    formula = build(k, tex, display);
    cache.set(key, formula);
  }
  return 'node' in formula ? { node: formula.node.cloneNode(true) as HTMLElement } : formula;
}

function build(k: KatexModule, tex: string, display: boolean): Formula {
  const options = {
    displayMode: display,
    output: 'htmlAndMathml',
    throwOnError: true,
    trust: false,
    strict: 'ignore',
    maxExpand: MAX_EXPANSIONS,
    maxSize: MAX_SIZE_EM,
  } as const;
  try {
    // KaTeX's tree before it becomes nodes; `render` is this followed by `toNode`.
    const tree = (k as unknown as { __renderToDomTree(tex: string, options: object): TreeNode }).__renderToDomTree(
      tex,
      options,
    );
    stylesThroughStyleObject(tree);
    return { node: tree.toNode() as HTMLElement };
  } catch (error) {
    return { error: errorMessage(error).replace(/^KaTeX parse error: /, '') };
  }
}
