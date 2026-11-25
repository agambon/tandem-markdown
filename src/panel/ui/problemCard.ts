// The problem card: pointing at an underlined problem (render/diagnostics.ts) for HOVER_MS
// shows its message, the tool that reported it and its code, and the quick fixes VS Code
// offers for its range; the panel command `quickFix` (Ctrl+., Cmd+. on a Mac) opens the same
// card at the cursor with the focus on its first fix, the arrow keys moving between fixes and
// Escape closing it; given `{ apply: 'first' }` it applies the first fix with no card. A fix is
// applied by VS Code (`applyCodeAction`), and its change comes back as any other change does.
// A fix VS Code refuses from a list that is out of date opens the quick fixes again, with the
// ones offered now. No fixes are offered for a read-only document.

import { ChangeSet, Prec, StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, repositionTooltips, showTooltip, type Tooltip } from '@codemirror/view';
import { diffChanges } from '../../core/diff';
import { errorMessage } from '../../core/errors';
import type { DiagnosticItem, FixItem } from '../../core/featureProtocol';
import { stampOf } from '../../core/hash';
import { panelContext } from '../context';
import type { Feature } from '../features';
import { getMode } from '../modes';
import { diagnosticsAt } from '../render/diagnostics';
import { resyncPending } from '../sync';
import { cardOver, hoverPlace, HOVER_MS } from './linkCard';

/** The most problems one card lists. */
const MAX_SHOWN = 4;
/** How long the card waits for the fixes. */
const FIXES_WAIT_MS = 5000;

const NO_FIXES = 'No quick fixes here.';
const SEVERITY_NAMES = { error: 'Error', warning: 'Warning', information: 'Info', hint: 'Hint' } as const;

interface Span {
  from: number;
  to: number;
}

/** The range the fixes are asked for: every problem at the place, or the selection when there is none. */
function rangeOf(problems: readonly DiagnosticItem[], fallback: Span): Span {
  if (problems.length === 0) return fallback;
  return {
    from: Math.min(...problems.map((p) => p.from)),
    to: Math.max(...problems.map((p) => p.to)),
  };
}

function readFixes(value: unknown): FixItem[] | null {
  const v = value as { fixes?: unknown } | null;
  if (!v || !Array.isArray(v.fixes)) return null;
  const out: FixItem[] = [];
  for (const f of v.fixes) {
    const fix = f as Partial<FixItem> | null;
    if (fix && typeof fix.id === 'string' && typeof fix.title === 'string')
      out.push({ id: fix.id, title: fix.title, preferred: fix.preferred === true });
  }
  return out.sort((a, b) => Number(b.preferred) - Number(a.preferred));
}

/** Fixes may be offered: the document can be edited and the view is not waiting to be rebuilt. */
function fixable(state: EditorState): boolean {
  const ctx = state.facet(panelContext);
  return !!ctx && !ctx.doc.readOnly && !resyncPending(state);
}

/**
 * A list of fixes as the panel asked for it. The host keeps only a view's latest, and lets it go
 * once a fix from it is applied.
 */
interface Listed {
  /** Counts the view's lists. */
  id: number;
  /** The text the list was made for. */
  doc: Text;
  range: Span;
}

/** Each view's latest list, and whether a fix from it has been sent to be applied. */
const latestLists = new WeakMap<EditorView, { id: number; used: boolean }>();
let listCount = 0;

/** The list no longer stands: a newer one was made, a fix from it was applied, or the text changed. */
function outOfDate(view: EditorView, listed: Listed): boolean {
  const latest = latestLists.get(view);
  return view.state.doc !== listed.doc || latest?.id !== listed.id || latest.used;
}

/**
 * Has VS Code apply the fix `id` from `listed`; says so when it could not. A refusal of a fix
 * from a list that no longer stands opens the quick fixes again where they were asked for.
 */
async function applyFix(view: EditorView, id: string, listed: Listed): Promise<void> {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return;
  const staleBefore = outOfDate(view, listed);
  const latest = latestLists.get(view);
  if (latest?.id === listed.id) latest.used = true;
  try {
    const answer = (await ctx.request({ type: 'applyCodeAction', id })) as { refused?: unknown } | null;
    if (!answer || typeof answer.refused !== 'string') return;
    ctx.notify({ kind: 'info', text: answer.refused });
    if (staleBefore || view.state.doc !== listed.doc) reopenFixes(view, listed);
  } catch (error) {
    ctx.log('warn', 'A quick fix failed', error);
    ctx.notify({ kind: 'warning', text: `Could not apply the quick fix: ${errorMessage(error)}` });
  }
}

/** Opens the card of quick fixes again at the place `listed` was made for, carried over the changes since. */
function reopenFixes(view: EditorView, listed: Listed): void {
  if (!fixable(view.state) || getMode(view.state) !== 'edit') return;
  const now = view.state.doc;
  const changes = ChangeSet.of(diffChanges(listed.doc.toString(), now.toString()), listed.doc.length);
  const pos = Math.min(changes.mapPos(listed.range.from), now.length);
  const problems = diagnosticsAt(view.state, pos);
  view.dispatch({ effects: openMenu.of({ pos, problems, range: rangeOf(problems, { from: pos, to: pos }) }) });
}

interface CardOptions {
  /** The card was opened from the keyboard: focus goes to its first fix, and it says when there is none. */
  menu: boolean;
  /** Called when a fix was chosen or the card is to close. */
  close?(): void;
}

function buildCard(view: EditorView, problems: readonly DiagnosticItem[], range: Span, o: CardOptions): HTMLElement {
  const doc = view.dom.ownerDocument;
  const card = doc.createElement('div');
  card.className = 'tm-problem-card';
  for (const p of problems.slice(0, MAX_SHOWN)) {
    const row = doc.createElement('div');
    row.className = `tm-problem-card-row tm-problem-card-${p.severity}`;
    const message = doc.createElement('div');
    message.className = 'tm-problem-card-message';
    message.textContent = p.message;
    row.appendChild(message);
    const label = [p.source, p.code ? `(${p.code})` : ''].filter(Boolean).join(' ');
    const about = doc.createElement('div');
    about.className = 'tm-problem-card-source';
    about.textContent = label ? `${SEVERITY_NAMES[p.severity]}: ${label}` : SEVERITY_NAMES[p.severity];
    row.appendChild(about);
    card.appendChild(row);
  }
  if (problems.length > MAX_SHOWN) {
    const more = doc.createElement('div');
    more.className = 'tm-problem-card-source';
    more.textContent = `and ${problems.length - MAX_SHOWN} more`;
    card.appendChild(more);
  }
  const fixes = doc.createElement('div');
  fixes.className = 'tm-problem-card-fixes';
  fixes.setAttribute('role', 'group');
  fixes.setAttribute('aria-label', 'Quick fixes');
  card.appendChild(fixes);
  const say = (text: string) => {
    const line = doc.createElement('div');
    line.className = 'tm-problem-card-source';
    line.textContent = text;
    fixes.replaceChildren(line);
    repositionTooltips(view);
  };
  if (!fixable(view.state)) {
    if (o.menu) say(NO_FIXES);
    return card;
  }
  void listFixes(view, range).then((answer) => {
    if (!card.isConnected) return;
    const list = answer?.fixes;
    if (!answer || !list || list.length === 0) {
      if (o.menu) say(NO_FIXES);
      return;
    }
    const buttons = list.map((fix) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'tm-problem-card-fix';
      button.textContent = fix.title;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        o.close?.();
        void applyFix(view, fix.id, answer.listed);
      });
      return button;
    });
    fixes.replaceChildren(...buttons);
    repositionTooltips(view);
    if (o.menu) buttons[0]!.focus();
  });
  if (o.menu) {
    card.addEventListener('keydown', (event) => {
      const buttons = [...fixes.querySelectorAll('button')];
      const at = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        o.close?.();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && buttons.length > 0) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]!.focus();
      }
    });
  }
  return card;
}

/**
 * The fixes VS Code offers for `range`, with the list they came in; null when it gave none or the
 * text moved on meanwhile.
 */
async function listFixes(view: EditorView, range: Span): Promise<{ fixes: FixItem[] | null; listed: Listed } | null> {
  const ctx = view.state.facet(panelContext);
  if (!ctx) return null;
  const asked = view.state.doc;
  const listed: Listed = { id: ++listCount, doc: asked, range };
  latestLists.set(view, { id: listed.id, used: false });
  try {
    const answer = await ctx.request(
      { type: 'codeActions', from: range.from, to: range.to, expect: stampOf(asked) },
      { timeoutMs: FIXES_WAIT_MS },
    );
    return view.state.doc === asked ? { fixes: readFixes(answer), listed } : null;
  } catch (error) {
    ctx.log('warn', 'VS Code did not list the quick fixes', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The card from the keyboard

interface Menu {
  pos: number;
  problems: readonly DiagnosticItem[];
  range: Span;
}

const openMenu = StateEffect.define<Menu | null>();

const menuField = StateField.define<Menu | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(openMenu)) return e.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
  provide: (field) =>
    showTooltip.from(field, (menu): Tooltip | null => {
      if (!menu) return null;
      return {
        pos: menu.pos,
        above: false,
        create: (view) => {
          const close = () => {
            view.dispatch({ effects: openMenu.of(null) });
            view.focus();
          };
          const dom = buildCard(view, menu.problems, menu.range, { menu: true, close });
          dom.classList.add('tm-problem-menu');
          // Focus leaving the card closes it, once the event is over: the card may be going away in an update.
          dom.addEventListener('focusout', () =>
            setTimeout(() => {
              if (view.state.field(menuField, false) === menu && !dom.contains(dom.ownerDocument.activeElement))
                view.dispatch({ effects: openMenu.of(null) });
            }, 0),
          );
          return { dom };
        },
      };
    }),
});

/**
 * Quick Fix: the card for the problems at the cursor, from the keyboard. With
 * `args: { apply: 'first' }`, as VS Code's own Quick Fix takes, the first fix offered (a
 * preferred one when there is one) is applied at once, with no card.
 */
function quickFix(view: EditorView, args?: unknown): boolean {
  if (getMode(view.state) !== 'edit') return false;
  const main = view.state.selection.main;
  const problems = diagnosticsAt(view.state, main.head);
  const range = rangeOf(problems, { from: main.from, to: main.to });
  if ((args as { apply?: unknown } | undefined)?.apply === 'first') {
    if (!fixable(view.state)) return false;
    void listFixes(view, range).then((answer) => {
      const first = answer?.fixes?.[0];
      if (answer && first) void applyFix(view, first.id, answer.listed);
      else view.state.facet(panelContext)?.notify({ kind: 'info', text: NO_FIXES });
    });
    return true;
  }
  view.dispatch({ effects: openMenu.of({ pos: main.head, problems, range }) });
  return true;
}

function hoverSource(view: EditorView, pos: number): Tooltip | null {
  // Over a table's cell, the problem under the pointer, in the text the cell draws.
  const place = hoverPlace(view);
  const at = place?.pos ?? pos;
  const problems = diagnosticsAt(view.state, at);
  if (problems.length === 0) return null;
  const range = rangeOf(problems, { from: at, to: at });
  return cardOver(view, place, range, (v) => buildCard(v, problems, range, { menu: false }));
}

/** Escape in the editor closes the card opened from the keyboard while the focus has not moved into it. */
const closeKey = keymap.of([
  {
    key: 'Escape',
    run: (view) => {
      if (!view.state.field(menuField, false)) return false;
      view.dispatch({ effects: openMenu.of(null) });
      return true;
    },
  },
]);

export const problemCard: Feature = {
  id: 'problemCard',
  extension: () => [
    hoverTooltip(hoverSource, { hoverTime: HOVER_MS, hideOnChange: true }),
    menuField,
    Prec.high(closeKey),
    EditorView.baseTheme({
      '& .cm-tooltip:has(.tm-problem-card)': {
        background: 'var(--tm-widget-bg)',
        color: 'var(--tm-widget-fg)',
        border: '1px solid var(--tm-border)',
        borderRadius: '3px',
        boxShadow: '0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25))',
      },
      '& .tm-problem-card': {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        maxWidth: '480px',
        padding: '6px 8px',
        fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
        fontSize: '12px',
        lineHeight: '1.4',
      },
      '& .tm-problem-card-row': { paddingLeft: '8px', borderLeft: '3px solid var(--tm-border)' },
      '& .tm-problem-card-error': { borderLeftColor: 'var(--vscode-editorError-foreground, #f14c4c)' },
      '& .tm-problem-card-warning': { borderLeftColor: 'var(--vscode-editorWarning-foreground, #cca700)' },
      '& .tm-problem-card-information': { borderLeftColor: 'var(--vscode-editorInfo-foreground, #3794ff)' },
      '& .tm-problem-card-message': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      '& .tm-problem-card-source': { color: 'var(--tm-faded)' },
      '& .tm-problem-card-fixes': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' },
      '& .tm-problem-card-fixes:empty': { display: 'none' },
      '& .tm-problem-card-fix': {
        padding: '2px 8px',
        border: 'none',
        borderRadius: '2px',
        background: 'var(--tm-button2-bg)',
        color: 'var(--tm-button2-fg)',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      '& .tm-problem-card-fix:hover': { background: 'var(--tm-button2-hover-bg)' },
      '& .tm-problem-card-fix:focus-visible': { outline: '1px solid var(--tm-focus)', outlineOffset: '1px' },
    }),
  ],
  commands: { quickFix },
};
