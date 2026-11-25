// A feature that throws is turned off for this panel, logged once, and one notice shown that
// offers to reload the tab. The framework reports a fault from its guard around every build
// and widget; editor.ts reports one from setting a feature up.

import { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { PanelContext } from '../context';

/** Dispatched after a fault so every channel of the faulted feature drops its decorations. */
export const featureFaultEffect = StateEffect.define<string>();

const faultRegistries = new WeakMap<object, Set<string>>();
const noContext = {};

function faultSet(ctx: PanelContext | undefined): Set<string> {
  const key = ctx ?? noContext;
  let set = faultRegistries.get(key);
  if (!set) faultRegistries.set(key, (set = new Set()));
  return set;
}

/** True when the feature has thrown in this panel and is switched off. */
export function isFeatureFaulted(ctx: PanelContext | undefined, feature: string): boolean {
  return faultSet(ctx).has(feature);
}

/**
 * The ids of the features switched off in this panel by a fault. The panel itself never asks: the
 * render lab (harness/lab.ts) and the parser sweep read it to tell which feature failed, and
 * nothing else holds the list.
 */
export function faultedFeatures(ctx: PanelContext | undefined): string[] {
  return [...faultSet(ctx)];
}

export const FAULT_NOTICE_TEXT = 'Part of this note could not be drawn, so it shows as plain markdown.';

/** Asks the host to build the tab again from your text. */
function reloadView(ctx: PanelContext): void {
  ctx.bridge.post({ type: 'reloadView' });
}

/** Records a fault. Safe to call from inside a state update: the dispatch it needs is deferred. */
export function reportFault(
  ctx: PanelContext | undefined,
  feature: string,
  where: string,
  error: unknown,
  view?: EditorView,
): void {
  const set = faultSet(ctx);
  if (set.has(feature)) return;
  set.add(feature);
  if (!ctx) {
    console.error(`Tandem Markdown: drawing feature "${feature}" failed in ${where} and was turned off`, error);
    return;
  }
  try {
    ctx.log('error', `Drawing feature "${feature}" failed in ${where} and was turned off for this view`, error);
  } catch (logError) {
    console.error('Tandem Markdown: could not log a drawing fault', logError, error);
  }
  try {
    ctx.notify({
      kind: 'warning',
      text: FAULT_NOTICE_TEXT,
      sticky: true,
      actions: [{ label: 'Reload tab', run: () => reloadView(ctx) }],
    });
  } catch (notifyError) {
    console.error('Tandem Markdown: could not show a notice', notifyError);
  }
  setTimeout(() => {
    const redraw = { effects: featureFaultEffect.of(feature) };
    if (view) view.dispatch(redraw);
    else ctx.dispatch(redraw);
  }, 0);
}
