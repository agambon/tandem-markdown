// Wikilink completion: while wikilinks are on, typing `[[` in Rich editor offers the
// workspace's files (`listLinkTargets`, asked again as the typing goes on). Choosing one
// inserts the shortest target that names that file alone, and the closing `]]` unless it is
// already there; inside an existing link it replaces the target up to its `]]`, `|` or `#`.
// The same list shows VS Code's own suggestions for links' addresses (complete/vscode.ts) and
// the insert menu (complete/insertMenu.ts).

import {
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import type { LinkTargetItem } from '../../core/featureProtocol';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { codeAt, treeForLine } from '../markdown/tree';
import { getMode } from '../modes';
import { syntaxOn } from '../syntax';
import { insertMenuSource } from './insertMenu';
import { vscodeSuggestions } from './vscode';

const MAX_ITEMS = 50;
const OPENER = /\[\[[^[\]|#\n]*$/;

function readItems(value: unknown): LinkTargetItem[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: LinkTargetItem[] = [];
  for (const item of items) {
    const i = item as Partial<LinkTargetItem> | null;
    if (!i || typeof i.label !== 'string' || typeof i.target !== 'string' || !i.target) continue;
    out.push({ label: i.label, target: i.target, detail: typeof i.detail === 'string' ? i.detail : '' });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * The change that puts `target` in place of the text from `from` to `to`: the rest of an
 * existing target after the cursor is replaced too when the link is closed after it, and
 * `]]` is added when it is not.
 */
export function completionChange(
  doc: { sliceString(from: number, to?: number): string; length: number },
  target: string,
  from: number,
  to: number,
): { from: number; to: number; insert: string; cursor: number } {
  const rest = doc.sliceString(to, Math.min(doc.length, to + 400)).split('\n', 1)[0] ?? '';
  const tail = /^[^[\]|#]*(?=\]\]|\||#)/.exec(rest);
  const end = to + (tail ? tail[0].length : 0);
  const after = rest.slice(tail ? tail[0].length : 0);
  if (after.startsWith(']]')) return { from, to: end, insert: target, cursor: from + target.length + 2 };
  if (tail) return { from, to: end, insert: target, cursor: from + target.length };
  return { from, to, insert: `${target}]]`, cursor: from + target.length + 2 };
}

async function wikilinkSource(context: CompletionContext): Promise<CompletionResult | null> {
  if (getMode(context.state) !== 'edit' || context.state.readOnly) return null;
  const before = context.matchBefore(OPENER);
  if (!before || codeAt(treeForLine(context.state, context.pos), context.pos)) return null;
  const ctx = context.state.facet(panelContext);
  if (!ctx || !syntaxOn(ctx.settings, 'wikilinks')) return null;
  const from = before.from + 2;
  const query = context.state.sliceDoc(from, context.pos);
  let items: LinkTargetItem[];
  try {
    items = readItems(await ctx.request({ type: 'listLinkTargets', query }));
  } catch (error) {
    ctx.log('warn', 'VS Code did not list link targets', error);
    return null;
  }
  if (context.aborted || items.length === 0) return null;
  const options: Completion[] = items.map((item) => ({
    label: item.label,
    detail: item.detail,
    apply: (view: EditorView, completion: Completion, f: number, t: number) => {
      const change = completionChange(view.state.doc, item.target, f, t);
      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: { anchor: change.cursor },
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(completion),
        scrollIntoView: true,
      });
    },
  }));
  return { from, options, filter: false };
}

export const wikilinkCompletion: Feature = {
  id: 'wikilinkCompletion',
  extension: () => [
    autocompletion({
      override: [wikilinkSource, vscodeSuggestions, insertMenuSource],
      activateOnTyping: true,
      icons: false,
      maxRenderedOptions: MAX_ITEMS,
      tooltipClass: () => 'tm-complete',
    }),
    EditorView.baseTheme({
      '& .cm-tooltip.cm-tooltip-autocomplete.tm-complete': {
        background: 'var(--vscode-editorSuggestWidget-background, var(--tm-widget-bg))',
        color: 'var(--vscode-editorSuggestWidget-foreground, var(--tm-widget-fg))',
        border: '1px solid var(--vscode-editorSuggestWidget-border, var(--tm-border))',
        borderRadius: '3px',
        fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
        fontSize: '13px',
      },
      '& .cm-tooltip.cm-tooltip-autocomplete.tm-complete > ul > li': { padding: '2px 8px' },
      '& .cm-tooltip.cm-tooltip-autocomplete.tm-complete > ul > li[aria-selected]': {
        background: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--tm-selection))',
        color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)',
      },
      '& .tm-complete .cm-completionDetail': { marginLeft: '12px', color: 'var(--tm-faded)', fontStyle: 'normal' },
    }),
  ],
};
