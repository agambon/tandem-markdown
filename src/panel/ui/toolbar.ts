// The toolbar, drawn into `ctx.slots.toolbar`: the formatting buttons and the heading menu, in
// the order of `FORMATTING`, and at the right a back-to-code pill (Source), an eye/pencil toggle
// (Rich view / Rich editor; choosing one posts `{ type: 'switchView', to }`), and Find. A
// formatting button is shown pressed while the cursor is in that formatting. In Rich view, and on
// a read-only document, only the view controls and Find are shown. Commands run through
// `runCommand`, as the host's forwarded commands do.
//
// Buttons never take focus from the editor: `mousedown` is canceled and they act on `click`.
// The bar lives outside the editor element, so its styles go in through a global style module
// that the view mounts (with the page's content-policy nonce), not a scoped theme.

import { syntaxTree } from '@codemirror/language';
import { Prec, type EditorState } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { StyleModule } from 'style-mod';
import { RICH_VIEW_NAME } from '../../core/protocol';
import { headingLevelAt } from '../commands/blocks';
import { inlineFormatsAt } from '../commands/inline';
import { lineInfo, markerOf } from '../commands/lineInfo';
import { runCommand } from '../commands/registry';
import { panelContext, type PanelContext } from '../context';
import type { Feature } from '../features';
import { fieldHasFocus } from '../focus';
import { getMode } from '../modes';
import {
  BOLD,
  BULLET_LIST,
  CODE_BLOCK,
  IMAGE,
  INLINE_CODE,
  ITALIC,
  LINK,
  NUMBERED_LIST,
  QUOTE,
  RULE,
  STRIKETHROUGH,
  TABLE,
  TASK_LIST,
} from './actions';
import { icon as iconOf } from './dom';
import { COMMAND_KEYS, keyName, type KeyBinding } from './keys';

/** What the cursor sits in, for the pressed states. */
export interface Formats {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  codeBlock: boolean;
  heading: number;
}

/** The formatting at the main selection. */
export function formatsAt(state: EditorState): Formats {
  const tree = syntaxTree(state);
  const inline = inlineFormatsAt(state, tree);
  const head = state.selection.main.head;
  const info = lineInfo(state, tree, state.doc.lineAt(head));
  const marker = info.marker ?? (info.owner ? markerOf(state, tree, info.owner) : null);
  let codeBlock = false;
  for (let n: SyntaxNode | null = tree.resolveInner(head, 0); n; n = n.parent)
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') codeBlock = true;
  if (info.code && (info.code.name === 'FencedCode' || info.code.name === 'CodeBlock')) codeBlock = true;
  return {
    bold: inline.has('bold'),
    italic: inline.has('italic'),
    strikethrough: inline.has('strikethrough'),
    code: inline.has('code'),
    link: inline.has('link'),
    bullet: marker?.kind === 'bullet',
    ordered: marker?.kind === 'ordered',
    task: marker?.kind === 'task',
    quote: info.inQuote,
    codeBlock,
    heading: headingLevelAt(state, tree),
  };
}

interface ButtonSpec {
  label: string;
  icon: string;
  key?: KeyBinding;
  command: string;
  pressed?: (f: Formats) => boolean;
}

type Item = ButtonSpec | 'heading' | 'separator';

/** The character typed to open the insert menu, which the Insert button's tooltip names as a key. */
const INSERT_KEY: KeyBinding = { key: '/' };

const FORMATTING: Item[] = [
  { ...BOLD, key: COMMAND_KEYS.toggleBold, command: 'toggleBold', pressed: (f) => f.bold },
  {
    ...ITALIC,
    key: COMMAND_KEYS.toggleItalic,
    command: 'toggleItalic',
    pressed: (f) => f.italic,
  },
  {
    ...STRIKETHROUGH,
    key: COMMAND_KEYS.toggleStrikethrough,
    command: 'toggleStrikethrough',
    pressed: (f) => f.strikethrough,
  },
  { ...INLINE_CODE, command: 'toggleCode', pressed: (f) => f.code },
  { ...LINK, key: COMMAND_KEYS.insertLink, command: 'insertLink', pressed: (f) => f.link },
  'separator',
  'heading',
  'separator',
  { ...BULLET_LIST, command: 'toggleBulletList', pressed: (f) => f.bullet },
  { ...NUMBERED_LIST, command: 'toggleNumberedList', pressed: (f) => f.ordered },
  { ...TASK_LIST, command: 'toggleTaskList', pressed: (f) => f.task },
  { ...QUOTE, command: 'toggleQuote', pressed: (f) => f.quote },
  { ...CODE_BLOCK, command: 'insertCodeBlock', pressed: (f) => f.codeBlock },
  'separator',
  { ...TABLE, command: 'insertTable' },
  { ...IMAGE, command: 'insertImage' },
  { ...RULE, command: 'insertRule' },
  { label: 'Insert', icon: 'add', key: INSERT_KEY, command: 'openInsertMenu' },
];

const LEVELS = ['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];

const RICH_MODES: { to: 'view' | 'edit'; label: string; title: string; icon: string }[] = [
  { to: 'view', label: RICH_VIEW_NAME.view, title: `${RICH_VIEW_NAME.view} (read-only)`, icon: 'eye' },
  { to: 'edit', label: RICH_VIEW_NAME.edit, title: RICH_VIEW_NAME.edit, icon: 'edit' },
];

const styles = new StyleModule({
  '.tm-toolbar': { flex: 'none', position: 'relative', zIndex: '5' },
  // Above the editor's scroller, so the bar stays at the top while the page scrolls. On narrow
  // panes the formatting group wraps in the left column while the view/find lockup stays pinned
  // at the top right.
  '.tm-tb': {
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '4px 8px',
    background: 'var(--tm-bg)',
    color: 'var(--tm-fg)',
    borderBottom: '1px solid var(--tm-border)',
    fontFamily: 'var(--tm-ui-font)',
    fontSize: 'var(--tm-ui-font-size)',
  },
  '.tm-tb [hidden]': { display: 'none !important' },
  '.tm-tb-group': {
    display: 'flex',
    flex: '1 1 auto',
    minWidth: '0',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '2px',
  },
  '.tm-tb-actions': {
    display: 'flex',
    flex: '0 0 auto',
    flexWrap: 'nowrap',
    alignItems: 'center',
    gap: '4px',
    marginLeft: 'auto',
  },
  '.tm-tb-separator': {
    width: '1px',
    height: '18px',
    alignSelf: 'center',
    margin: '0 4px',
    background: 'var(--tm-border)',
  },
  '.tm-tb-button': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    minWidth: '26px',
    height: '26px',
    padding: '0 4px',
    boxSizing: 'border-box',
    border: '1px solid transparent',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.tm-tb-button:hover': { background: 'var(--vscode-toolbar-hoverBackground, var(--tm-button2-bg))' },
  '.tm-tb-button[aria-pressed="true"]': {
    background: 'var(--vscode-toolbar-activeBackground, var(--tm-button2-bg))',
    borderColor: 'var(--vscode-inputOption-activeBorder, var(--tm-focus))',
  },
  '.tm-tb-button:focus-visible': { outline: '1px solid var(--tm-focus)', outlineOffset: '-1px' },
  '.tm-tb-button:disabled, .tm-tb-button[aria-disabled="true"]': { opacity: '0.5', cursor: 'default' },
  '.tm-tb-button[aria-disabled="true"]:hover': { background: 'transparent' },
  '.tm-tb-heading': { position: 'relative', display: 'inline-flex' },
  '.tm-tb-heading .tm-tb-button': { padding: '0 4px 0 8px' },
  '.tm-tb-heading-label': { minWidth: '5.5em', textAlign: 'left' },
  '.tm-tb-menu': {
    position: 'absolute',
    top: '100%',
    left: '0',
    marginTop: '2px',
    minWidth: '150px',
    padding: '4px 0',
    background: 'var(--tm-widget-bg)',
    color: 'var(--tm-widget-fg)',
    border: '1px solid var(--tm-border)',
    borderRadius: '4px',
    boxShadow: '0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36))',
    zIndex: '10',
  },
  '.tm-tb-menu-item': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 12px 3px 6px',
    cursor: 'pointer',
  },
  '.tm-tb-menu-item:hover, .tm-tb-menu-item:focus': {
    background: 'var(--vscode-list-hoverBackground, var(--tm-button2-bg))',
    outline: 'none',
  },
  '.tm-tb-menu-item .codicon': { visibility: 'hidden' },
  '.tm-tb-menu-item[aria-checked="true"] .codicon': { visibility: 'visible' },
  '.tm-tb-source': {
    borderRadius: '999px',
    border: '1px solid var(--tm-border)',
    padding: '0 8px 0 6px',
    gap: '3px',
    marginRight: '2px',
  },
  '.tm-tb-source .codicon-arrow-left': { fontSize: '12px' },
  '.tm-tb-views': {
    display: 'inline-flex',
    border: '1px solid var(--tm-border)',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  '.tm-tb-views .tm-tb-button': { borderRadius: '0', padding: '0 7px', minWidth: '28px', border: 'none' },
  '.tm-tb-views .tm-tb-button[aria-pressed="true"]': {
    background: 'var(--tm-button-bg)',
    color: 'var(--tm-button-fg)',
  },
});

class Toolbar {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  /** The panel's root, which holds the toolbar, the notices and the editor. */
  private readonly panelRoot: HTMLElement;
  private readonly formatting: HTMLElement;
  /** The formatting buttons and the heading menu's button: off while a text field has focus. */
  private readonly formattingButtons: HTMLButtonElement[] = [];
  private readonly pressable: { button: HTMLButtonElement; pressed: (f: Formats) => boolean }[] = [];
  private readonly views = new Map<string, HTMLButtonElement>();
  private readonly headingButton: HTMLButtonElement;
  private readonly headingLabel: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly menuItems: HTMLElement[] = [];
  private level = -1;
  private fieldFocused = false;
  private readonly onOutside = (event: MouseEvent) => {
    if (!this.menu.hidden && !this.menu.parentElement!.contains(event.target as Node)) this.closeMenu(false);
  };
  private readonly onFocusChange = () => this.followFieldFocus();

  constructor(
    private readonly view: EditorView,
    private readonly ctx: PanelContext,
    slot: HTMLElement,
  ) {
    this.doc = slot.ownerDocument;
    const doc = this.doc;
    this.panelRoot = slot.parentElement ?? doc.body;
    this.root = doc.createElement('div');
    this.root.className = 'tm-tb';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Formatting');
    this.root.addEventListener('keydown', (event) => this.onKey(event));

    this.formatting = doc.createElement('div');
    this.formatting.className = 'tm-tb-group tm-tb-formatting';
    this.headingButton = doc.createElement('button');
    this.headingLabel = doc.createElement('span');
    this.menu = doc.createElement('div');
    for (const item of FORMATTING) {
      if (item === 'separator') {
        const separator = doc.createElement('span');
        separator.className = 'tm-tb-separator';
        separator.setAttribute('role', 'separator');
        this.formatting.appendChild(separator);
      } else if (item === 'heading') {
        this.formatting.appendChild(this.buildHeadingMenu());
      } else {
        const button = this.button(item.label, item.icon, item.key, () => runCommand(this.view, item.command), true);
        this.formattingButtons.push(button);
        if (item.pressed) {
          button.setAttribute('aria-pressed', 'false');
          this.pressable.push({ button, pressed: item.pressed });
        }
        this.formatting.appendChild(button);
      }
    }
    this.root.appendChild(this.formatting);

    const actions = doc.createElement('div');
    actions.className = 'tm-tb-actions';

    const sourceButton = this.button('Source', '', undefined, () => this.switchView('source'));
    sourceButton.classList.add('tm-tb-source');
    sourceButton.title = 'Back to Source';
    sourceButton.append(iconOf(doc, 'arrow-left'), iconOf(doc, 'code'));
    actions.appendChild(sourceButton);

    const views = doc.createElement('div');
    views.className = 'tm-tb-views';
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'View');
    for (const v of RICH_MODES) {
      const button = this.button(v.label, v.icon, undefined, () => this.switchView(v.to));
      button.title = v.title;
      button.setAttribute('aria-pressed', 'false');
      this.views.set(v.to, button);
      views.appendChild(button);
    }
    actions.appendChild(views);
    actions.appendChild(this.button('Find', 'search', COMMAND_KEYS.find, () => runCommand(this.view, 'find')));
    this.root.appendChild(actions);

    slot.appendChild(this.root);
    doc.addEventListener('mousedown', this.onOutside, true);
    doc.addEventListener('focusin', this.onFocusChange, true);
    doc.addEventListener('focusout', this.onFocusChange, true);
    doc.defaultView?.addEventListener('focus', this.onFocusChange);
    doc.defaultView?.addEventListener('blur', this.onFocusChange);
    this.formattingButtons.push(this.headingButton);
    this.refresh(view.state);
    this.followFieldFocus();
    this.focusable()[0]?.setAttribute('tabindex', '0');
  }

  /** A text field in the panel has focus (what boot.ts reports to the host as `field`). */
  private fieldHasFocus(): boolean {
    return fieldHasFocus(this.panelRoot, this.view.contentDOM);
  }

  /**
   * Shows the formatting buttons and the heading menu as off while a text field in the panel
   * (a table cell, the find box) has focus: they act on the editor's selection, which is
   * somewhere else then. They stay focusable (`aria-disabled`, not `disabled`), so a click on
   * one keeps its `mousedown` canceled and the field keeps focus.
   */
  private followFieldFocus(): void {
    const now = this.fieldHasFocus();
    if (now === this.fieldFocused) return;
    this.fieldFocused = now;
    for (const button of this.formattingButtons) {
      if (now) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    if (now) this.closeMenu(false);
  }

  private button(
    label: string,
    icon: string,
    key: KeyBinding | undefined,
    run: () => void,
    formatting = false,
  ): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'tm-tb-button';
    button.tabIndex = -1;
    button.setAttribute('aria-label', label);
    button.title = key ? `${label} (${keyName(key)})` : label;
    if (icon) button.appendChild(iconOf(this.doc, icon));
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      // It would act on the editor's selection, not in the field that has focus.
      if (formatting && this.fieldHasFocus()) return;
      this.closeMenu(false);
      const before = this.doc.activeElement;
      run();
      // A mouse click leaves the cursor in the editor; a key press keeps focus on the bar. A
      // command that moved focus itself (Find, into its field) keeps it.
      if (event.detail > 0 && this.doc.activeElement === before) this.view.focus();
    });
    return button;
  }

  private buildHeadingMenu(): HTMLElement {
    const doc = this.doc;
    const wrap = doc.createElement('span');
    wrap.className = 'tm-tb-heading';
    const button = this.headingButton;
    button.type = 'button';
    button.className = 'tm-tb-button';
    button.tabIndex = -1;
    button.title = `Heading (${keyName(COMMAND_KEYS.headingUp)} and ${keyName(COMMAND_KEYS.headingDown)})`;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    this.headingLabel.className = 'tm-tb-heading-label';
    button.append(this.headingLabel, iconOf(doc, 'chevron-down'));
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      if (this.fieldHasFocus()) return;
      if (this.menu.hidden) this.openMenu(event.detail === 0);
      else this.closeMenu(event.detail === 0);
    });
    const menu = this.menu;
    menu.className = 'tm-tb-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Heading');
    menu.hidden = true;
    LEVELS.forEach((label, level) => {
      const item = doc.createElement('div');
      item.className = 'tm-tb-menu-item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      item.tabIndex = -1;
      const checkMark = iconOf(doc, 'check');
      const text = doc.createElement('span');
      text.textContent = label;
      item.append(checkMark, text);
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', (event) => this.chooseLevel(level, event.detail === 0));
      menu.appendChild(item);
      this.menuItems.push(item);
    });
    menu.addEventListener('keydown', (event) => this.onMenuKey(event));
    wrap.append(button, menu);
    return wrap;
  }

  private openMenu(withKeyboard: boolean): void {
    this.menu.hidden = false;
    this.headingButton.setAttribute('aria-expanded', 'true');
    if (withKeyboard) this.menuItems[Math.max(0, this.level)]?.focus();
  }

  private closeMenu(focusButton: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.headingButton.setAttribute('aria-expanded', 'false');
    if (focusButton) this.headingButton.focus();
  }

  private chooseLevel(level: number, withKeyboard: boolean): void {
    this.closeMenu(withKeyboard);
    if (this.fieldHasFocus()) return;
    runCommand(this.view, 'setHeading', { level });
    if (!withKeyboard) this.view.focus();
  }

  private onMenuKey(event: KeyboardEvent): void {
    const at = this.menuItems.indexOf(event.target as HTMLElement);
    const move = (to: number) => this.menuItems[(to + this.menuItems.length) % this.menuItems.length]!.focus();
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(this.menuItems.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (at >= 0) this.chooseLevel(at, true);
        break;
      case 'Escape':
        this.closeMenu(true);
        break;
      case 'Tab':
        this.closeMenu(true);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** The buttons the keyboard can reach now, in order. */
  private focusable(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => !b.disabled && b.offsetParent !== null && !b.closest('[hidden]'),
    );
  }

  /** Moves keyboard focus onto the bar (Alt+F10). */
  focusBar(): boolean {
    const buttons = this.focusable();
    if (!buttons.length) return false;
    const current = buttons.find((b) => b.tabIndex === 0) ?? buttons[0]!;
    current.focus();
    return true;
  }

  /**
   * The bar is one stop for the keyboard: Alt+F10 in the editor moves focus to it, the arrow
   * keys (and Home, End) move between buttons, Escape returns to the editor. Every button has
   * an accessible name; its tooltip gives the name and the shortcut.
   */
  private onKey(event: KeyboardEvent): void {
    if (this.menu.contains(event.target as Node)) return;
    const buttons = this.focusable();
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    let next = -1;
    switch (event.key) {
      case 'ArrowRight':
        next = at + 1;
        break;
      case 'ArrowLeft':
        next = at - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
      case 'ArrowDown':
        if (event.target === this.headingButton) {
          this.openMenu(true);
          event.preventDefault();
        }
        return;
      case 'Escape':
        event.preventDefault();
        this.closeMenu(false);
        this.view.focus();
        return;
      default:
        return;
    }
    if (!buttons.length) return;
    event.preventDefault();
    const target = buttons[(next + buttons.length) % buttons.length]!;
    for (const b of buttons) b.tabIndex = b === target ? 0 : -1;
    target.focus();
  }

  private switchView(to: 'source' | 'view' | 'edit'): void {
    if (to !== 'source' && getMode(this.view.state) === to) return;
    this.ctx.bridge.post({ type: 'switchView', to });
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.selectionSet ||
      getMode(update.startState) !== getMode(update.state) ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) {
      this.refresh(update.state);
    }
  }

  private refresh(state: EditorState): void {
    const mode = getMode(state);
    const formatting = mode === 'edit' && !this.ctx.doc.readOnly;
    if (this.formatting.hidden === formatting) {
      this.formatting.hidden = !formatting;
      if (!formatting) this.closeMenu(false);
      this.repairTabStop();
    }
    for (const [to, button] of this.views) {
      button.setAttribute('aria-pressed', String(to === mode));
      button.disabled = to === 'edit' && this.ctx.doc.readOnly;
    }
    if (!formatting) return;
    const f = formatsAt(state);
    for (const { button, pressed } of this.pressable) {
      const value = String(pressed(f));
      if (button.getAttribute('aria-pressed') !== value) button.setAttribute('aria-pressed', value);
    }
    if (f.heading !== this.level) {
      this.level = f.heading;
      this.headingLabel.textContent = LEVELS[f.heading]!;
      this.headingButton.setAttribute('aria-label', `Heading: ${LEVELS[f.heading]}`);
      this.menuItems.forEach((item, level) => item.setAttribute('aria-checked', String(level === f.heading)));
    }
  }

  /** Keeps one reachable button as the bar's tab stop when buttons are hidden or shown. */
  private repairTabStop(): void {
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button')];
    const visible = buttons.filter((b) => !b.closest('[hidden]') && !b.disabled);
    if (visible.some((b) => b.tabIndex === 0)) return;
    for (const b of buttons) b.tabIndex = -1;
    if (visible[0]) visible[0].tabIndex = 0;
  }

  destroy(): void {
    this.doc.removeEventListener('mousedown', this.onOutside, true);
    this.doc.removeEventListener('focusin', this.onFocusChange, true);
    this.doc.removeEventListener('focusout', this.onFocusChange, true);
    this.doc.defaultView?.removeEventListener('focus', this.onFocusChange);
    this.doc.defaultView?.removeEventListener('blur', this.onFocusChange);
    this.root.remove();
  }
}

/** The bar for one view; none when the page has no toolbar slot (headless tests). */
class ToolbarHost {
  readonly bar: Toolbar | null;
  constructor(view: EditorView) {
    const ctx = view.state.facet(panelContext);
    const slot = ctx?.slots?.toolbar;
    this.bar = ctx && slot ? new Toolbar(view, ctx, slot) : null;
  }
  update(update: ViewUpdate): void {
    this.bar?.update(update);
  }
  destroy(): void {
    this.bar?.destroy();
  }
}

const toolbarPlugin = ViewPlugin.fromClass(ToolbarHost);

const toolbarKeys = Prec.high(
  keymap.of([
    {
      key: 'Alt-F10',
      run: (view) => view.plugin(toolbarPlugin)?.bar?.focusBar() ?? false,
    },
  ]),
);

export const toolbar: Feature = {
  id: 'toolbar',
  extension: () => [toolbarPlugin, toolbarKeys, EditorView.styleModule.of(styles)],
};
